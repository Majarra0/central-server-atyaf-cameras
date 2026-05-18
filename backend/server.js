try { require('dotenv').config(); } catch {}

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { Readable } = require('stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const db         = require('./db');

const FRAPPE_BASE       = (process.env.FRAPPE_BASE_URL || 'https://dr-atyaf.e2next.com').replace(/\/$/, '');
const FRAPPE_API_KEY    = process.env.FRAPPE_API_KEY    || '';
const FRAPPE_API_SECRET = process.env.FRAPPE_API_SECRET || '';

const app   = express();
const PORT  = 3000;
const FACES = path.join(__dirname, 'faces');

// ── Sites ─────────────────────────────────────────────────────────────────────
let sites = [];
try {
  sites = JSON.parse(fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf8'));
} catch {
  console.warn('[warn] sites.json missing or invalid — no sites loaded');
}

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Per-site transparent proxy (HTTP + WebSocket) ─────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitize(str) {
  const s = str.trim().replace(/[\/\\<>:"|?*\x00-\x1f]/g, '_');
  return /^\.+$/.test(s) ? '_' : s;
}

function findSite(id) { return sites.find(s => s.id === id); }

async function proxyFetch(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
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

  const employeeId   = (req.body.employee_id   || '').trim();
  const employeeName = (req.body.employee_name || '').trim();
  const branch       = (req.body.branch        || '').trim();
  let   company      = (req.body.company       || '').trim();

  if (!employeeId || !employeeName || !branch) {
    return res.status(400).json({ error: 'بيانات الموظف والفرع مطلوبة' });
  }

  const row = db.prepare('SELECT branch, company FROM employees WHERE employee_id = ?').get(employeeId);
  if (row?.company) company = row.company;

  if (!company) {
    return res.status(400).json({ error: 'الشركة مطلوبة — قم بمزامنة الموظفين أولاً' });
  }

  if (row && row.branch !== branch) {
    return res.status(409).json({
      error: `هذا الموظف مسجل بالفعل في الفرع: ${row.branch}`
    });
  }

  const safeCompany = sanitize(company);
  const safeBranch  = sanitize(branch);
  const safePerson  = sanitize(employeeName);  // display name = Frigate face label
  const targetDir   = path.resolve(FACES, safeCompany, safeBranch, safePerson);

  if (!targetDir.startsWith(FACES + path.sep)) {
    return res.status(400).json({ error: 'قيمة غير صالحة' });
  }

  if (!row) {
    db.prepare(
      'INSERT INTO employees (employee_id, employee_name, branch, company) VALUES (?, ?, ?, ?)'
    ).run(employeeId, employeeName, branch, company);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const filename = `${Date.now()}${ext}`;
  fs.writeFileSync(path.join(targetDir, filename), req.file.buffer);

  res.json({ success: true, message: 'تم رفع الصورة بنجاح' });
});

// ══════════════════════════════════════════════════════════════════════════════
// FACE SYNC API  (polled by each local site's face_sync.py)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/faces/manifest?branch=X
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

// GET /api/faces/file/:company/:branch/:person/:filename
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
    const r    = await proxyFetch(`${site.frigateUrl}/api/version`);
    const data = await r.json();
    res.json({ online: true, version: data.version });
  } catch {
    res.json({ online: false });
  }
});

// ── Camera snapshot (latest frame) ───────────────────────────────────────────
app.get('/api/sites/:siteId/snapshot/:camera', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).end();
  try {
    const r = await proxyFetch(
      `${site.frigateUrl}/api/${encodeURIComponent(req.params.camera)}/latest.jpg`
    );
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(503).end();
  }
});

// ── Events list ───────────────────────────────────────────────────────────────
app.get('/api/sites/:siteId/events', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'الموقع غير موجود' });
  try {
    const url = new URL(`${site.frigateUrl}/api/events`);
    Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));
    const r    = await proxyFetch(url.toString());
    const data = await r.json();
    res.json(data);
  } catch {
    res.status(503).json({ error: 'الموقع غير متاح' });
  }
});

