// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════
let sites      = [];
let employees  = [];
let companies  = [];
let snapTimers = {};
let activeTab  = 'upload';
let currentUser = null;

// Persisted form selection
const FORM_KEY = 'upload_form_state';

function loadFormState() {
  try { return JSON.parse(localStorage.getItem(FORM_KEY)) || {}; }
  catch { return {}; }
}

function saveFormState(patch) {
  const cur = loadFormState();
  localStorage.setItem(FORM_KEY, JSON.stringify({ ...cur, ...patch }));
}

function clearFormState() { localStorage.removeItem(FORM_KEY); }

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
  startClock();

  // Show login or app based on session
  const me = await checkAuth();
  if (!me) {
    showLogin();
  } else {
    currentUser = me;
    await startApp({ autoSync: false });
  }

  bindLoginForm();
})();

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════
async function checkAuth() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) return null;
    const d = await r.json();
    return d.authenticated ? d : null;
  } catch {
    return null;
  }
}

function showLogin() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  setTimeout(() => document.getElementById('loginUser')?.focus(), 100);
}

function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function bindLoginForm() {
  const form    = document.getElementById('loginForm');
  const userEl  = document.getElementById('loginUser');
  const passEl  = document.getElementById('loginPass');
  const btn     = document.getElementById('loginBtn');
  const msgEl   = document.getElementById('loginMsg');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    hideMsg(msgEl);
    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) {
      return showMsg(msgEl, 'error', 'الرجاء إدخال اسم المستخدم وكلمة المرور');
    }

    btn.disabled = true;
    btn.textContent = 'جارٍ التحقق...';

    try {
      const r = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password })
      });
      const data = await r.json().catch(() => ({}));

      if (r.ok && data.success) {
        currentUser = { user: data.user, fullName: data.fullName };
        passEl.value = '';
        showMsg(msgEl, 'success', 'تم تسجيل الدخول — جارٍ مزامنة الموظفين...');
        await startApp({ autoSync: true });
      } else {
        showMsg(msgEl, 'error', data.error || 'فشل تسجيل الدخول');
      }
    } catch {
      showMsg(msgEl, 'error', 'تعذّر الاتصال بالخادم');
    } finally {
      btn.disabled = false;
      btn.textContent = 'تسجيل الدخول';
    }
  });
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  currentUser = null;
  sites = []; employees = []; companies = [];
  saveCache();
  clearFormState();
  location.reload();
}

