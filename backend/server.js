try { require('dotenv').config(); } catch {}

const express      = require('express');
const cookieParser = require('cookie-parser');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { Readable } = require('stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const db           = require('./db');

const FRAPPE_BASE = (process.env.FRAPPE_BASE_URL || 'https://dr-atyaf.e2next.com').replace(/\/$/, '');

const app   = express();
const PORT  = parseInt(process.env.PORT, 10) || 3000;
const FACES = path.join(__dirname, 'faces');

// ── Sites ─────────────────────────────────────────────────────────────────────
let sites = [];
try {
  sites = JSON.parse(fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf8'));
} catch {
  console.warn('[warn] sites.json missing or invalid — no sites loaded');
}

// ══════════════════════════════════════════════════════════════════════════════
// PARSERS
// ══════════════════════════════════════════════════════════════════════════════
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ══════════════════════════════════════════════════════════════════════════════
// SESSIONS  (in-memory; lost on restart — acceptable for this dashboard)
// ══════════════════════════════════════════════════════════════════════════════
const SESSION_COOKIE = 'central_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;     // 12h
const sessions       = new Map();                // ourId -> { sid, user, fullName, expires }

function newSessionId()  { return crypto.randomBytes(24).toString('hex'); }

function getSession(req) {
  const id = req.cookies?.[SESSION_COOKIE];
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(id); return null; }
  return { id, ...s };
}

function setSessionCookie(res, id) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   SESSION_TTL_MS
  });
}

function clearSessionCookie(res) { res.clearCookie(SESSION_COOKIE); }

// Periodic prune
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
}, 60 * 1000).unref();

