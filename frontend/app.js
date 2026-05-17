// ── State ─────────────────────────────────────────────────────────────────────
let sites        = [];
let snapTimers   = {};   // siteId+camera → intervalId
let activeTab    = 'upload';

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSites();
  initUploadTab();
  initEventsTab();
  bindTabs();
  bindModals();
})();

// ── Sites ─────────────────────────────────────────────────────────────────────
async function loadSites() {
  try {
    const r = await fetch('/api/sites');
    sites = await r.json();
  } catch {
    sites = [];
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  activeTab = name;

  document.querySelectorAll('.tab-btn').forEach(b =>
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
}

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD TAB
// ══════════════════════════════════════════════════════════════════════════════
function initUploadTab() {
  // Populate branch dropdown from sites
  const sel = document.getElementById('branch');
  sites.forEach(s => {
    const opt = document.createElement('option');
    opt.value       = s.branch;
    opt.textContent = s.branch;
    sel.appendChild(opt);
  });

  // File preview
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
    reader.onload = e => { preview.src = e.target.result; preview.classList.remove('hidden'); };
    reader.readAsDataURL(file);
  });

  // Submit
  const form      = document.getElementById('uploadForm');
  const submitBtn = document.getElementById('submitBtn');
  const msgEl     = document.getElementById('uploadMsg');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    hideMsg(msgEl);

    const employeeId = document.getElementById('employee_id').value.trim();
    const branch     = document.getElementById('branch').value;

    if (!employeeId || !branch) return showMsg(msgEl, 'error', 'يرجى تعبئة جميع الحقول');
    if (!fileInput.files[0])   return showMsg(msgEl, 'error', 'يرجى اختيار صورة');

    submitBtn.disabled    = true;
    submitBtn.textContent = 'جارٍ الرفع...';

    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: new FormData(form) });
      const data = await res.json();

      if (res.ok) {
        showMsg(msgEl, 'success', data.message);
        form.reset();
        fileName.textContent = 'اضغط لاختيار صورة';
        fileDrop.classList.remove('active');
        preview.classList.add('hidden');
        preview.src = '';
      } else {
        showMsg(msgEl, 'error', data.error || 'حدث خطأ غير متوقع');
      }
    } catch {
      showMsg(msgEl, 'error', 'تعذّر الاتصال بالخادم');
    } finally {
      submitBtn.disabled    = false;
      submitBtn.textContent = 'رفع الصورة';
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
    grid.innerHTML = '<div class="placeholder">لا يوجد فروع مضافة في sites.json</div>';
    return;
  }

  grid.innerHTML = '';

  sites.forEach(site => {
    const block = document.createElement('div');
    block.className = 'site-block';
    block.innerHTML = `
      <div class="site-header">
        <span class="site-name">${esc(site.branch)}</span>
        <div class="site-actions">
          <span class="badge loading" id="badge-${site.id}">جارٍ الفحص...</span>
          <button class="btn-sm" onclick="openSiteFrigate('${site.id}')">فتح واجهة فريجيت</button>
        </div>
      </div>
      <div class="cam-grid" id="cams-${site.id}"></div>
    `;
    grid.appendChild(block);

    checkStatus(site);
    site.cameras.forEach(cam => addCameraCell(site, cam));
  });

  document.getElementById('refreshStatusBtn').onclick = () => {
    sites.forEach(site => checkStatus(site));
  };
}

async function checkStatus(site) {
  const badge = document.getElementById(`badge-${site.id}`);
  try {
    const r    = await fetch(`/api/sites/${site.id}/status`);
    const data = await r.json();
    if (data.online) {
      badge.className   = 'badge online';
      badge.textContent = `متصل${data.version ? ' · ' + data.version : ''}`;
    } else {
      badge.className   = 'badge offline';
      badge.textContent = 'غير متصل';
    }
  } catch {
    badge.className   = 'badge offline';
    badge.textContent = 'غير متصل';
  }
}

function addCameraCell(site, cam) {
  const container = document.getElementById(`cams-${site.id}`);
  const cell = document.createElement('div');
  cell.className = 'cam-cell';
  cell.id = `cell-${site.id}-${cam}`;

  cell.innerHTML = `
    <img id="snap-${site.id}-${cam}" src="" alt="${esc(cam)}"
         onerror="this.parentNode.querySelector('.cam-offline').style.display='flex';this.style.display='none'">
    <div class="cam-offline" style="display:none">
      <span style="font-size:1.8rem">📷</span>
      <span>لا يوجد بث</span>
    </div>
    <div class="cam-label">
      <span>${esc(cam)}</span>
      <button class="live-btn" onclick="openLiveStream('${site.id}','${cam}','${esc(site.branch)}')">
        بث مباشر
      </button>
    </div>
  `;
  container.appendChild(cell);

  startSnapshot(site.id, cam);
}