// ══════════════════════════════════════════════════════════════════════════════
// APP START
// ══════════════════════════════════════════════════════════════════════════════
async function startApp({ autoSync }) {
  showApp();

  // Show user name in topbar
  if (currentUser?.fullName) {
    document.getElementById('userName').textContent = currentUser.fullName;
  }
  document.getElementById('logoutBtn').addEventListener('click', () => {
    if (confirm('تسجيل الخروج؟')) logout();
  });

  loadCache();
  initUploadTab();
  initEventsTab();
  initFacesTab();
  bindTabs();
  bindModals();

  // Restore last active tab (skip 'live' since that tab is hidden)
  const savedTab = localStorage.getItem('activeTab');
  switchTab(savedTab && savedTab !== 'live' ? savedTab : 'upload');

  // Load fresh data
  await Promise.all([loadSites(), loadEmployees(), loadCompanies()]);
  saveCache();
  refreshUploadDropdowns();
  initEventsTab(); // re-populate site dropdown with fresh sites

  // Auto-sync after fresh login
  if (autoSync) {
    await runSync({ silent: false });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CLOCK
// ══════════════════════════════════════════════════════════════════════════════
function startClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('ar-SA', { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
// CACHE
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// DATA LOADERS
// ══════════════════════════════════════════════════════════════════════════════
async function authedFetch(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) {
    showLogin();
    throw new Error('not authenticated');
  }
  return r;
}

async function loadSites() {
  try {
    const r = await authedFetch('/api/sites');
    sites = await r.json();
  } catch {}
}

async function loadEmployees() {
  try {
    const r = await authedFetch('/api/employees');
    employees = await r.json();
  } catch {}
}

async function loadCompanies() {
  try {
    const r = await authedFetch('/api/companies');
    companies = await r.json();
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD DROPDOWNS
// registered_branch = branch locked after first photo upload (employees table)
// ══════════════════════════════════════════════════════════════════════════════
function employeeRegisteredBranch(emp) {
  return (emp?.registered_branch || '').trim();
}

function employeeHrBranch(emp) {
  return (emp?.branch || '').trim();
}

/** Branch used for dropdown filtering — upload lock wins over HR branch */
function employeeListBranch(emp) {
  return employeeRegisteredBranch(emp) || employeeHrBranch(emp);
}

function employeeMatchesBranchFilter(emp, branch) {
  if (!branch) return true;
  const reg = employeeRegisteredBranch(emp);
  if (reg) return reg === branch;
  return employeeHrBranch(emp) === branch;
}

function findEmployee(id) {
  return employees.find(e => e.employee_id === id);
}

function applyBranchLock(registeredBranch) {
  const branchEl = document.getElementById('branch');
  if (!branchEl) return;
  const reg = (registeredBranch || '').trim();
  if (reg) {
    if (![...branchEl.options].some(o => o.value === reg)) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = reg;
      branchEl.appendChild(opt);
    }
    branchEl.value = reg;
    branchEl.disabled = true;
    branchEl.title = `الموظف مسجل في هذا الفرع — لا يمكن تغييره`;
  } else {
    branchEl.disabled = false;
    branchEl.title = '';
  }
}

function refreshUploadDropdowns() {
  const saved = loadFormState();

  populateCompanyDropdown();

  const companyEl = document.getElementById('company');
  if (saved.company && companyEl && [...companyEl.options].some(o => o.value === saved.company)) {
    companyEl.value = saved.company;
  }
  const company = companyEl?.value || '';

  populateBranchDropdown(company);
  const branchEl = document.getElementById('branch');
  if (saved.branch && branchEl && [...branchEl.options].some(o => o.value === saved.branch)) {
    branchEl.value = saved.branch;
  }
  const branch = branchEl?.value || '';

  // Refresh combobox list, restore selected employee if still present
  refreshEmployeeCombo(company, branch, saved.employee_id);
  renderEmployeeQuickList();
}

function populateCompanyDropdown() {
  const sel = document.getElementById('company');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled>اختر الشركة...</option>';
  const seen = new Set();
  companies.forEach(c => {
    if (c && !seen.has(c)) {
      seen.add(c);
      const opt = document.createElement('option');
      opt.value = opt.textContent = c;
      sel.appendChild(opt);
    }
  });
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
      const b = employeeListBranch(e);
      if (b && !seen.has(b)) {
        seen.add(b);
        const opt = document.createElement('option');
        opt.value = opt.textContent = b;
        sel.appendChild(opt);
      }
    });
  if (current && seen.has(current)) sel.value = current;
}

// ══════════════════════════════════════════════════════════════════════════════
// SEARCHABLE EMPLOYEE COMBOBOX
// ══════════════════════════════════════════════════════════════════════════════
function refreshEmployeeCombo(company, branch, preselectId) {
  const filtered = employees
    .filter(e => (!company || e.company === company) && employeeMatchesBranchFilter(e, branch))
    .sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || '', 'ar'));

  const combo  = document.getElementById('employeeCombo');
  const input  = document.getElementById('employeeSearch');
  const hidden = document.getElementById('employeeSelect');

  combo._all = filtered;

  // If preselected employee is still in the filtered set, restore it
  if (preselectId) {
    const pre = filtered.find(e => e.employee_id === preselectId);
    if (pre) {
      hidden.value = pre.employee_id;
      input.value  = formatEmployeeLabel(pre);
      applyBranchLock(pre.registered_branch);
      renderComboPanel(filtered, pre.employee_id);
      renderEmployeeQuickList();
      return;
    }
  }

  hidden.value = '';
  input.value  = '';
  applyBranchLock(null);
  renderComboPanel(filtered, null);
  renderEmployeeQuickList();
}

function formatEmployeeLabel(e) {
  return e.employee_name ? `${e.employee_name} (${e.employee_id})` : e.employee_id;
}