// ══════════════════════════════════════════════════════════════════════════════
// FRAPPE HELPERS  (use the logged-in user's sid for every call)
// ══════════════════════════════════════════════════════════════════════════════
function frappeFetch(sid, urlPath, init = {}, timeoutMs = 20000) {
  const url = `${FRAPPE_BASE}${urlPath}`;
  const headers = {
    'Cookie': `sid=${sid}`,
    ...(init.headers || {})
  };
  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function extractSid(setCookieHeaders) {
  if (!setCookieHeaders) return null;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const c of arr) {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// FRIGATE AUTH  (port 8971 — server-side API calls only, not the browser /proxy)
//
// Local sites should tunnel Frigate :8971 (authenticated) to the central remote
// port. face_sync keeps using http://frigate:5000 inside the Docker network.
// Set FRIGATE_USER + FRIGATE_PASSWORD on the central server (or per-site in
// sites.json) so snapshot/event API routes can authenticate; the /proxy iframe
// does NOT inject credentials so users still see Frigate's own login screen.
// ══════════════════════════════════════════════════════════════════════════════
const FRIGATE_GLOBAL_USER = process.env.FRIGATE_USER     || '';
const FRIGATE_GLOBAL_PASS = process.env.FRIGATE_PASSWORD || '';
const frigateTokens       = new Map(); // siteId -> { token, expires }

function getFrigateCredentials(site) {
  const user = site.frigateUser     || FRIGATE_GLOBAL_USER;
  const pass = site.frigatePassword || FRIGATE_GLOBAL_PASS;
  return user && pass ? { user, pass } : null;
}

function extractFrigateToken(setCookieHeaders, body) {
  if (body?.access_token) return body.access_token;
  if (body?.token)        return body.token;
  if (!setCookieHeaders)  return null;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const c of arr) {
    const m = /(?:^|;\s*)(?:frigate_token|token)=([^;]+)/i.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function getFrigateToken(site) {
  const creds = getFrigateCredentials(site);
  if (!creds) return null;

  const cached = frigateTokens.get(site.id);
  if (cached && cached.expires > Date.now()) return cached.token;

  const base = site.frigateUrl.replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ user: creds.user, password: creds.password }),
      signal:  AbortSignal.timeout(10000)
    });
    if (!r.ok) {
      console.warn(`[frigate] login failed for ${site.id}: HTTP ${r.status}`);
      return null;
    }

    let setCookies = [];
    if (typeof r.headers.getSetCookie === 'function') {
      setCookies = r.headers.getSetCookie();
    } else {
      const raw = r.headers.raw?.()?.['set-cookie'];
      setCookies = raw || [r.headers.get('set-cookie')].filter(Boolean);
    }

    const body  = await r.json().catch(() => ({}));
    const token = extractFrigateToken(setCookies, body);
    if (!token) {
      console.warn(`[frigate] no token in login response for ${site.id}`);
      return null;
    }

    frigateTokens.set(site.id, { token, expires: Date.now() + 11 * 60 * 60 * 1000 });
    return token;
  } catch (e) {
    console.warn(`[frigate] login error for ${site.id}:`, e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH GATE
//
// Public:
//   - Static frontend (handled by express.static below)
//   - POST /api/login        (issues session)
//   - POST /api/logout       (clears session)
//   - GET  /api/me           (used by frontend to check auth state)
//   - GET  /api/health
//   - GET  /api/faces/manifest, /api/faces/file/*  (polled by local site agents
//                                                   over the trusted frp tunnel)
//
// Everything else under /api/* and /proxy/* requires a logged-in session.
// ══════════════════════════════════════════════════════════════════════════════
function isPublicApiPath(p) {
  return (
    p === '/api/login'   ||
    p === '/api/logout'  ||
    p === '/api/me'      ||
    p === '/api/health'  ||
    p === '/api/faces/manifest' ||
    p.startsWith('/api/faces/file/')
  );
}

function authGate(req, res, next) {
  const p = req.path;

  const needsAuth =
    p.startsWith('/proxy/') ||
    (p.startsWith('/api/') && !isPublicApiPath(p));

  if (!needsAuth) return next();

  const s = getSession(req);
  if (!s) {
    if (p.startsWith('/api/')) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
    return res.status(401).send('يلزم تسجيل الدخول');
  }
  req.session = s;
  next();
}

app.use(authGate);

// Static frontend (login.html + index.html + assets)
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Per-site transparent proxy (HTTP + WebSocket) — auth-gated by authGate ──
sites.forEach(site => {
  app.use(
    `/proxy/${site.id}`,
    createProxyMiddleware({
      target: site.frigateUrl,
      changeOrigin: true,
      ws: true,
      pathRewrite: { [`^/proxy/${site.id}`]: '' },
      on: {
        error: (_err, _req, res) => {
          if (res && !res.headersSent) {
            res.status(502).send('الموقع غير متاح حالياً');
          }
        }
      }
    })
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// LOGIN / LOGOUT / ME
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  let r;
  try {
    const body = new URLSearchParams({ usr: username, pwd: password });
    r = await fetch(`${FRAPPE_BASE}/api/method/login`, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal:   AbortSignal.timeout(15000),
      redirect: 'manual'
    });
  } catch (e) {
    return res.status(503).json({ error: `تعذّر الاتصال بخادم Frappe: ${e.message}` });
  }

  if (!r.ok) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  let setCookies = [];
  if (typeof r.headers.getSetCookie === 'function') {
    setCookies = r.headers.getSetCookie();
  } else {
    const raw = r.headers.raw?.()?.['set-cookie'];
    setCookies = raw || r.headers.get('set-cookie') || [];
  }

  const sid = extractSid(setCookies);
  if (!sid || sid === 'Guest') {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  let info = {};
  try { info = await r.json(); } catch {}

  const fullName = info.full_name || info.message || username;

  const id = newSessionId();
  sessions.set(id, {
    sid,
    user:     username,
    fullName,
    expires:  Date.now() + SESSION_TTL_MS
  });
  setSessionCookie(res, id);

  res.json({ success: true, user: username, fullName });
});

app.post('/api/logout', (req, res) => {
  const s = getSession(req);
  if (s) sessions.delete(s.id);
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: s.user, fullName: s.fullName });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function sanitize(str) {
  const s = str.trim().replace(/[\/\\<>:"|?*\x00-\x1f]/g, '_');
  return /^\.+$/.test(s) ? '_' : s;
}

function findSite(id) { return sites.find(s => s.id === id); }

async function proxyFetch(url, init = {}, site = null) {
  const headers = { ...(init.headers || {}) };
  if (site) {
    const token = await getFrigateToken(site);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    return await fetch(url, { ...init, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(Object.assign(new Error('يُسمح برفع الصور فقط'), { code: 'INVALID_TYPE' }));
    }
    cb(null, true);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('picture'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم اختيار صورة' });

  const employeeId = (req.body.employee_id || '').trim();
  const branch     = (req.body.branch     || '').trim();
  let   company    = (req.body.company    || '').trim();

  if (!employeeId || !branch) {
    return res.status(400).json({ error: 'بيانات الموظف والفرع مطلوبة' });
  }

  const row = db.prepare('SELECT branch, company FROM employees WHERE employee_id = ?').get(employeeId);
  if (row?.company) company = row.company;

  if (!company) {
    return res.status(400).json({ error: 'الشركة مطلوبة — قم بمزامنة الموظفين أولاً' });
  }

  if (row && row.branch !== branch) {
    return res.status(409).json({
      error: `لا يمكن رفع صور لهذا الموظف في فرع آخر — مسجل في: ${row.branch}`
    });
  }

  const safeCompany = sanitize(company);
  const safeBranch  = sanitize(branch);
  const safeEmp     = sanitize(employeeId);
  const targetDir   = path.resolve(FACES, safeCompany, safeBranch, safeEmp);

  if (!targetDir.startsWith(FACES + path.sep)) {
    return res.status(400).json({ error: 'قيمة غير صالحة' });
  }

  if (!row) {
    db.prepare('INSERT INTO employees (employee_id, branch, company) VALUES (?, ?, ?)').run(employeeId, branch, company);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const filename = `${Date.now()}${ext}`;
  fs.writeFileSync(path.join(targetDir, filename), req.file.buffer);

  res.json({ success: true, message: 'تم رفع الصورة بنجاح' });
});

// ══════════════════════════════════════════════════════════════════════════════
// FACE SYNC API  (polled by local site face_sync.py — public, by design)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/faces/manifest', (req, res) => {
  const branch = (req.query.branch || '').trim();
  if (!branch) return res.status(400).json({ error: 'branch مطلوب' });

  const safeBranch = sanitize(branch);
  const items = [];

  if (!fs.existsSync(FACES)) return res.json([]);

  for (const company of fs.readdirSync(FACES)) {
    const branchDir = path.join(FACES, company, safeBranch);
    if (!fs.existsSync(branchDir) || !fs.statSync(branchDir).isDirectory()) continue;
    for (const person of fs.readdirSync(branchDir)) {
      const personDir = path.join(branchDir, person);
      if (!fs.statSync(personDir).isDirectory()) continue;
      for (const file of fs.readdirSync(personDir)) {
        items.push({ company, branch: safeBranch, person, file });
      }
    }
  }

  res.json(items);
});

app.get('/api/faces/file/:company/:branch/:person/:filename', (req, res) => {
  const { company, branch, person, filename } = req.params;
  const filePath = path.resolve(
    FACES,
    sanitize(company),
    sanitize(branch),
    sanitize(person),
    sanitize(filename)
  );
  if (!filePath.startsWith(FACES + path.sep)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// ══════════════════════════════════════════════════════════════════════════════
// SITES
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/sites', (_req, res) => {
  res.json(sites.map(({ id, branch, cameras, frigateUrl }) => ({
    id, branch, cameras, frigateUrl
  })));
});

app.get('/api/sites/:siteId/status', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'الموقع غير موجود' });
  try {
    const r    = await proxyFetch(`${site.frigateUrl}/api/version`, {}, site);
    const data = await r.json();
    res.json({ online: true, version: data.version });
  } catch {
    res.json({ online: false });
  }
});

app.get('/api/sites/:siteId/snapshot/:camera', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).end();
  try {
    const r = await proxyFetch(
      `${site.frigateUrl}/api/${encodeURIComponent(req.params.camera)}/latest.jpg`,
      {},
      site
    );
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(503).end();
  }
});

app.get('/api/sites/:siteId/events', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'الموقع غير موجود' });
  try {
    const url = new URL(`${site.frigateUrl}/api/events`);
    Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));
    const r    = await proxyFetch(url.toString(), {}, site);
    const data = await r.json();
    res.json(data);
  } catch {
    res.status(503).json({ error: 'الموقع غير متاح' });
  }
});