function startSnapshot(siteId, cam) {
  const key = `${siteId}-${cam}`;
  const refresh = () => {
    const img = document.getElementById(`snap-${siteId}-${cam}`);
    if (!img) { clearInterval(snapTimers[key]); return; }
    const offlineEl = img.parentNode.querySelector('.cam-offline');

    const newImg    = new Image();
    newImg.onload   = () => {
      img.src               = newImg.src;
      img.style.display     = '';
      if (offlineEl) offlineEl.style.display = 'none';
    };
    // onerror keeps offline div visible — do nothing extra
    newImg.src = `/api/sites/${siteId}/snapshot/${encodeURIComponent(cam)}?t=${Date.now()}`;
  };

  refresh();
  snapTimers[key] = setInterval(refresh, 2500);
}

function stopAllSnapshots() {
  Object.values(snapTimers).forEach(clearInterval);
  snapTimers = {};
}

// Open full Frigate UI through the transparent proxy
window.openSiteFrigate = function(siteId) {
  openStreamModal(`/proxy/${siteId}/`, `واجهة فريجيت — ${getBranch(siteId)}`);
};

window.openLiveStream = function(siteId, cam, branchLabel) {
  // Open go2rtc's stream player through the proxy
  openStreamModal(`/proxy/${siteId}/?cameras=${encodeURIComponent(cam)}`, `${branchLabel} · ${cam}`);
};

// ══════════════════════════════════════════════════════════════════════════════
// EVENTS TAB
// ══════════════════════════════════════════════════════════════════════════════
function initEventsTab() {
  const siteSel   = document.getElementById('evtSite');
  const camSel    = document.getElementById('evtCamera');
  const loadBtn   = document.getElementById('loadEventsBtn');

  // Populate site dropdown
  sites.forEach(s => {
    const opt = document.createElement('option');
    opt.value       = s.id;
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
    const cam    = camSel.value;
    if (!siteId) return;
    loadEvents(siteId, cam);
  });
}

async function loadEvents(siteId, camera) {
  const grid = document.getElementById('eventsGrid');
  grid.innerHTML = '<div class="placeholder">جارٍ التحميل...</div>';

  const params = new URLSearchParams({ limit: 40, has_snapshot: 1 });
  if (camera) params.set('camera', camera);

  try {
    const r     = await fetch(`/api/sites/${siteId}/events?${params}`);
    const events = await r.json();

    if (!Array.isArray(events) || !events.length) {
      grid.innerHTML = '<div class="placeholder">لا توجد أحداث</div>';
      return;
    }

    grid.innerHTML = '';
    events.forEach(ev => grid.appendChild(buildEventCard(siteId, ev)));

  } catch {
    grid.innerHTML = '<div class="placeholder">تعذّر تحميل الأحداث — تحقق من اتصال الفرع</div>';
  }
}

function buildEventCard(siteId, ev) {
  const card  = document.createElement('div');
  card.className = 'event-card';

  const subLabel  = Array.isArray(ev.sub_label) ? ev.sub_label[0] : (ev.sub_label || '');
  const score     = Array.isArray(ev.sub_label) && ev.sub_label[1]
                    ? ` (${Math.round(ev.sub_label[1] * 100)}%)`
                    : '';
  const name      = subLabel || 'غير معروف';
  const timeStr   = ev.start_time
                    ? new Date(ev.start_time * 1000).toLocaleString('ar-SA')
                    : '';
  const snapUrl   = `/api/sites/${siteId}/events/${ev.id}/snapshot`;
  const clipUrl   = `/api/sites/${siteId}/events/${ev.id}/clip`;
  const hasClip   = ev.has_clip;

  card.innerHTML = `
    <img class="event-thumb" src="${snapUrl}" alt="لقطة" loading="lazy"
         onerror="this.style.background='#d1d5db'">
    <div class="event-info">
      <div class="event-name" title="${esc(name + score)}">${esc(name)}${score}</div>
      <div class="event-meta">
        <span>${esc(ev.camera || '')}</span>
        <span>${timeStr}</span>
      </div>
      <div class="event-actions">
        <button onclick="openSnapModal('${snapUrl}','${esc(name)}','${timeStr}','${esc(ev.camera || '')}')">
          عرض الصورة
        </button>
        ${hasClip ? `<a href="${clipUrl}" download class="dl-btn event-actions button"
            style="flex:1;text-align:center;padding:.3rem .4rem;font-size:.75rem;
                   border:1.5px solid var(--accent);border-radius:6px;color:var(--accent);
                   text-decoration:none;display:inline-block">
            تحميل المقطع
          </a>` : ''}
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
  document.getElementById('snapMeta').textContent = [name, cam, time].filter(Boolean).join(' · ');
  document.getElementById('snapModal').classList.remove('hidden');
};

function closeSnapModal() {
  document.getElementById('snapModal').classList.add('hidden');
  document.getElementById('snapImg').src = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getBranch(siteId) {
  const s = sites.find(x => x.id === siteId);
  return s ? s.branch : siteId;
}

function showMsg(el, type, text) {
  el.className     = `msg ${type}`;
  el.textContent   = text;
}

function hideMsg(el) {
  el.className   = 'msg hidden';
  el.textContent = '';
}