function renderComboPanel(list, selectedId) {
  const panel = document.getElementById('employeePanel');
  if (!list.length) {
    panel.innerHTML = `<div class="combobox-empty">لا توجد نتائج</div>`;
    return;
  }
  panel.innerHTML = list.slice(0, 200).map(e => `
    <div class="combobox-option${e.employee_id === selectedId ? ' active' : ''}"
         data-id="${escAttr(e.employee_id)}">
      <span class="combobox-option-name">${esc(e.employee_name || e.employee_id)}</span>
      <span class="combobox-option-meta">${esc(e.employee_id)} · ${esc(employeeListBranch(e))}${employeeRegisteredBranch(e) ? ' (مسجل)' : ''} · ${esc(e.company || '')}</span>
    </div>
  `).join('');

  panel.querySelectorAll('.combobox-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const id   = opt.dataset.id;
      const emp  = list.find(e => e.employee_id === id);
      const inp  = document.getElementById('employeeSearch');
      const hide = document.getElementById('employeeSelect');
      inp.value  = formatEmployeeLabel(emp);
      hide.value = emp.employee_id;
      applyBranchLock(emp.registered_branch);
      saveFormState({
        employee_id: emp.employee_id,
        branch:      employeeRegisteredBranch(emp) || document.getElementById('branch').value
      });
      closeCombo();
      renderEmployeeQuickList();
    });
  });
}

function openCombo() {
  document.getElementById('employeeCombo').classList.add('open');
  document.getElementById('employeePanel').classList.remove('hidden');
}

function closeCombo() {
  document.getElementById('employeeCombo').classList.remove('open');
  document.getElementById('employeePanel').classList.add('hidden');
}

function renderEmployeeQuickList() {
  const listEl   = document.getElementById('employeeQuickList');
  const searchEl = document.getElementById('employeeListSearch');
  if (!listEl) return;

  const company = document.getElementById('company')?.value || '';
  const branch  = document.getElementById('branch')?.value  || '';
  const q         = (searchEl?.value || '').trim().toLowerCase();
  const selectedId = document.getElementById('employeeSelect')?.value || '';

  if (!company) {
    listEl.innerHTML = '<div class="employee-quick-empty">اختر الشركة لعرض الموظفين</div>';
    return;
  }
  if (!branch) {
    listEl.innerHTML = '<div class="employee-quick-empty">اختر الفرع لعرض الموظفين</div>';
    return;
  }

  let list = employees
    .filter(e => e.company === company && employeeMatchesBranchFilter(e, branch))
    .sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || '', 'ar'));

  if (q) {
    list = list.filter(e =>
      (e.employee_name || '').toLowerCase().includes(q) ||
      e.employee_id.toLowerCase().includes(q)
    );
  }

  if (!list.length) {
    listEl.innerHTML = '<div class="employee-quick-empty">لا يوجد موظفون مطابقون</div>';
    return;
  }

  listEl.innerHTML = list.map(e => `
    <div class="employee-quick-row${e.employee_id === selectedId ? ' selected' : ''}">
      <div class="employee-quick-main">
        <div class="employee-quick-name">${esc(e.employee_name || e.employee_id)}</div>
        <div class="employee-quick-meta">${esc(e.employee_id)}${employeeRegisteredBranch(e) ? ' · مسجل' : ''}</div>
      </div>
      <button type="button" class="employee-quick-add" data-id="${escAttr(e.employee_id)}">إضافة صورة</button>
    </div>
  `).join('');

  listEl.querySelectorAll('.employee-quick-add').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const emp = findEmployee(btn.dataset.id);
      if (emp) selectEmployeeForUpload(emp);
    });
  });
}

function selectEmployeeForUpload(emp) {
  const companyEl = document.getElementById('company');
  const branchEl  = document.getElementById('branch');

  function ensureOption(sel, value) {
    if (!value || !sel) return;
    if ([...sel.options].some(o => o.value === value)) {
      sel.value = value;
    } else {
      const opt = document.createElement('option');
      opt.value = opt.textContent = value;
      sel.appendChild(opt);
      sel.value = value;
    }
  }

  if (emp.company) ensureOption(companyEl, emp.company);
  populateBranchDropdown(emp.company);

  const branch = employeeRegisteredBranch(emp) || employeeHrBranch(emp);
  if (branch) ensureOption(branchEl, branch);

  refreshEmployeeCombo(emp.company, branchEl.value, emp.employee_id);
  renderEmployeeQuickList();

  saveFormState({
    company:     emp.company,
    branch:      branchEl.value,
    employee_id: emp.employee_id
  });

  const msgEl = document.getElementById('uploadMsg');
  showMsg(msgEl, 'success', `تم اختيار ${emp.employee_name || emp.employee_id} — اختر الصورة ثم اضغط رفع`);

  const fileDrop = document.getElementById('fileDrop');
  fileDrop?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  fileDrop?.classList.add('active');
}