app.get('/api/sites/:siteId/events/:eventId/snapshot', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).end();
  try {
    const r = await proxyFetch(
      `${site.frigateUrl}/api/events/${req.params.eventId}/snapshot.jpg`,
      {},
      site
    );
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'image/jpeg');
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(503).end();
  }
});

app.get('/api/sites/:siteId/events/:eventId/clip', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).end();
  try {
    const r = await proxyFetch(
      `${site.frigateUrl}/api/events/${req.params.eventId}/clip.mp4`,
      {},
      site
    );
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', `attachment; filename="${req.params.eventId}.mp4"`);
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(503).end();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EMPLOYEES (Frappe-backed via session sid)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/employees', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      h.employee_id,
      h.employee_name,
      h.branch,
      h.company,
      e.branch AS registered_branch
    FROM hr_employees h
    LEFT JOIN employees e ON e.employee_id = h.employee_id
    ORDER BY h.employee_name
  `).all();
  res.json(rows);
});

app.get('/api/companies', (_req, res) => {
  const rows = db.prepare('SELECT name FROM companies ORDER BY name').all();
  res.json(rows.map(r => r.name));
});

app.post('/api/employees/sync', async (req, res) => {
  const sid = req.session?.sid;
  if (!sid) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });

  // — Employees —
  let empData;
  try {
    const empPath = `/api/resource/Employee?fields=${
      encodeURIComponent(JSON.stringify(['name', 'employee_name', 'branch', 'company']))
    }&limit_page_length=0&limit=0`;
    const r = await frappeFetch(sid, empPath);
    if (r.status === 401 || r.status === 403) {
      return res.status(401).json({ error: 'انتهت الجلسة — يرجى تسجيل الدخول مرة أخرى' });
    }
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: `Frappe: ${r.status}`, detail: text.slice(0, 500) });
    }
    empData = await r.json();
  } catch (e) {
    return res.status(503).json({ error: `تعذّر الاتصال بـ Frappe: ${e.message}` });
  }

  const raw       = empData.data || [];
  const employees = raw.filter(e => e.name && e.company);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO hr_employees (employee_id, employee_name, branch, company)
    VALUES (?, ?, ?, ?)
  `);

  db.transaction(emps => {
    db.prepare('DELETE FROM hr_employees').run();
    for (const e of emps) {
      upsert.run(e.name, e.employee_name || e.name, e.branch || '', e.company);
    }
  })(employees);

  // — Companies —
  let companyCount = 0;
  try {
    const compPath = `/api/resource/Company?fields=${
      encodeURIComponent(JSON.stringify(['name']))
    }&limit_page_length=0&limit=0`;
    const cr = await frappeFetch(sid, compPath, {}, 10000);
    if (cr.ok) {
      const cd = await cr.json();
      const upsertCo = db.prepare('INSERT OR REPLACE INTO companies (name) VALUES (?)');
      db.transaction(cos => {
        db.prepare('DELETE FROM companies').run();
        for (const c of cos) { if (c.name) { upsertCo.run(c.name); companyCount++; } }
      })(cd.data || []);
    }
  } catch (e) {
    console.warn('[sync] Could not fetch companies:', e.message);
  }

  res.json({ success: true, saved: employees.length, companies: companyCount });
});

