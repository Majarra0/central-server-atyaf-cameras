// ── State ─────────────────────────────────────────────────────────────────────
let sites      = [];
let employees  = [];
let companies  = [];
let snapTimers = {};
let activeTab  = 'upload';

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  // Restore from cache immediately so UI is usable before network responds
  loadCache();
  initUploadTab();
  initEventsTab();
  initFacesTab();
  bindTabs();
  bindModals();
  startClock();

  // Restore last active tab (skip 'live' since that tab is hidden)
  const savedTab = localStorage.getItem('activeTab');
  switchTab(savedTab && savedTab !== 'live' ? savedTab : 'upload');

  // Fetch fresh data in background, update UI when done
  await Promise.all([loadSites(), loadEmployees(), loadCompanies()]);
  saveCache();
  refreshUploadDropdowns();
  initEventsTab();          // re-populate site dropdown with fresh sites
})();

// ── Clock ─────────────────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('ar-SA', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

// ── Cache ─────────────────────────────────────────────────────────────────────
function loadCache() {
  try { sites     = JSON.parse(localStorage.getItem('cache_sites'))     || []; } catch { sites = []; }
  try { employees = JSON.parse(localStorage.getItem('cache_employees')) || []; } catch { employees = []; }
  try { companies = JSON.parse(localStorage.getItem('cache_companies')) || []; } catch { companies = []; }
}

function saveCache() {
  try { localStorage.setItem('cache_sites',     JSON.stringify(sites));     } catch {}
  try { localStorage.setItem('cache_employees', JSON.stringify(employees)); } catch {}
  try { localStorage.setItem('cache_companies', JSON.stringify(companies)); } catch {}
}

// ── Sites ─────────────────────────────────────────────────────────────────────
async function loadSites() {
  try {
    const r = await fetch('/api/sites');
    sites = await r.json();
  } catch {}
}

// ── Employees ─────────────────────────────────────────────────────────────────
async function loadEmployees() {
  try {
    const r = await fetch('/api/employees');
    employees = await r.json();
  } catch {}
}

async function loadCompanies() {
  try {
    const r = await fetch('/api/companies');
    companies = await r.json();
  } catch {}
}

function refreshUploadDropdowns() {
  const company = document.getElementById('company')?.value || '';
  const branch  = document.getElementById('branch')?.value  || '';
  populateCompanyDropdown();
  if (company) {
    document.getElementById('company').value = company;
    populateBranchDropdown(company);
    if (branch) {
      document.getElementById('branch').value = branch;
      populateEmployeeDropdown(company, branch);
    }
  }
}

function populateCompanyDropdown() {
  const sel = document.getElementById('company');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled>اختر الشركة...</option>';
  const seen = new Set();
  // Company doctype first (authoritative, all companies even with no employees)
  companies.forEach(c => {
    if (c && !seen.has(c)) {
      seen.add(c);
      const opt = document.createElement('option');
      opt.value = opt.textContent = c;
      sel.appendChild(opt);
    }
  });
  // Employees as fallback (in case companies weren't synced yet)
  employees.forEach(e => {
    if (e.company && !seen.has(e.company)) {
      seen.add(e.company);
      const opt = document.createElement('option');
      opt.value = opt.textContent = e.company;
      sel.appendChild(opt);
    }
  });
  if (current && seen.has(current)) sel.value = current;
}

function populateBranchDropdown(company) {
  const sel = document.getElementById('branch');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled>اختر الفرع...</option>';
  const seen = new Set();
  employees
    .filter(e => !company || e.company === company)
    .forEach(e => {
      if (e.branch && !seen.has(e.branch)) {
        seen.add(e.branch);
        const opt = document.createElement('option');
        opt.value = opt.textContent = e.branch;
        sel.appendChild(opt);
      }
    });
  if (current && seen.has(current)) sel.value = current;
}