function bindEmployeeCombo() {
  const combo = document.getElementById('employeeCombo');
  const input = document.getElementById('employeeSearch');

  input.addEventListener('focus', () => {
    const list = combo._all || [];
    renderComboPanel(list, document.getElementById('employeeSelect').value || null);
    openCombo();
  });

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const all = combo._all || [];
    const filtered = !q
      ? all
      : all.filter(e =>
          (e.employee_name || '').toLowerCase().includes(q) ||
          e.employee_id.toLowerCase().includes(q));
    renderComboPanel(filtered, null);
    openCombo();
    // Typing without selecting clears the hidden value until they pick
    document.getElementById('employeeSelect').value = '';
  });

  document.addEventListener('click', e => {
    if (!combo.contains(e.target)) closeCombo();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCombo();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ══════════════════════════════════════════════════════════════════════════════
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

  if (name === 'live') renderLiveGrid();
  else                  stopAllSnapshots();

  if (name === 'faces') loadFacesList();
}

// ══════════════════════════════════════════════════════════════════════════════
// SYNC (runnable from button OR auto right after login)
// ══════════════════════════════════════════════════════════════════════════════
async function runSync({ silent }) {
  const syncBtn = document.getElementById('syncEmployeesBtn');
  const syncMsg = document.getElementById('syncMsg');
  if (syncBtn) syncBtn.disabled = true;
  if (syncMsg && !silent) {
    syncMsg.textContent = 'جارٍ المزامنة...';
    syncMsg.style.color = 'var(--text-muted)';
  }
  try {
    const r = await fetch('/api/employees/sync', { method: 'POST' });
    if (r.status === 401) {
      showLogin();
      return;
    }
    const data = await r.json();
    if (r.ok) {
      if (syncMsg) {
        syncMsg.textContent = `تمت المزامنة · ${data.saved ?? 0} موظف · ${data.companies ?? 0} شركة`;
        syncMsg.style.color = '#22d3ee';
      }
      await Promise.all([loadEmployees(), loadCompanies()]);
      saveCache();
      refreshUploadDropdowns();
    } else if (syncMsg) {
      syncMsg.textContent = data.error || 'فشلت المزامنة';
      syncMsg.style.color = '#f87171';
    }
  } catch {
    if (syncMsg) {
      syncMsg.textContent = 'تعذّر الاتصال بالخادم';
      syncMsg.style.color = '#f87171';
    }
  } finally {
    if (syncBtn) syncBtn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UPLOAD TAB
// ══════════════════════════════════════════════════════════════════════════════
function initUploadTab() {
  populateCompanyDropdown();
  bindEmployeeCombo();

  document.getElementById('employeeListSearch')?.addEventListener('input', renderEmployeeQuickList);

  document.getElementById('company').addEventListener('change', function () {
    applyBranchLock(null);
    saveFormState({ company: this.value, branch: '', employee_id: '' });
    populateBranchDropdown(this.value);
    refreshEmployeeCombo(this.value, '', null);
    renderEmployeeQuickList();
  });

  document.getElementById('branch').addEventListener('change', function () {
    const company = document.getElementById('company').value;
    const empId   = document.getElementById('employeeSelect').value;
    const emp     = empId ? findEmployee(empId) : null;
    const reg     = employeeRegisteredBranch(emp);
    if (reg && this.value !== reg) {
      showMsg(document.getElementById('uploadMsg'), 'error',
        `هذا الموظف مسجل في الفرع: ${reg} — اختر ذلك الفرع أو موظفاً آخر`);
      this.value = reg;
      return;
    }
    saveFormState({ branch: this.value, employee_id: '' });
    refreshEmployeeCombo(company, this.value, null);
    renderEmployeeQuickList();
  });

  document.getElementById('syncEmployeesBtn').addEventListener('click', () => runSync({ silent: false }));

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
        employees = []; companies = [];
        saveCache();
        clearFormState();
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
    const employeeId = document.getElementById('employeeSelect').value;
    const file       = fileInput.files[0];

    if (!company)    return showMsg(msgEl, 'error', 'يرجى اختيار الشركة');
    if (!branch)     return showMsg(msgEl, 'error', 'يرجى اختيار الفرع');
    if (!employeeId) return showMsg(msgEl, 'error', 'يرجى اختيار الموظف من القائمة');
    if (!file)       return showMsg(msgEl, 'error', 'يرجى اختيار صورة');

    const empRecord = findEmployee(employeeId);
    const regBranch = employeeRegisteredBranch(empRecord);
    if (regBranch && regBranch !== branch) {
      return showMsg(msgEl, 'error', `لا يمكن رفع صور في فرع آخر — الموظف مسجل في: ${regBranch}`);
    }

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
    fd.append('picture',     file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (res.status === 401) { showLogin(); return; }
      const data = await res.json();

      if (res.ok) {
        showMsg(msgEl, 'success', data.message);
        if (empRecord) empRecord.registered_branch = branch;
        applyBranchLock(branch);
        saveFormState({ company, branch, employee_id: employeeId });
        renderEmployeeQuickList();
        // Reset only the photo selection; keep company/branch/employee for batch uploads
        fileInput.value      = '';
        fileName.textContent = 'اسحب الصورة هنا أو اضغط للاختيار';
        fileDrop.classList.remove('active');
        preview.classList.add('hidden');
        preview.src = '';
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
  if (!siteSel) return;

  // Rebuild the site list (preserve current selection if still valid)
  const currentSite = siteSel.value;
  siteSel.innerHTML = '<option value="">— اختر الفرع —</option>';
  sites.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.branch;
    siteSel.appendChild(opt);
  });
  if (currentSite && sites.some(s => s.id === currentSite)) {
    siteSel.value = currentSite;
  }

  if (siteSel._bound) return;
  siteSel._bound = true;

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

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(s) { return esc(s); }

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
  document.getElementById('facesSearch').addEventListener('input', applyFacesFilter);
}

let _facesRows = [];

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
    if (r.status === 401) { showLogin(); return; }
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

    _facesRows = data;
    renderFacesStats(data);
    list.innerHTML = '';
    data.forEach(emp => list.appendChild(buildFaceRow(emp)));
    applyFacesFilter();
  } catch {
    list.innerHTML = `<div class="empty-state"><span>تعذّر تحميل البيانات</span></div>`;
  }
}

function renderFacesStats(data) {
  const totalPhotos = data.reduce((s, e) => s + e.photoCount, 0);
  document.getElementById('facesStats').innerHTML = `
    <div class="faces-stat-bar">
      <span class="faces-stat"><strong>${data.length}</strong> موظف مسجل</span>
      <span class="faces-stat-sep">·</span>
      <span class="faces-stat"><strong>${totalPhotos}</strong> صورة إجمالاً</span>
    </div>`;
}

function applyFacesFilter() {
  const q = document.getElementById('facesSearch').value.trim().toLowerCase();
  document.querySelectorAll('.face-row').forEach(r => {
    const hay = (r.dataset.search || '').toLowerCase();
    r.classList.toggle('filter-hidden', q && !hay.includes(q));
  });
}

function facePhotoUrl(emp, filename) {
  return `/api/faces/file/${encodeURIComponent(emp.company)}/${encodeURIComponent(emp.branch)}/${encodeURIComponent(emp.employee_id)}/${encodeURIComponent(filename)}`;
}

const FACE_DEL_ICON = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

function buildFaceRow(emp) {
  const photos = Array.isArray(emp.photos) && emp.photos.length
    ? emp.photos
    : (emp.firstPhoto ? [emp.firstPhoto] : []);

  const row = document.createElement('div');
  row.className = 'face-row';
  row.dataset.id = emp.employee_id;
  row.dataset.search = [
    emp.employee_id, emp.employee_name, emp.branch, emp.company, ...photos
  ].filter(Boolean).join(' ');

  const photoCards = photos.length
    ? photos.map(file => `
        <div class="face-photo-card" data-file="${escAttr(file)}">
          <img class="face-photo-img" src="${facePhotoUrl(emp, file)}" alt="" loading="lazy">
          <button type="button" class="face-photo-del" title="حذف هذه الصورة">${FACE_DEL_ICON}</button>
        </div>`).join('')
    : `<div class="face-photos-empty">لا توجد ملفات صور</div>`;

  row.innerHTML = `
    <div class="face-row-header">
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
        <span class="face-count-num">${photos.length}</span> صورة
      </div>
      <button type="button" class="face-del-all-btn" title="حذف الموظف وجميع صوره">
        ${FACE_DEL_ICON}
        <span>حذف الكل</span>
      </button>
    </div>
    <div class="face-photos-grid">${photoCards}</div>`;

  row.querySelector('.face-del-all-btn').addEventListener('click', () => deleteAllFaces(emp, row));

  row.querySelectorAll('.face-photo-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const card = btn.closest('.face-photo-card');
      deleteSinglePhoto(emp, card.dataset.file, card, row);
    });
  });

  return row;
}