// ══════════════════════════════════════════════════════════════════════════════
// SAVED FACES MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════
function listFacePhotos(company, branch, employeeId) {
  const dir = path.resolve(FACES, sanitize(company), sanitize(branch), sanitize(employeeId));
  if (!dir.startsWith(FACES + path.sep) || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function removeEmptyFaceDirs(company, branch) {
  try {
    const branchDir  = path.join(FACES, sanitize(company), sanitize(branch));
    const companyDir = path.join(FACES, sanitize(company));
    if (fs.existsSync(branchDir)  && fs.readdirSync(branchDir).length  === 0) fs.rmdirSync(branchDir);
    if (fs.existsSync(companyDir) && fs.readdirSync(companyDir).length === 0) fs.rmdirSync(companyDir);
  } catch {}
}

function removeEmployeeFaceRecord(company, branch, employeeId) {
  db.prepare('DELETE FROM employees WHERE employee_id = ?').run(employeeId);
  const dir = path.resolve(FACES, sanitize(company), sanitize(branch), sanitize(employeeId));
  if (dir.startsWith(FACES + path.sep) && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  removeEmptyFaceDirs(company, branch);
}

app.get('/api/saved-faces', (_req, res) => {
  const rows = db.prepare(`
    SELECT e.employee_id, h.employee_name, e.branch, e.company
    FROM employees e
    LEFT JOIN hr_employees h ON e.employee_id = h.employee_id
    ORDER BY e.company, e.branch, e.employee_id
  `).all();

  const result = rows.map(row => {
    const photos = listFacePhotos(row.company, row.branch, row.employee_id);
    return {
      ...row,
      photos,
      photoCount: photos.length,
      firstPhoto: photos[0] || null
    };
  });

  res.json(result);
});

// DELETE one image — if it was the last image, drops the employee upload record too
app.delete('/api/saved-faces/:employeeId/photos/:filename', (req, res) => {
  const row = db.prepare('SELECT branch, company FROM employees WHERE employee_id = ?').get(req.params.employeeId);
  if (!row) return res.status(404).json({ error: 'الموظف غير موجود' });

  const filePath = path.resolve(
    FACES,
    sanitize(row.company),
    sanitize(row.branch),
    sanitize(req.params.employeeId),
    sanitize(req.params.filename)
  );
  if (!filePath.startsWith(FACES + path.sep)) {
    return res.status(400).json({ error: 'قيمة غير صالحة' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'الصورة غير موجودة' });
  }

  fs.unlinkSync(filePath);

  const remaining = listFacePhotos(row.company, row.branch, req.params.employeeId);
  let employeeRemoved = false;
  if (remaining.length === 0) {
    removeEmployeeFaceRecord(row.company, row.branch, req.params.employeeId);
    employeeRemoved = true;
  }

  res.json({
    success:         true,
    remaining:       remaining.length,
    employeeRemoved,
    photos:          remaining
  });
});

// DELETE employee and all images
app.delete('/api/saved-faces/:employeeId', (req, res) => {
  const row = db.prepare('SELECT branch, company FROM employees WHERE employee_id = ?').get(req.params.employeeId);
  if (!row) return res.status(404).json({ error: 'الموظف غير موجود' });

  removeEmployeeFaceRecord(row.company, row.branch, req.params.employeeId);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN RESET
// ══════════════════════════════════════════════════════════════════════════════
app.delete('/api/admin/reset', (req, res) => {
  if (req.query.password !== 'frappe01') {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM employees').run();
    db.prepare('DELETE FROM hr_employees').run();
    db.prepare('DELETE FROM companies').run();
  })();

  let filesDeleted = 0;
  if (fs.existsSync(FACES)) {
    fs.readdirSync(FACES).forEach(entry => {
      const full = path.join(FACES, entry);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        filesDeleted++;
      } catch (e) {
        console.warn('[reset] failed to remove', full, e.message);
      }
    });
  }

  res.json({ success: true, filesDeleted });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'حجم الصورة يتجاوز الحد المسموح به (10 MB)' });
  }
  if (err.code === 'INVALID_TYPE') {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ في الخادم' });
});

const server = app.listen(PORT, () => console.log(`http://localhost:${PORT}`));

// WebSocket upgrade auth: require session for /proxy/*
server.on('upgrade', (req, socket, head) => {
  const handled = sites.some(site => req.url.startsWith(`/proxy/${site.id}`));
  if (!handled) return socket.destroy();

  // Parse cookies manually for upgrade requests
  const raw = req.headers.cookie || '';
  const match = raw.split(/;\s*/).map(c => c.split('=')).find(([k]) => k === SESSION_COOKIE);
  const id = match?.[1];
  const s  = id && sessions.get(id);
  if (!s || s.expires < Date.now()) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});