function populateEmployeeDropdown(company, branch) {
  const sel = document.getElementById('employeeSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="" disabled>اختر الموظف...</option>';
  employees
    .filter(e => (!company || e.company === company) && (!branch || e.branch === branch))
    .sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || '', 'ar'))
    .forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.employee_id;
      opt.textContent = e.employee_name
        ? `${e.employee_name} (${e.employee_id})`
        : e.employee_id;
      sel.appendChild(opt);
    });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  activeTab = name;
  localStorage.setItem('activeTab', name);

  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('hidden', p.id !== `tab-${name}`)
  );

  if (name === 'live') {
    renderLiveGrid();
  } else {
    stopAllSnapshots();
  }
  if (name === 'faces') loadFacesList();
}

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD TAB
// ══════════════════════════════════════════════════════════════════════════════
function initUploadTab() {
  populateCompanyDropdown();

  document.getElementById('company').addEventListener('change', function () {
    populateBranchDropdown(this.value);
    populateEmployeeDropdown(this.value, '');
  });

  document.getElementById('branch').addEventListener('change', function () {
    const company = document.getElementById('company').value;
    populateEmployeeDropdown(company, this.value);
  });

  // No change listener needed — employee is read directly from select at submit time

  // Sync button
  const syncBtn = document.getElementById('syncEmployeesBtn');
  const syncMsg = document.getElementById('syncMsg');

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncMsg.textContent = 'جارٍ المزامنة...';
    syncMsg.style.color = 'var(--text-muted)';
    try {
      const r    = await fetch('/api/employees/sync', { method: 'POST' });
      const data = await r.json();
      if (r.ok) {
        syncMsg.textContent = `تمت المزامنة · ${data.saved ?? data.count} موظف · ${data.companies ?? 0} شركة`;
        syncMsg.style.color = '#22d3ee';
        await Promise.all([loadEmployees(), loadCompanies()]);
        saveCache();
        refreshUploadDropdowns();
      } else {
        syncMsg.textContent = data.error || 'فشلت المزامنة';
        syncMsg.style.color = '#f87171';
      }
    } catch {
      syncMsg.textContent = 'تعذّر الاتصال بالخادم';
      syncMsg.style.color = '#f87171';
    } finally {
      syncBtn.disabled = false;
    }
  });

  // Reset button
  document.getElementById('resetAllBtn').addEventListener('click', async () => {
    const password = prompt('أدخل كلمة المرور لتأكيد الحذف:');
    if (!password) return;
    const btn = document.getElementById('resetAllBtn');
    btn.disabled = true;
    const msg = document.getElementById('syncMsg');
    msg.textContent = 'جارٍ الحذف...';
    msg.style.color = 'var(--text-muted)';
    try {
      const r    = await fetch(`/api/admin/reset?password=${encodeURIComponent(password)}`, { method: 'DELETE' });
      const data = await r.json();
      if (r.ok) {
        msg.textContent = 'تم حذف جميع البيانات والملفات';
        msg.style.color = '#f87171';
        employees = [];
        companies = [];
        saveCache();
        refreshUploadDropdowns();
      } else {
        msg.textContent = data.error || 'فشل الحذف';
        msg.style.color = '#f87171';
      }
    } catch {
      msg.textContent = 'تعذّر الاتصال بالخادم';
      msg.style.color = '#f87171';
    } finally {
      btn.disabled = false;
    }
  });

  const fileInput = document.getElementById('picture');
  const fileName  = document.getElementById('fileName');
  const fileDrop  = document.getElementById('fileDrop');
  const preview   = document.getElementById('preview');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileName.textContent = file.name;
    fileDrop.classList.add('active');
    const reader = new FileReader();
    reader.onload = e => {
      preview.src = e.target.result;
      preview.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });

  const form      = document.getElementById('uploadForm');
  const submitBtn = document.getElementById('submitBtn');
  const msgEl     = document.getElementById('uploadMsg');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    hideMsg(msgEl);

    const company    = document.getElementById('company').value;
    const branch     = document.getElementById('branch').value;
    const empSelVal  = document.getElementById('employeeSelect').value;
    const empRecord  = employees.find(e => e.employee_id === empSelVal);
    const employeeId = empRecord?.employee_id || '';
    const file       = fileInput.files[0];

    if (!company)    return showMsg(msgEl, 'error', 'يرجى اختيار الشركة');
    if (!branch)     return showMsg(msgEl, 'error', 'يرجى اختيار الفرع');
    if (!employeeId) return showMsg(msgEl, 'error', 'يرجى اختيار الموظف من القائمة');
    if (!file)       return showMsg(msgEl, 'error', 'يرجى اختيار صورة');

    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           style="animation:spin .8s linear infinite">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"
              stroke-linecap="round"/>
      </svg>
      جارٍ الرفع...
    `;

    const fd = new FormData();
    fd.append('employee_id', employeeId);
    fd.append('branch',      branch);
    fd.append('company',     company);
    fd.append('picture',       file);

    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();

      if (res.ok) {
        showMsg(msgEl, 'success', data.message);
        document.getElementById('company').value        = '';
        document.getElementById('branch').value         = '';
        document.getElementById('employeeSelect').value = '';
        fileInput.value      = '';
        fileName.textContent = 'اسحب الصورة هنا أو اضغط للاختيار';
        fileDrop.classList.remove('active');
        preview.classList.add('hidden');
        preview.src = '';
        populateCompanyDropdown();
        populateBranchDropdown('');
        populateEmployeeDropdown('', '');
      } else {
        showMsg(msgEl, 'error', data.error || 'حدث خطأ غير متوقع');
      }
    } catch {
      showMsg(msgEl, 'error', 'تعذّر الاتصال بالخادم');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        رفع وتسجيل الصورة
      `;
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// LIVE TAB
// ══════════════════════════════════════════════════════════════════════════════
function renderLiveGrid() {
  stopAllSnapshots();
  const grid = document.getElementById('liveGrid');

  if (!sites.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 8v4M12 16h.01" stroke-linecap="round"/>
        </svg>
        <span>لا يوجد فروع مضافة — أضف الفروع في ملف sites.json</span>
      </div>`;
    return;
  }

  grid.innerHTML = '';

  sites.forEach(site => {
    const block = document.createElement('div');
    block.className = 'site-block';
    block.innerHTML = `
      <div class="site-header">
        <div class="site-header-left">
          <span class="site-dot" id="dot-${site.id}"></span>
          <span class="site-name">${esc(site.branch)}</span>
          <span class="badge loading" id="badge-${site.id}">فحص...</span>
        </div>
        <div class="site-header-right">
          <button class="action-btn" onclick="openSiteFrigate('${site.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            فتح فريجيت
          </button>
        </div>
      </div>
      <div class="cam-grid" id="cams-${site.id}"></div>
    `;
    grid.appendChild(block);

    checkStatus(site);
    site.cameras.forEach(cam => addCameraCell(site, cam));
  });

  document.getElementById('refreshStatusBtn').onclick = () => {
    sites.forEach(s => checkStatus(s));
  };
}

async function checkStatus(site) {
  const badge = document.getElementById(`badge-${site.id}`);
  const dot   = document.getElementById(`dot-${site.id}`);
  try {
    const r    = await fetch(`/api/sites/${site.id}/status`);
    const data = await r.json();
    if (data.online) {
      badge.className   = 'badge online';
      badge.textContent = data.version ? `v${data.version}` : 'متصل';
      if (dot) dot.className = 'site-dot online';
    } else {
      badge.className   = 'badge offline';
      badge.textContent = 'غير متصل';
      if (dot) dot.className = 'site-dot offline';
    }
  } catch {
    badge.className   = 'badge offline';
    badge.textContent = 'غير متصل';
    if (dot) dot.className = 'site-dot offline';
  }
}

function addCameraCell(site, cam) {
  const container = document.getElementById(`cams-${site.id}`);
  const cell = document.createElement('div');
  cell.className = 'cam-cell';
  cell.id = `cell-${site.id}-${cam}`;

  cell.innerHTML = `
    <img id="snap-${site.id}-${cam}" src="" alt="${esc(cam)}">
    <div class="cam-reticle"></div>
    <div class="cam-offline" style="display:none">
      <svg class="cam-offline-icon" width="32" height="32" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="1">
        <path d="M15 10l4.553-2.069A1 1 0 0121 8.951V15.05a1 1 0 01-1.447.89L15 14
                 M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z
                 M3 3l18 18" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>لا توجد إشارة</span>
    </div>
    <div class="cam-bar">
      <div style="display:flex;align-items:center;gap:.5rem">
        <div class="live-badge">
          <span class="live-badge-dot"></span>
          LIVE
        </div>
        <span class="cam-name">${esc(cam.toUpperCase())}</span>
      </div>
      <button class="stream-btn"
              onclick="openLiveStream('${site.id}','${cam}','${esc(site.branch)}')">
        بث مباشر
      </button>
    </div>
  `;
  container.appendChild(cell);

  const img     = cell.querySelector(`#snap-${site.id}-${cam}`);
  const offline = cell.querySelector('.cam-offline');

  img.onerror = () => {
    img.style.display     = 'none';
    offline.style.display = 'flex';
  };

  startSnapshot(site.id, cam);
}

function startSnapshot(siteId, cam) {
  const key = `${siteId}-${cam}`;
  const refresh = () => {
    const img     = document.getElementById(`snap-${siteId}-${cam}`);
    const offline = img?.parentNode?.querySelector('.cam-offline');
    if (!img) { clearInterval(snapTimers[key]); return; }

    const next  = new Image();
    next.onload = () => {
      img.src            = next.src;
      img.style.display  = '';
      if (offline) offline.style.display = 'none';
    };
    next.src = `/api/sites/${siteId}/snapshot/${encodeURIComponent(cam)}?t=${Date.now()}`;
  };

  refresh();
  snapTimers[key] = setInterval(refresh, 2500);
}

function stopAllSnapshots() {
  Object.values(snapTimers).forEach(clearInterval);
  snapTimers = {};
}

window.openSiteFrigate = function(siteId) {
  openStreamModal(`/proxy/${siteId}/`, `واجهة فريجيت — ${getBranch(siteId)}`);
};

window.openLiveStream = function(siteId, cam, branchLabel) {
  openStreamModal(
    `/proxy/${siteId}/?cameras=${encodeURIComponent(cam)}`,
    `${branchLabel} · ${cam}`
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// EVENTS TAB
// ══════════════════════════════════════════════════════════════════════════════
function initEventsTab() {
  const siteSel = document.getElementById('evtSite');
  const camSel  = document.getElementById('evtCamera');
  const loadBtn = document.getElementById('loadEventsBtn');

  sites.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.branch;
    siteSel.appendChild(opt);
  });

  siteSel.addEventListener('change', () => {
    camSel.innerHTML = '<option value="">جميع الكاميرات</option>';
    const site = sites.find(s => s.id === siteSel.value);
    if (site) {
      site.cameras.forEach(c => {
        const opt = document.createElement('option');
        opt.value = opt.textContent = c;
        camSel.appendChild(opt);
      });
    }
  });

  loadBtn.addEventListener('click', () => {
    const siteId = siteSel.value;
    if (!siteId) return;
    loadEvents(siteId, camSel.value);
  });
}

async function loadEvents(siteId, camera) {
  const grid = document.getElementById('eventsGrid');
  grid.innerHTML = `
    <div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"
           style="animation:spin .9s linear infinite">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"
              stroke-linecap="round"/>
      </svg>
      <span>جارٍ التحميل...</span>
    </div>`;

  const params = new URLSearchParams({ limit: 40, has_snapshot: 1 });
  if (camera) params.set('camera', camera);

  try {
    const r      = await fetch(`/api/sites/${siteId}/events?${params}`);
    const events = await r.json();

    if (!Array.isArray(events) || !events.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2
                     M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          <span>لا توجد أحداث لهذا الفرع</span>
        </div>`;
      return;
    }

    grid.innerHTML = '';
    events.forEach(ev => grid.appendChild(buildEventCard(siteId, ev)));
  } catch {
    grid.innerHTML = `
      <div class="empty-state">
        <span>تعذّر التواصل مع الفرع — تحقق من اتصال النفق</span>
      </div>`;
  }
}

function buildEventCard(siteId, ev) {
  const card = document.createElement('div');
  card.className = 'event-card';

  const subLabel = Array.isArray(ev.sub_label) ? ev.sub_label[0] : (ev.sub_label || '');
  const score    = Array.isArray(ev.sub_label) && ev.sub_label[1]
                   ? ` (${Math.round(ev.sub_label[1] * 100)}%)` : '';
  const name     = subLabel || 'غير معروف';
  const timeStr  = ev.start_time
                   ? new Date(ev.start_time * 1000).toLocaleString('ar-SA') : '';
  const snapUrl  = `/api/sites/${siteId}/events/${ev.id}/snapshot`;
  const clipUrl  = `/api/sites/${siteId}/events/${ev.id}/clip`;

  card.innerHTML = `
    <img class="event-thumb" src="${snapUrl}" alt="لقطة" loading="lazy">
    <div class="event-body">
      <div class="event-name" title="${esc(name + score)}">${esc(name)}${score}</div>
      <div class="event-row">
        <span class="event-cam">${esc(ev.camera || '')}</span>
        <span class="event-time">${timeStr}</span>
      </div>
      <div class="event-actions">
        <button class="evt-btn"
                onclick="openSnapModal('${snapUrl}','${esc(name)}','${timeStr}','${esc(ev.camera || '')}')">
          عرض الصورة
        </button>
        ${ev.has_clip
          ? `<a href="${clipUrl}" download class="evt-btn dl">تحميل المقطع</a>`
          : ''}
      </div>
    </div>
  `;
  return card;
}

// ══════════════════════════════════════════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════════════════════════════════════════
function bindModals() {
  document.getElementById('closeStreamModal').onclick = closeStreamModal;
  document.getElementById('closeSnapModal').onclick   = closeSnapModal;

  document.getElementById('streamModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeStreamModal();
  });
  document.getElementById('snapModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSnapModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeStreamModal(); closeSnapModal(); }
  });
}

function openStreamModal(src, title) {
  document.getElementById('streamModalTitle').textContent = title;
  document.getElementById('streamFrame').src = src;
  document.getElementById('streamModal').classList.remove('hidden');
}

function closeStreamModal() {
  document.getElementById('streamModal').classList.add('hidden');
  document.getElementById('streamFrame').src = '';
}

window.openSnapModal = function(src, name, time, cam) {
  document.getElementById('snapImg').src = src;
  document.getElementById('snapMeta').textContent =
    [name, cam, time].filter(Boolean).join('  ·  ');
  document.getElementById('snapModal').classList.remove('hidden');
};

function closeSnapModal() {
  document.getElementById('snapModal').classList.add('hidden');
  document.getElementById('snapImg').src = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getBranch(siteId) {
  const s = sites.find(x => x.id === siteId);
  return s ? s.branch : siteId;
}

function showMsg(el, type, text) {
  el.className   = `upload-msg ${type}`;
  el.textContent = text;
}

function hideMsg(el) {
  el.className   = 'upload-msg hidden';
  el.textContent = '';
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVED FACES TAB
// ══════════════════════════════════════════════════════════════════════════════
function initFacesTab() {
  document.getElementById('refreshFacesBtn').addEventListener('click', loadFacesList);
}

async function loadFacesList() {
  const list  = document.getElementById('facesList');
  const stats = document.getElementById('facesStats');
  list.innerHTML = `
    <div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"
           style="animation:spin .9s linear infinite">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"
              stroke-linecap="round"/>
      </svg>
      <span>جارٍ التحميل...</span>
    </div>`;
  stats.innerHTML = '';

  try {
    const r    = await fetch('/api/saved-faces');
    const data = await r.json();

    if (!data.length) {
      list.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <circle cx="12" cy="8" r="4"/><path d="M6 20a6 6 0 0112 0"/>
          </svg>
          <span>لا توجد صور مسجلة بعد</span>
        </div>`;
      return;
    }

    const totalPhotos = data.reduce((s, e) => s + e.photoCount, 0);
    stats.innerHTML = `
      <div class="faces-stat-bar">
        <span class="faces-stat"><strong>${data.length}</strong> موظف مسجل</span>
        <span class="faces-stat-sep">·</span>
        <span class="faces-stat"><strong>${totalPhotos}</strong> صورة إجمالاً</span>
      </div>`;

    list.innerHTML = '';
    data.forEach(emp => list.appendChild(buildFaceRow(emp)));
  } catch {
    list.innerHTML = `<div class="empty-state"><span>تعذّر تحميل البيانات</span></div>`;
  }
}

function buildFaceRow(emp) {
  const thumbUrl = emp.firstPhoto
    ? `/api/faces/file/${encodeURIComponent(emp.company)}/${encodeURIComponent(emp.branch)}/${encodeURIComponent(emp.employee_id)}/${encodeURIComponent(emp.firstPhoto)}`
    : null;

  const row = document.createElement('div');
  row.className = 'face-row';
  row.dataset.id = emp.employee_id;

  row.innerHTML = `
    <div class="face-thumb-wrap">
      ${thumbUrl
        ? `<img class="face-thumb" src="${thumbUrl}" alt=""
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="face-thumb-empty" style="display:${thumbUrl ? 'none' : 'flex'}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="12" cy="8" r="4"/><path d="M6 20a6 6 0 0112 0"/>
        </svg>
      </div>
    </div>
    <div class="face-info">
      <div class="face-id">${esc(emp.employee_id)}</div>
      ${emp.employee_name ? `<div class="face-name">${esc(emp.employee_name)}</div>` : ''}
    </div>
    <div class="face-meta">
      <span class="face-tag">${esc(emp.company)}</span>
      <span class="face-tag">${esc(emp.branch)}</span>
    </div>
    <div class="face-count">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
      </svg>
      ${emp.photoCount} صورة
    </div>
    <button class="face-del-btn" title="حذف">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>`;

  row.querySelector('.face-del-btn').addEventListener('click', () => deleteFace(emp, row));
  return row;
}

async function deleteFace(emp, row) {
  if (!confirm(`حذف ${emp.employee_id} وجميع صوره؟`)) return;
  const btn = row.querySelector('.face-del-btn');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/saved-faces/${encodeURIComponent(emp.employee_id)}`, { method: 'DELETE' });
    if (r.ok) {
      row.style.transition = 'opacity .25s';
      row.style.opacity    = '0';
      setTimeout(() => {
        row.remove();
        updateFacesStats();
      }, 260);
    } else {
      const d = await r.json();
      alert(d.error || 'فشل الحذف');
      btn.disabled = false;
    }
  } catch {
    alert('تعذّر الاتصال بالخادم');
    btn.disabled = false;
  }
}

function updateFacesStats() {
  const rows  = document.querySelectorAll('.face-row');
  const stats = document.getElementById('facesStats');
  if (!rows.length) {
    stats.innerHTML = '';
    document.getElementById('facesList').innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="8" r="4"/><path d="M6 20a6 6 0 0112 0"/>
        </svg>
        <span>لا توجد صور مسجلة بعد</span>
      </div>`;
    return;
  }
  const empCount = rows.length;
  const photoCount = Array.from(rows).reduce((s, r) => {
    const txt = r.querySelector('.face-count')?.textContent || '';
    return s + (parseInt(txt) || 0);
  }, 0);
  const bar = stats.querySelector('.faces-stat-bar');
  if (bar) {
    bar.innerHTML = `
      <span class="faces-stat"><strong>${empCount}</strong> موظف مسجل</span>
      <span class="faces-stat-sep">·</span>
      <span class="faces-stat"><strong>${photoCount}</strong> صورة إجمالاً</span>`;
  }
}