async function deleteSinglePhoto(emp, filename, cardEl, rowEl) {
  if (!confirm(`حذف هذه الصورة؟\n${filename}`)) return;
  const btn = cardEl.querySelector('.face-photo-del');
  btn.disabled = true;
  try {
    const r = await fetch(
      `/api/saved-faces/${encodeURIComponent(emp.employee_id)}/photos/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    );
    if (r.status === 401) { showLogin(); return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(data.error || 'فشل حذف الصورة');
      btn.disabled = false;
      return;
    }

    if (data.employeeRemoved) {
      rowEl.style.transition = 'opacity .25s';
      rowEl.style.opacity    = '0';
      setTimeout(() => {
        rowEl.remove();
        _facesRows = _facesRows.filter(e => e.employee_id !== emp.employee_id);
        refreshFacesStatsFromDom();
      }, 260);
      return;
    }

    cardEl.style.transition = 'opacity .2s, transform .2s';
    cardEl.style.opacity    = '0';
    cardEl.style.transform  = 'scale(.92)';
    setTimeout(() => {
      cardEl.remove();
      const countEl = rowEl.querySelector('.face-count-num');
      const left    = rowEl.querySelectorAll('.face-photo-card').length;
      if (countEl) countEl.textContent = left;
      const rec = _facesRows.find(e => e.employee_id === emp.employee_id);
      if (rec) {
        rec.photos     = data.photos || [];
        rec.photoCount = rec.photos.length;
        rec.firstPhoto = rec.photos[0] || null;
      }
      if (!rowEl.querySelector('.face-photo-card')) {
        rowEl.querySelector('.face-photos-grid').innerHTML =
          '<div class="face-photos-empty">لا توجد ملفات صور</div>';
      }
      refreshFacesStatsFromDom();
    }, 200);
  } catch {
    alert('تعذّر الاتصال بالخادم');
    btn.disabled = false;
  }
}

async function deleteAllFaces(emp, row) {
  if (!confirm(`حذف ${emp.employee_id} وجميع صوره (${emp.photoCount || '?'} صورة)؟`)) return;
  const btn = row.querySelector('.face-del-all-btn');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/saved-faces/${encodeURIComponent(emp.employee_id)}`, { method: 'DELETE' });
    if (r.status === 401) { showLogin(); return; }
    if (r.ok) {
      row.style.transition = 'opacity .25s';
      row.style.opacity    = '0';
      setTimeout(() => {
        row.remove();
        _facesRows = _facesRows.filter(e => e.employee_id !== emp.employee_id);
        refreshFacesStatsFromDom();
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

function refreshFacesStatsFromDom() {
  const rows       = document.querySelectorAll('.face-row');
  const empCount   = rows.length;
  const photoCount = document.querySelectorAll('.face-photo-card').length;
  const stats      = document.getElementById('facesStats');
  const list       = document.getElementById('facesList');

  if (!empCount) {
    stats.innerHTML = '';
    list.innerHTML  = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="8" r="4"/><path d="M6 20a6 6 0 0112 0"/>
        </svg>
        <span>لا توجد صور مسجلة بعد</span>
      </div>`;
    return;
  }

  stats.innerHTML = `
    <div class="faces-stat-bar">
      <span class="faces-stat"><strong>${empCount}</strong> موظف مسجل</span>
      <span class="faces-stat-sep">·</span>
      <span class="faces-stat"><strong>${photoCount}</strong> صورة إجمالاً</span>
    </div>`;
}