// ── Event snapshot ────────────────────────────────────────────────────────────
app.get('/api/sites/:siteId/events/:eventId/snapshot', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).end();
  try {
    const r = await proxyFetch(
      `${site.frigateUrl}/api/events/${req.params.eventId}/snapshot.jpg`
    );
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'image/jpeg');
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(503).end();
  }
});

// ── Event clip (streamed, may be large) ──────────────────────────────────────
app.get('/api/sites/:siteId/events/:eventId/clip', async (req, res) => {
  const site = findSite(req.params.siteId);
  if (!site) return res.status(404).end();
  try {
    const r = await proxyFetch(
      `${site.frigateUrl}/api/events/${req.params.eventId}/clip.mp4`
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
// EMPLOYEES
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/employees', (_req, res) => {
  const rows = db.prepare(
    'SELECT employee_id, employee_name, branch, company FROM employees ORDER BY employee_name'
  ).all();
  res.json(rows);
});

app.get('/api/companies', (_req, res) => {
  const rows = db.prepare('SELECT name FROM companies ORDER BY name').all();
  res.json(rows.map(r => r.name));
});

app.post('/api/employees/sync', async (_req, res) => {
  if (!FRAPPE_API_KEY) {
    return res.status(503).json({ error: 'FRAPPE_API_KEY غير مضبوط في متغيرات البيئة' });
  }

  const authHeader = FRAPPE_API_SECRET
    ? `token ${FRAPPE_API_KEY}:${FRAPPE_API_SECRET}`
    : `Bearer ${FRAPPE_API_KEY}`;

  const url = new URL(`${FRAPPE_BASE}/api/resource/Employee`);
  url.searchParams.set('fields',           JSON.stringify(['name', 'employee_name', 'branch', 'company', 'status']));
  url.searchParams.set('limit_page_length', '500');
  url.searchParams.set('limit',             '500');

  let data;
  try {
    const r = await fetch(url.toString(), {
      headers: { Authorization: authHeader },
      signal:  AbortSignal.timeout(20000)
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: `Frappe: ${r.status}`, detail: text.slice(0, 500) });
    }
    data = await r.json();
  } catch (e) {
    return res.status(503).json({ error: `تعذّر الاتصال بـ Frappe: ${e.message}` });
  }

  const raw       = data.data || [];
  const employees = raw.filter(e => e.name && e.company);

  console.log(`[sync] Frappe returned ${raw.length} records, ${employees.length} have company set`);
  if (raw.length > 0) console.log('[sync] sample record:', JSON.stringify(raw[0]));

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO employees (employee_id, employee_name, branch, company)
    VALUES (?, ?, ?, ?)
  `);

  db.transaction(emps => {
    for (const e of emps) {
      upsert.run(e.name, e.employee_name || e.name, e.branch || '', e.company);
    }
  })(employees);

  // Fetch companies from the Company doctype directly so all companies appear
  // even if the API key can't see every employee
  let companyCount = 0;
  try {
    const compUrl = new URL(`${FRAPPE_BASE}/api/resource/Company`);
    compUrl.searchParams.set('fields',           JSON.stringify(['name']));
    compUrl.searchParams.set('limit_page_length', '100');
    compUrl.searchParams.set('limit',             '100');
    const cr = await fetch(compUrl.toString(), {
      headers: { Authorization: authHeader },
      signal:  AbortSignal.timeout(10000)
    });
    if (cr.ok) {
      const cd = await cr.json();
      const upsertCo = db.prepare('INSERT OR REPLACE INTO companies (name) VALUES (?)');
      db.transaction(cos => {
        for (const c of cos) { if (c.name) { upsertCo.run(c.name); companyCount++; } }
      })(cd.data || []);
      console.log(`[sync] companies fetched: ${companyCount}`);
    }
  } catch (e) {
    console.warn('[sync] Could not fetch companies:', e.message);
  }

  res.json({
    success:        true,
    frappe_total:   raw.length,
    saved:          employees.length,
    companies:      companyCount,
    sample:         raw.slice(0, 3).map(e => ({ name: e.name, company: e.company, branch: e.branch, status: e.status }))
  });
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

server.on('upgrade', (req, socket, head) => {
  const handled = sites.some(site => req.url.startsWith(`/proxy/${site.id}`));
  if (!handled) socket.destroy();
});
