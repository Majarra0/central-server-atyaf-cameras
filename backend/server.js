const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { Readable } = require('stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const db         = require('./db');

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
// Mounts BEFORE body-parser so that proxied requests are not consumed.
// Accessible at /proxy/:siteId/  →  site.frigateUrl
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

  const employeeId = (req.body.employee_id || '').trim();
  const branch     = (req.body.branch     || '').trim();

  if (!employeeId || !branch) {
    return res.status(400).json({ error: 'رقم الموظف والفرع مطلوبان' });
  }

  const safeEmp    = sanitize(employeeId);
  const safeBranch = sanitize(branch);
  const targetDir  = path.resolve(FACES, safeBranch, safeEmp);

  if (!targetDir.startsWith(FACES + path.sep)) {
    return res.status(400).json({ error: 'قيمة غير صالحة' });
  }

  // Enforce single-branch rule
  const row = db.prepare('SELECT branch FROM employees WHERE employee_id = ?').get(employeeId);
  if (row && row.branch !== branch) {
    return res.status(409).json({
      error: `هذا الموظف مسجل بالفعل في الفرع: ${row.branch}`
    });
  }

  // DB first so a file-write failure still preserves the branch assignment
  if (!row) {
    db.prepare('INSERT INTO employees (employee_id, branch) VALUES (?, ?)').run(employeeId, branch);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const filename = `${Date.now()}${ext}`;
  fs.writeFileSync(path.join(targetDir, filename), req.file.buffer);

  // Push to that site's Frigate face-recognition library (best-effort)
  const site = sites.find(s => s.branch === branch);
  if (site) {
    try {
      const fd = new FormData();
      fd.append(
        'file',
        new Blob([req.file.buffer], { type: req.file.mimetype }),
        filename
      );
      await fetch(`${site.frigateUrl}/api/faces/${encodeURIComponent(employeeId)}`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(8000)
      });
    } catch (e) {
      console.warn(`[warn] Could not push face to ${site.frigateUrl}: ${e.message}`);
    }
  }

  res.json({ success: true, message: 'تم رفع الصورة بنجاح' });
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

// Let http-proxy-middleware handle upgrade events for WebSocket
server.on('upgrade', (req, socket, head) => {
  // The proxy middleware registered above handles WS upgrades automatically
  // when ws:true is set; this listener prevents Node from closing the socket.
  const handled = sites.some(site => req.url.startsWith(`/proxy/${site.id}`));
  if (!handled) socket.destroy();
});
