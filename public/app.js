let DAYS = [];
let DAYS_SHORT = [];
let DEFAULT_SESSIONS = [];
let selectedClassId = null;
let editMode = false;
let currentScheduleMode = false;
let manageMode = false;
let classRefreshTimer = null;
let editDirtyKeys = new Set();
let studentClasses = [];
let selectedStudentClassIds = new Set();
let lookupStates = [];
let teacherSession = null;
let teacherAccounts = [];
let selectedTeacherAccountId = null;
let teacherClasses = [];
let teacherClassSectors = [];

const $ = (sel) => document.querySelector(sel);
const API_BASE = window.API_BASE || '';
const GAS_API_URL = window.GAS_API_URL || '';
const SUPABASE_URL = window.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
const STUDENT_KEY = window.STUDENT_KEY || '';
const TEACHER_KEY = window.TEACHER_KEY || '';
const TEACHER_SESSION_KEY = 'lichlop-teacher-session';
const CLASSES_CACHE_KEY = 'lichlop-classes-cache';
const SELECTED_CLASS_KEY = 'lichlop-selected-class';
const EXPANDED_SECTORS_KEY = 'lichlop-expanded-sectors';
const STUDENT_EXPANDED_SECTORS_KEY = 'lichlop-student-expanded-sectors';
const UNCATEGORIZED_SECTOR_ID = '__uncategorized__';

function teacherToken() {
  return teacherSession?.token || '';
}

function isOwner() {
  return teacherSession?.role === 'owner';
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

function getSessions(cls) {
  return Array.isArray(cls?.sessions) && cls.sessions.length ? cls.sessions : DEFAULT_SESSIONS;
}

function buildSlots(sessions) {
  const slots = [];
  DAYS.forEach((day, dayIdx) => {
    sessions.forEach((session, sessionIdx) => {
      slots.push({ id: `${dayIdx}-${sessionIdx}`, dayIdx, day, session, label: `${day} ${session}` });
    });
  });
  return slots;
}

function normalizeDob(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return toIsoDate(iso[1], iso[2], iso[3]);
  const vn = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (vn) return toIsoDate(vn[3], vn[2], vn[1]);
  const compact = raw.replace(/\D/g, '').match(/^(\d{2})(\d{2})(\d{4})$/);
  if (compact) return toIsoDate(compact[3], compact[2], compact[1]);
  return '';
}

function toIsoDate(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!year || !month || !day) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatDobText(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function setupDobInput(input) {
  if (!input || input.dataset.dobReady) return;
  input.dataset.dobReady = '1';
  input.placeholder = input.placeholder || 'dd/mm/yyyy';
  input.inputMode = 'numeric';
  input.maxLength = 10;
  input.addEventListener('input', () => {
    input.value = formatDobText(input.value);
  });
  input.addEventListener('blur', () => {
    input.value = formatDobText(input.value);
  });
}

function dobNote(dob) {
  const match = normalizeDob(dob).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}` : dob;
}

function countNames(submissions) {
  const counts = {};
  submissions.forEach((item) => {
    const key = (item.studentName || '').trim().toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function displayName(item, counts) {
  const name = item.displayName || item.studentName || '';
  const key = (item.studentName || name).trim().toLowerCase();
  return counts && counts[key] >= 2 && item.dob ? `${name} (${dobNote(item.dob)})` : name;
}

const viCollator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

function compareText(a, b) {
  return viCollator.compare(String(a || '').trim(), String(b || '').trim());
}

function sortClasses(classes) {
  return [...(classes || [])].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
}

function sortSectors(sectors) {
  return [...(sectors || [])].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
}

function buildSectorGroups(classes) {
  const sortedClasses = sortClasses(classes);
  const sectorMap = new Map();
  teacherClassSectors.forEach((sector) => {
    if (sector?.id) sectorMap.set(String(sector.id), { id: String(sector.id), name: sector.name || '', classes: [] });
  });
  sortedClasses.forEach((cls) => {
    const sectorId = cls.sectorId ? String(cls.sectorId) : '';
    if (sectorId) {
      if (!sectorMap.has(sectorId)) {
        sectorMap.set(sectorId, { id: sectorId, name: cls.sectorName || '', classes: [] });
      }
      sectorMap.get(sectorId).classes.push(cls);
    }
  });
  let sectors = sortSectors([...sectorMap.values()]).map((sector) => ({
    ...sector,
    classes: sortClasses(sector.classes)
  }));
  if (!manageMode) sectors = sectors.filter((sector) => sector.classes.length);
  const uncategorized = sortedClasses.filter((cls) => !cls.sectorId);
  if (uncategorized.length || manageMode) {
    sectors.push({
      id: UNCATEGORIZED_SECTOR_ID,
      name: 'Ch\u01b0a ph\u00e2n m\u1ee5c',
      system: true,
      classes: uncategorized
    });
  }
  return sectors;
}

function setSectorToolsVisible() {
  const addBtn = $('#btn-add-sector');
  if (!addBtn) return;
  addBtn.classList.toggle('hidden', !manageMode || !isOwner());
}

function collapsedSectorIds() {
  try {
    const raw = localStorage.getItem(EXPANDED_SECTORS_KEY);
    const ids = JSON.parse(raw || '[]');
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch (err) {
    return new Set();
  }
}

function saveCollapsedSectorIds(ids) {
  localStorage.setItem(EXPANDED_SECTORS_KEY, JSON.stringify([...ids]));
}

function isSectorCollapsed(sectorId) {
  return !collapsedSectorIds().has(String(sectorId));
}

function toggleSectorCollapsed(sectorId) {
  const ids = collapsedSectorIds();
  const key = String(sectorId);
  if (ids.has(key)) ids.delete(key);
  else ids.add(key);
  saveCollapsedSectorIds(ids);
  renderClassList(teacherClasses);
}

function collapsedStudentSectorIds() {
  try {
    const raw = localStorage.getItem(STUDENT_EXPANDED_SECTORS_KEY);
    const ids = JSON.parse(raw || '[]');
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch (err) {
    return new Set();
  }
}

function saveCollapsedStudentSectorIds(ids) {
  localStorage.setItem(STUDENT_EXPANDED_SECTORS_KEY, JSON.stringify([...ids]));
}

function isStudentSectorCollapsed(sectorId) {
  return !collapsedStudentSectorIds().has(String(sectorId));
}

function toggleStudentSectorCollapsed(sectorId) {
  const ids = collapsedStudentSectorIds();
  const key = String(sectorId);
  if (ids.has(key)) ids.delete(key);
  else ids.add(key);
  saveCollapsedStudentSectorIds(ids);
  renderStudentClassList();
}

function sortSubmissions(submissions) {
  return [...(submissions || [])].sort((a, b) =>
    compareText(a.studentName || a.displayName, b.studentName || b.displayName) ||
    compareText(a.dob, b.dob)
  );
}

function sessionKey(value) {
  return String(value || '').trim().toLowerCase();
}

function selectedStudentClasses() {
  return [...selectedStudentClassIds].map((id) => studentClasses.find((cls) => cls.id === id)).filter(Boolean);
}

function selectedGridSessions(classes) {
  const seen = {};
  const sessions = [];
  classes.forEach((cls) => getSessions(cls).forEach((session) => {
    const key = sessionKey(session);
    if (seen[key]) return;
    seen[key] = true;
    sessions.push(session);
  }));
  return sessions;
}

function currentGridKeys(classes) {
  const keys = new Set();
  classes.forEach((cls) => {
    getSessions(cls).forEach((session, sessionIdx) => {
      DAYS.forEach((day, dayIdx) => {
        if ((cls.currentSlots || []).includes(`${dayIdx}-${sessionIdx}`)) {
          keys.add(`${dayIdx}-${sessionKey(session)}`);
        }
      });
    });
  });
  return keys;
}

function busySlotsForClass(cls, rootSelector = '#s-grid') {
  const checked = [...document.querySelectorAll(`${rootSelector} input:checked`)];
  const selected = {};
  checked.forEach((input) => {
    selected[`${input.dataset.day}-${input.dataset.sessionKey}`] = true;
  });
  const busySlots = [];
  getSessions(cls).forEach((session, sessionIdx) => {
    const key = sessionKey(session);
    DAYS.forEach((day, dayIdx) => {
      if (selected[`${dayIdx}-${key}`]) busySlots.push(`${dayIdx}-${sessionIdx}`);
    });
  });
  return busySlots;
}

async function api(path, opts = {}) {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return supabaseApi(path, opts);
  if (GAS_API_URL) return gasApi(path, opts);
  const res = await fetch(API_BASE + '/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Lỗi máy chủ');
  return data;
}

async function supabaseRpc(fn, body = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'Lỗi Supabase');
  return data;
}

async function supabaseApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (path === '/config') return supabaseRpc('api_config');
  if (path === '/login' && method === 'POST') return supabaseRpc('api_login', { username: body.username, password: body.password });
  if (path === '/classes' && method === 'GET') return supabaseRpc('api_classes', { student_key: STUDENT_KEY });
  if (path === '/teacher/classes' && method === 'GET') return supabaseRpc('api_teacher_classes', { teacher_key: teacherToken() });
  if (path === '/class-sectors' && method === 'GET') return supabaseRpc('api_class_sectors', { teacher_key: teacherToken() });
  if (path === '/class-sectors' && method === 'POST') return supabaseRpc('api_add_class_sector', { teacher_key: teacherToken(), name: body.name, class_ids: body.classIds || [] });
  if (path === '/classes' && method === 'POST') return supabaseRpc('api_add_class', { teacher_key: teacherToken(), name: body.name });
  if (path === '/archived-classes' && method === 'GET') return supabaseRpc('api_archived_classes', { teacher_key: teacherToken() });
  if (path === '/archived-classes' && method === 'DELETE') return supabaseRpc('api_clear_archived', { teacher_key: teacherToken() });
  if (path === '/teacher-accounts' && method === 'GET') return supabaseRpc('api_teacher_accounts', { teacher_key: teacherToken() });
  if (path === '/teacher-accounts' && method === 'POST') return supabaseRpc('api_add_teacher_account', { teacher_key: teacherToken(), display_name: body.name, username: body.username, password: body.password });

  let accountMatch = path.match(/^\/teacher-accounts\/([^/]+)$/);
  if (accountMatch && method === 'DELETE') return supabaseRpc('api_delete_teacher_account', { teacher_key: teacherToken(), teacher_id: accountMatch[1] });
  accountMatch = path.match(/^\/teacher-accounts\/([^/]+)\/classes$/);
  if (accountMatch && method === 'POST') return supabaseRpc('api_set_teacher_classes', { teacher_key: teacherToken(), teacher_id: accountMatch[1], class_ids: body.classIds || [] });

  let sectorMatch = path.match(/^\/class-sectors\/([^/]+)$/);
  if (sectorMatch && method === 'POST') return supabaseRpc('api_update_class_sector', { teacher_key: teacherToken(), sector_id: sectorMatch[1], name: body.name, class_ids: body.classIds || [] });

  let match = path.match(/^\/classes\/([^/]+)$/);
  if (match && method === 'GET') return supabaseRpc('api_class', { teacher_key: teacherToken(), class_id: match[1] });
  if (match && method === 'DELETE') return supabaseRpc('api_delete_class', { teacher_key: teacherToken(), class_id: match[1] });

  match = path.match(/^\/classes\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('API chưa hỗ trợ thao tác này.');
  const class_id = match[1];
  const action = match[2];
  if (action === 'archive') return supabaseRpc('api_set_archived', { teacher_key: teacherToken(), class_id, archived: true });
  if (action === 'restore') return supabaseRpc('api_set_archived', { teacher_key: teacherToken(), class_id, archived: false });
  if (action === 'rename') return supabaseRpc('api_rename_class', { teacher_key: teacherToken(), class_id, name: body.name });
  if (action === 'set-sessions') return supabaseRpc('api_set_class_sessions', { teacher_key: teacherToken(), class_id, sessions: body.sessions || [] });
  if (action === 'set-current-slots') return supabaseRpc('api_set_current_slots', { teacher_key: teacherToken(), class_id, current_slots: body.currentSlots || [] });
  if (action === 'add-student') return supabaseRpc('api_add_student', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob });
  if (action === 'approve') return supabaseRpc('api_set_submission_status', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob, status: 'approved' });
  if (action === 'reject') return supabaseRpc('api_delete_submission', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob });
  if (action === 'update-busy') return supabaseRpc('api_update_busy', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob, busy_slots: body.busySlots || [] });
  if (action === 'bulk-update-busy') return supabaseRpc('api_bulk_update_busy', { teacher_key: teacherToken(), class_id, updates: body.updates || [] });
  if (action === 'submit') return supabaseRpc('api_submit', { student_key: STUDENT_KEY, class_id, student_name: body.studentName, dob: body.dob, busy_slots: body.busySlots || [] });
  if (action === 'student-class') return supabaseRpc('api_student_class', { student_key: STUDENT_KEY, class_id, student_name: body.studentName, dob: body.dob });
  if (action === 'request-change') return supabaseRpc('api_request_change', { student_key: STUDENT_KEY, class_id, student_name: body.studentName, dob: body.dob, busy_slots: body.busySlots || [] });
  throw new Error('API chưa hỗ trợ thao tác này.');
}

async function gasFetch(params) {
  const url = new URL(GAS_API_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  const res = await fetch(url.toString(), { method: 'GET', mode: 'cors' });
  if (!res.ok) throw new Error('Không gọi được Google Apps Script.');
  const data = await res.json();
  if (data?.error) {
    const err = new Error(data.error);
    err.apiError = true;
    throw err;
  }
  return data;
}

function jsonp(params) {
  return new Promise((resolve, reject) => {
    const callback = `__lichlop_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = new URL(GAS_API_URL);
    Object.entries({ ...params, callback }).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Kết nối Google Sheet quá lâu, hãy thử lại.'));
    }, 30000);
    function cleanup() {
      clearTimeout(timer);
      delete window[callback];
      script.remove();
    }
    window[callback] = (data) => {
      cleanup();
      data?.error ? reject(new Error(data.error)) : resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('Không gọi được Google Apps Script.'));
    };
    script.src = url.toString();
    document.body.appendChild(script);
  });
}

async function gasRequest(params) {
  try {
    return await gasFetch(params);
  } catch (err) {
    if (err.apiError) throw err;
    return jsonp(params);
  }
}

async function gasApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (path === '/config') return gasRequest({ action: 'config' });
  if (path === '/login' && method === 'POST') return gasRequest({ action: 'login', username: body.username, password: body.password });
  if (path === '/classes' && method === 'GET') return gasRequest({ action: 'classes', key: STUDENT_KEY });
  if (path === '/class-sectors' && method === 'GET') return gasRequest({ action: 'classSectors', key: TEACHER_KEY });
  if (path === '/class-sectors' && method === 'POST') return gasRequest({ action: 'addClassSector', key: TEACHER_KEY, name: body.name, classIds: JSON.stringify(body.classIds || []) });
  if (path === '/classes' && method === 'POST') return gasRequest({ action: 'addClass', key: TEACHER_KEY, name: body.name });
  if (path === '/archived-classes' && method === 'GET') return gasRequest({ action: 'archivedClasses', key: TEACHER_KEY });
  if (path === '/archived-classes' && method === 'DELETE') return gasRequest({ action: 'clearArchived', key: TEACHER_KEY });

  let match = path.match(/^\/classes\/([^/]+)$/);
  if (match && method === 'GET') return gasRequest({ action: 'class', key: TEACHER_KEY, classId: match[1] });
  if (match && method === 'DELETE') return gasRequest({ action: 'deleteClass', key: TEACHER_KEY, classId: match[1] });

  let sectorMatch = path.match(/^\/class-sectors\/([^/]+)$/);
  if (sectorMatch && method === 'POST') return gasRequest({ action: 'updateClassSector', key: TEACHER_KEY, sectorId: sectorMatch[1], name: body.name, classIds: JSON.stringify(body.classIds || []) });

  match = path.match(/^\/classes\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('API chưa hỗ trợ thao tác này.');
  const classId = match[1];
  const action = match[2];
  const teacherBase = { key: TEACHER_KEY, classId };

  if (action === 'archive') return gasRequest({ action: 'archiveClass', ...teacherBase });
  if (action === 'restore') return gasRequest({ action: 'restoreClass', ...teacherBase });
  if (action === 'rename') return gasRequest({ action: 'renameClass', ...teacherBase, name: body.name });
  if (action === 'set-sessions') return gasRequest({ action: 'setClassSessions', ...teacherBase, sessions: JSON.stringify(body.sessions || []) });
  if (action === 'add-student') return gasRequest({ action: 'addStudent', ...teacherBase, studentName: body.studentName, dob: body.dob });
  if (action === 'approve') return gasRequest({ action: 'approve', ...teacherBase, studentName: body.studentName, dob: body.dob });
  if (action === 'reject') return gasRequest({ action: 'reject', ...teacherBase, studentName: body.studentName, dob: body.dob });
  if (action === 'update-busy') return gasRequest({ action: 'updateBusy', ...teacherBase, studentName: body.studentName, dob: body.dob, busySlots: JSON.stringify(body.busySlots || []) });
  if (action === 'bulk-update-busy') return gasRequest({ action: 'bulkUpdateBusy', ...teacherBase, updates: JSON.stringify(body.updates || []) });
  if (action === 'submit') return gasRequest({ action: 'submit', key: STUDENT_KEY, classId, studentName: body.studentName, dob: body.dob, busySlots: JSON.stringify(body.busySlots || []) });
  if (action === 'student-class') return gasRequest({ action: 'studentClass', key: STUDENT_KEY, classId, studentName: body.studentName, dob: body.dob });
  if (action === 'request-change') return gasRequest({ action: 'requestChange', key: STUDENT_KEY, classId, studentName: body.studentName, dob: body.dob, busySlots: JSON.stringify(body.busySlots || []) });
  throw new Error('API chưa hỗ trợ thao tác này.');
}

function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
  const btn = $('#btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  const btn = $('#btn-theme');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = document.body.classList.contains('dark') ? 'light' : 'dark';
    localStorage.setItem('lichlop-theme', next);
    applyTheme(next);
  });
  applyTheme(localStorage.getItem('lichlop-theme') || 'light');
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $('#tab-' + btn.dataset.tab)?.classList.add('active');
      if (btn.dataset.tab === 'archived') loadArchived();
      if (btn.dataset.tab === 'accounts') loadTeacherAccounts();
      if (btn.dataset.tab === 'sync-sessions') renderBulkSessions();
    });
  });
}

function initTeacher() {
  if (!$('#btn-login')) return;
  $('#btn-login').addEventListener('click', loginTeacher);
  $('#t-password')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loginTeacher();
  });
  $('#btn-logout')?.addEventListener('click', () => {
    clearTimeout(classRefreshTimer);
    localStorage.removeItem(TEACHER_SESSION_KEY);
    localStorage.removeItem(SELECTED_CLASS_KEY);
    sessionStorage.removeItem(CLASSES_CACHE_KEY);
    $('#teacher-dashboard')?.classList.add('hidden');
    $('#teacher-login')?.classList.remove('hidden');
    selectedClassId = null;
    teacherSession = null;
    teacherClasses = [];
    teacherClassSectors = [];
    currentScheduleMode = false;
    editMode = false;
    manageMode = false;
    setSectorToolsVisible();
    hideSectorEditor();
    document.querySelectorAll('.owner-only').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'teacher'));
    document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'tab-teacher'));
  });
  $('#btn-manage')?.addEventListener('click', () => {
    manageMode = !manageMode;
    $('#btn-manage')?.classList.toggle('active', manageMode);
    setSectorToolsVisible();
    if (!manageMode) hideSectorEditor();
    loadClasses();
  });
  $('#btn-add-sector')?.addEventListener('click', () => showSectorEditor());
  $('#btn-add-class')?.addEventListener('click', addClass);
  $('#btn-bulk-select-all')?.addEventListener('click', () => setBulkClassSelection(true));
  $('#btn-bulk-clear')?.addEventListener('click', () => setBulkClassSelection(false));
  $('#btn-bulk-save')?.addEventListener('click', saveBulkSessions);
  $('#new-class-name')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addClass();
  });
  restoreTeacherSession();
}

async function loginTeacher() {
  const username = $('#t-username')?.value || '';
  const password = $('#t-password')?.value || '';
  const error = $('#login-error');
  if (error) error.textContent = '';
  try {
    $('#btn-login').disabled = true;
    $('#btn-login').textContent = 'Đang đăng nhập...';
    const result = await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    teacherSession = { name: result.name, role: result.role, token: result.token, at: Date.now() };
    showTeacherDashboard(teacherSession);
    localStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify(teacherSession));
    await loadClasses();
  } catch (err) {
    if (error) error.textContent = err.message;
  } finally {
    $('#btn-login').disabled = false;
    $('#btn-login').textContent = 'Đăng nhập';
  }
}

function restoreTeacherSession() {
  const raw = localStorage.getItem(TEACHER_SESSION_KEY);
  if (!raw) return;
  try {
    const session = JSON.parse(raw);
    if (!session?.name || !session?.token || !session?.role) {
      localStorage.removeItem(TEACHER_SESSION_KEY);
      return;
    }
    teacherSession = session;
    showTeacherDashboard(session);
    renderCachedClasses();
    loadClasses().catch((err) => {
      const ul = $('#class-list');
      if (ul) ul.innerHTML = `<li class="placeholder">${escapeHtml(err.message)}</li>`;
    });
    const lastClassId = localStorage.getItem(SELECTED_CLASS_KEY);
    if (lastClassId) {
      selectedClassId = lastClassId;
      openClass(lastClassId).catch(() => localStorage.removeItem(SELECTED_CLASS_KEY));
    }
  } catch (err) {
    localStorage.removeItem(TEACHER_SESSION_KEY);
  }
}

function showTeacherDashboard(session) {
  if ($('#teacher-name')) $('#teacher-name').textContent = session.name;
  document.querySelectorAll('.owner-only').forEach((el) => el.classList.toggle('hidden', session.role !== 'owner'));
  setSectorToolsVisible();
  $('#teacher-login')?.classList.add('hidden');
  $('#teacher-dashboard')?.classList.remove('hidden');
}

async function refreshTeacherView(id = selectedClassId) {
  const tasks = [loadClasses()];
  if (id) tasks.push(openClass(id));
  await Promise.all(tasks);
}

async function loadClasses() {
  const classes = sortClasses(await api('/teacher/classes'));
  teacherClasses = classes;
  if (isOwner()) {
    try {
      teacherClassSectors = sortSectors(await api('/class-sectors'));
    } catch (err) {
      console.warn('Không tải được sector:', err);
      teacherClassSectors = [];
    }
  } else {
    teacherClassSectors = [];
  }
  sessionStorage.setItem(CLASSES_CACHE_KEY, JSON.stringify(classes));
  renderClassList(classes);
  if ($('#tab-sync-sessions')?.classList.contains('active')) renderBulkSessions();
}

function renderBulkSessions() {
  const container = $('#bulk-class-list');
  const input = $('#bulk-sessions-input');
  if (!container || !isOwner()) return;
  if (input && !input.value.trim()) input.value = (DEFAULT_SESSIONS.length ? DEFAULT_SESSIONS : ['S1', 'S2', 'C', '57', 'T']).join(', ');

  const checkedIds = new Set([...container.querySelectorAll('.bulk-class-check:checked')].map((item) => item.value));
  const groups = buildSectorGroups(teacherClasses).filter((group) => group.classes.length);
  if (!groups.length) {
    container.innerHTML = '<p class="placeholder">Ch&#432;a c&#243; l&#7899;p &#273;&#7875; &#225;p d&#7909;ng.</p>';
    return;
  }

  container.innerHTML = groups.map((group) => `
    <section class="bulk-sector">
      <label class="bulk-sector-title">
        <input class="bulk-sector-check" type="checkbox" data-sector="${escapeHtml(group.id)}" />
        <span>${escapeHtml(group.name)}</span>
        <small>${group.classes.length} l&#7899;p</small>
      </label>
      <div class="bulk-sector-classes">
        ${group.classes.map((cls) => `
          <label class="bulk-class-item">
            <input class="bulk-class-check" type="checkbox" value="${escapeHtml(cls.id)}" data-sector="${escapeHtml(group.id)}" ${checkedIds.has(cls.id) ? 'checked' : ''} />
            <span>${escapeHtml(cls.name)}</span>
          </label>
        `).join('')}
      </div>
    </section>
  `).join('');

  const syncSectorCheck = (sectorId) => {
    const children = [...container.querySelectorAll(`.bulk-class-check[data-sector="${CSS.escape(sectorId)}"]`)];
    const parent = container.querySelector(`.bulk-sector-check[data-sector="${CSS.escape(sectorId)}"]`);
    if (!parent || !children.length) return;
    parent.checked = children.every((item) => item.checked);
    parent.indeterminate = !parent.checked && children.some((item) => item.checked);
  };
  container.querySelectorAll('.bulk-sector-check').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      container.querySelectorAll(`.bulk-class-check[data-sector="${CSS.escape(checkbox.dataset.sector)}"]`)
        .forEach((item) => { item.checked = checkbox.checked; });
    });
  });
  container.querySelectorAll('.bulk-class-check').forEach((checkbox) => {
    checkbox.addEventListener('change', () => syncSectorCheck(checkbox.dataset.sector));
    syncSectorCheck(checkbox.dataset.sector);
  });
}

function setBulkClassSelection(checked) {
  document.querySelectorAll('#bulk-class-list input[type="checkbox"]').forEach((item) => {
    item.checked = checked;
    item.indeterminate = false;
  });
}

async function saveBulkSessions() {
  if (!isOwner()) return;
  const sessions = parseSessionInput($('#bulk-sessions-input')?.value || '');
  const classIds = [...document.querySelectorAll('#bulk-class-list .bulk-class-check:checked')].map((item) => item.value);
  const msg = $('#bulk-sessions-msg');
  const button = $('#btn-bulk-save');
  if (!sessions.length) {
    if (msg) { msg.textContent = 'C\u1ea7n \u00edt nh\u1ea5t 1 ca.'; msg.className = 'msg err'; }
    return;
  }
  if (!classIds.length) {
    if (msg) { msg.textContent = 'H\u00e3y ch\u1ecdn \u00edt nh\u1ea5t 1 l\u1edbp.'; msg.className = 'msg err'; }
    return;
  }
  if (!confirm(`\u00c1p d\u1ee5ng ${sessions.join(', ')} cho ${classIds.length} l\u1edbp?`)) return;

  if (button) button.disabled = true;
  if (msg) { msg.textContent = `\u0110ang c\u1eadp nh\u1eadt 0/${classIds.length} l\u1edbp...`; msg.className = 'msg'; }
  try {
    let completed = 0;
    for (let index = 0; index < classIds.length; index += 5) {
      const batch = classIds.slice(index, index + 5);
      await Promise.all(batch.map((classId) => api(`/classes/${classId}/set-sessions`, {
        method: 'POST',
        body: JSON.stringify({ sessions })
      })));
      completed += batch.length;
      if (msg) msg.textContent = `\u0110ang c\u1eadp nh\u1eadt ${completed}/${classIds.length} l\u1edbp...`;
    }
    if (msg) { msg.textContent = `\u0110\u00e3 c\u1eadp nh\u1eadt ${classIds.length} l\u1edbp.`; msg.className = 'msg ok'; }
    await loadClasses();
    if (selectedClassId && classIds.includes(selectedClassId)) await openClass(selectedClassId);
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.className = 'msg err'; }
  } finally {
    if (button) button.disabled = false;
  }
}

function renderCachedClasses() {
  const raw = sessionStorage.getItem(CLASSES_CACHE_KEY);
  if (!raw) return;
  try {
    renderClassList(JSON.parse(raw));
  } catch (err) {
    sessionStorage.removeItem(CLASSES_CACHE_KEY);
  }
}

function renderClassList(classes) {
  const ul = $('#class-list');
  if (!ul) return;
  classes = sortClasses(classes);
  teacherClasses = classes;
  ul.innerHTML = '';
  setSectorToolsVisible();
  if (classes.length === 0 && !teacherClassSectors.length) {
    ul.innerHTML = '<li class="placeholder">Ch&#432;a c&#243; l&#7899;p n&#224;o.</li>';
    return;
  }

  const groups = buildSectorGroups(classes);
  const hasRealSector = groups.some((group) => !group.system);
  if (!hasRealSector && !manageMode) {
    classes.forEach((cls) => ul.appendChild(createClassListItem(cls)));
    return;
  }

  groups.forEach((sector) => {
    ul.appendChild(createSectorTitle(sector));
    if (isSectorCollapsed(sector.id)) return;
    sector.classes.forEach((cls) => ul.appendChild(createClassListItem(cls)));
  });
}

function createSectorTitle(sector) {
  const li = document.createElement('li');
  const collapsed = isSectorCollapsed(sector.id);
  li.className = 'sector-title';
  li.classList.toggle('collapsed', collapsed);
  const editButton = manageMode && isOwner() && !sector.system
    ? '<button class="sector-edit" title="Chinh muc">&#9998;</button>'
    : '';
  li.innerHTML = `
    <span class="sector-title-main">
      <button class="sector-toggle" title="${collapsed ? 'Mo rong' : 'Thu gon'}">${collapsed ? '&#9654;' : '&#9662;'}</button>
      <span class="sector-name">${escapeHtml(sector.name)}</span>
      <span class="sector-count">${sector.classes.length}</span>
    </span>
    ${editButton}
  `;
  li.querySelector('.sector-toggle')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSectorCollapsed(sector.id);
  });
  li.addEventListener('click', () => toggleSectorCollapsed(sector.id));
  li.querySelector('.sector-edit')?.addEventListener('click', (event) => {
    event.stopPropagation();
    showSectorEditor(sector);
  });
  return li;
}

function createClassListItem(cls) {
  const li = document.createElement('li');
  if (cls.id === selectedClassId) li.classList.add('selected');
  const right = manageMode
    ? '<button class="cls-edit" title="Doi ten lop">&#9998;</button><button class="cls-del" title="Xoa lop">&times;</button>'
    : cls.pendingCount
    ? `<span class="badge">${cls.pendingCount} ch&#7901;</span>`
    : '';
  li.innerHTML = `<span class="cls-name">${escapeHtml(cls.name)}</span><span class="cls-right">${right}</span>`;
  li.addEventListener('click', () => {
    selectedClassId = cls.id;
    localStorage.setItem(SELECTED_CLASS_KEY, cls.id);
    editMode = false;
    currentScheduleMode = false;
    loadClasses();
    openClass(cls.id);
  });
  li.querySelector('.cls-edit')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    await renameClass(cls);
  });
  li.querySelector('.cls-del')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!confirm(`Xoa lop "${cls.name}"? Lop se chuyen vao muc "Lop cu".`)) return;
    await api('/classes/' + cls.id + '/archive', { method: 'POST' });
    if (selectedClassId === cls.id) {
      selectedClassId = null;
      localStorage.removeItem(SELECTED_CLASS_KEY);
      const detail = $('#class-detail');
      if (detail) detail.innerHTML = '<p class="placeholder">&larr; Ch&#7885;n m&#7897;t l&#7899;p &#273;&#7875; xem l&#7883;ch</p>';
    }
    loadClasses();
  });
  return li;
}

function hideSectorEditor() {
  const editor = $('#sector-editor');
  if (!editor) return;
  editor.classList.add('hidden');
  editor.innerHTML = '';
}

function sectorEligibleClasses(sector) {
  const sectorId = sector?.id && sector.id !== UNCATEGORIZED_SECTOR_ID ? String(sector.id) : '';
  return sortClasses(teacherClasses.filter((cls) => {
    const currentSectorId = cls.sectorId ? String(cls.sectorId) : '';
    if (!sectorId) return !currentSectorId;
    return !currentSectorId || currentSectorId === sectorId;
  }));
}

function showSectorEditor(sector = null) {
  if (!isOwner()) return;
  const editor = $('#sector-editor');
  if (!editor) return;
  const isEdit = Boolean(sector?.id && sector.id !== UNCATEGORIZED_SECTOR_ID);
  const eligible = sectorEligibleClasses(sector);
  const selectedIds = new Set(isEdit ? teacherClasses.filter((cls) => String(cls.sectorId || '') === String(sector.id)).map((cls) => cls.id) : []);
  const title = isEdit ? 'Ch&#7881;nh m&#7909;c' : 'Th&#234;m m&#7909;c';
  const classListHtml = eligible.length
    ? eligible.map((cls) => `
      <label class="sector-class-check">
        <input type="checkbox" value="${escapeHtml(cls.id)}" ${selectedIds.has(cls.id) ? 'checked' : ''} />
        <span>${escapeHtml(cls.name)}</span>
      </label>
    `).join('')
    : '<p class="hint">Kh&#244;ng c&#243; l&#7899;p ch&#432;a ph&#226;n m&#7909;c &#273;&#7875; th&#234;m.</p>';

  editor.innerHTML = `
    <h4>${title}</h4>
    <label>T&#234;n sector
      <input id="sector-name-input" type="text" value="${escapeHtml(isEdit ? sector.name : '')}" placeholder="vd: IELTS Foundation" />
    </label>
    <div class="sector-class-list">${classListHtml}</div>
    <p class="hint">Khi th&#234;m m&#7909;c m&#7899;i ch&#7881; tick &#273;&#432;&#7907;c l&#7899;p ch&#432;a ph&#226;n m&#7909;c. Khi ch&#7881;nh m&#7909;c c&#243; th&#7875; tick th&#234;m ho&#7863;c b&#7887; tick c&#225;c l&#7899;p trong m&#7909;c &#273;&#243;.</p>
    <div class="sector-editor-actions">
      <button class="sector-cancel" type="button">H&#7911;y</button>
      <button class="sector-save" type="button">L&#432;u</button>
    </div>
  `;
  editor.classList.remove('hidden');
  editor.querySelector('.sector-cancel')?.addEventListener('click', hideSectorEditor);
  editor.querySelector('.sector-save')?.addEventListener('click', async () => {
    const name = editor.querySelector('#sector-name-input')?.value.trim() || '';
    const classIds = [...editor.querySelectorAll('input[type=checkbox]:checked')].map((input) => input.value);
    if (!name) {
      alert('Nhap ten sector');
      return;
    }
    if (isEdit) {
      await api('/class-sectors/' + sector.id, { method: 'POST', body: JSON.stringify({ name, classIds }) });
    } else {
      await api('/class-sectors', { method: 'POST', body: JSON.stringify({ name, classIds }) });
    }
    hideSectorEditor();
    await loadClasses();
  });
  editor.querySelector('#sector-name-input')?.focus();
}

async function renameClass(cls) {
  if (!isOwner() || !cls) return;
  const name = prompt('Nhập tên lớp mới:', cls.name);
  if (name === null) return;
  const cleaned = name.trim();
  if (!cleaned || cleaned === cls.name) return;
  await api('/classes/' + cls.id + '/rename', { method: 'POST', body: JSON.stringify({ name: cleaned }) });
  await loadClasses();
  if (selectedClassId === cls.id) await openClass(cls.id);
}

async function addClass() {
  if (!isOwner()) return;
  const input = $('#new-class-name');
  const name = input?.value.trim();
  if (!name) return;
  await api('/classes', { method: 'POST', body: JSON.stringify({ name }) });
  input.value = '';
  loadClasses();
}

async function openClass(id) {
  clearTimeout(classRefreshTimer);
  const detail = $('#class-detail');
  if (detail && !detail.querySelector('.schedule, .pending-box')) detail.innerHTML = '<p class="placeholder">Đang tải lớp...</p>';
  const cls = await api('/classes/' + id);
  const sessions = getSessions(cls);
  const approved = sortSubmissions(cls.submissions.filter((s) => s.status === 'approved'));
  const pending = sortSubmissions(cls.submissions.filter((s) => s.status === 'pending'));
  if (!detail) return;

  detail.innerHTML = renderTeacherClass(cls, sessions, approved, pending);
  wireTeacherClassEvents(id, detail);
  scheduleClassRefresh(id);
}

function renderTeacherClass(cls, sessions, approved, pending) {
  const slots = buildSlots(sessions);
  const currentSlots = cls.currentSlots || [];
  const nameCounts = countNames([...approved, ...pending]);
  const hasScheduleTable = approved.length > 0 || currentSlots.length > 0 || currentScheduleMode;
  let html = `<div class="detail-head"><div class="detail-title"><h3>${escapeHtml(cls.name)}</h3>`;
  if (isOwner()) {
    html += `<button id="btn-edit" class="btn-edit${editMode ? ' active' : ''}">${editMode ? '✓ Xong' : 'Chỉnh sửa'}</button>
      <button id="btn-current-schedule" class="btn-current${currentScheduleMode ? ' active' : ''}">${currentScheduleMode ? '✓ Lưu lịch hiện tại' : 'Lịch hiện tại'}</button>`;
  }
  if (hasScheduleTable) {
    html += '<button id="btn-copy-excel" class="btn-export" type="button">Copy Excel</button>';
    html += '<button id="btn-copy-image" class="btn-export btn-export-image" type="button">In &#7842;nh</button>';
  }
  html += '</div></div>';
  if (editMode) html += '<p class="hint">Đang chỉnh sửa: tick/bỏ tick các ô rồi bấm Xong để lưu một lần.</p>';
  if (currentScheduleMode) html += '<p class="hint current-hint">Tick các buổi lớp đang học. Các ô này sẽ bị khóa trên phiếu học sinh.</p>';
  if (!isOwner()) html += '<p class="hint readonly-note">Chế độ chỉ xem. Tài khoản owner quản lý lịch và duyệt yêu cầu.</p>';

  if (approved.length === 0 && !currentScheduleMode && currentSlots.length === 0) {
    html += '<p class="placeholder">Chưa có học sinh nào được duyệt.</p>';
  } else {
    html += renderScheduleTable({ slots, sessions, submissions: approved, editable: editMode, showDelete: isOwner(), nameCounts, currentSlots, currentEditable: currentScheduleMode });
    if (approved.length) html += renderRecommendation(slots, approved, currentSlots);
  }

  if (isOwner() && !editMode && !currentScheduleMode) {
    html += `<div class="teacher-add-student">
      <input id="teacher-new-student" type="text" placeholder="Họ tên đầy đủ..." />
      <input id="teacher-new-dob" type="text" placeholder="dd/mm/yyyy" inputmode="numeric" maxlength="10" />
      <button id="btn-teacher-add-student">+ Thêm học sinh</button>
      <span id="teacher-add-student-msg" class="msg"></span>
    </div>
    <div class="class-sessions-editor">
      <label>Các buổi của lớp
        <input id="class-sessions-input" type="text" value="${escapeHtml(sessions.join(', '))}" />
      </label>
      <button id="btn-save-sessions">Cập nhật buổi</button>
      <p class="hint">Nhập theo format <code>Buổi1, Buổi2, ...</code>. Ví dụ: <code>S1, S2, C, 57, T</code>. Khi cập nhật, các buổi này áp dụng cho toàn bộ các thứ trong lớp.</p>
      <p id="sessions-msg" class="msg"></p>
    </div>`;
  }

  html += `<div class="pending-box"><h4>Chờ duyệt (${pending.length})</h4>`;
  if (pending.length === 0) html += '<p class="placeholder">Không có đăng ký mới.</p>';
  pending.forEach((item) => {
    const key = encodeKey(item);
    html += `<div class="pending-item"><span>${escapeHtml(displayName(item, nameCounts))} <small>(${(item.busySlots || []).length} buổi bận)</small></span>
      ${isOwner() ? `<span class="acts"><button class="btn-approve" data-key="${key}">Duyệt</button><button class="btn-reject" data-key="${key}">Xoá</button></span>` : ''}</div>`;
  });
  html += '</div>';
  return html;
}

function renderScheduleTable({ slots, sessions, submissions, editable, showDelete, nameCounts, studentLookup, currentSlots = [], currentEditable = false }) {
  const busyCount = countBusy(slots, submissions);
  const zeroSlotIds = new Set(slots
    .filter((slot) => busyCount[slot.id] === 0 && !currentSlots.includes(slot.id))
    .map((slot) => slot.id));
  const slotClass = (slotId, base = '') => {
    const parts = base ? [base] : [];
    if (currentSlots.includes(slotId)) parts.push('current-slot');
    else if (zeroSlotIds.has(slotId)) parts.push('zero-slot');
    return parts.join(' ');
  };

  let html = '<div class="schedule-scroll"><table class="schedule"><thead><tr><th rowspan="2">STT</th><th rowspan="2">H&#7885;c sinh</th>';
  DAYS.forEach((day) => html += `<th colspan="${sessions.length}">${escapeHtml(day)}</th>`);
  html += showDelete ? '<th class="schedule-actions" rowspan="2">X&#243;a HS</th>' : '</tr>';
  if (showDelete) html += '</tr>';
  html += '<tr>';
  DAYS.forEach((day, dayIdx) => sessions.forEach((session, sessionIdx) => {
    const slotId = `${dayIdx}-${sessionIdx}`;
    html += `<th class="${slotClass(slotId)}" data-slot="${slotId}">${escapeHtml(session)}</th>`;
  }));
  html += '</tr></thead><tbody>';

  if (currentSlots.length || currentEditable) {
    html += '<tr class="current-row"><td></td><td class="name">L&#7883;ch hi&#7879;n t&#7841;i</td>';
    slots.forEach((slot) => {
      const current = currentSlots.includes(slot.id);
      if (currentEditable) {
        html += `<td class="${slotClass(slot.id, 'current-picker')}" data-slot="${slot.id}"><input type="checkbox" class="current-chk" data-slot="${slot.id}" ${current ? 'checked' : ''}></td>`;
      } else {
        html += `<td class="${slotClass(slot.id, current ? '' : 'free')}" data-slot="${slot.id}">${current ? '&#9679;' : '&middot;'}</td>`;
      }
    });
    if (showDelete) html += '<td class="schedule-actions"></td>';
    html += '</tr>';
  }

  submissions.forEach((student, idx) => {
    const key = encodeKey(student);
    const canEdit = editable && (!studentLookup || student.canEdit);
    html += `<tr><td>${idx + 1}</td><td class="name">${escapeHtml(displayName(student, nameCounts))}</td>`;
    slots.forEach((slot) => {
      const busy = (student.busySlots || []).includes(slot.id);
      const current = currentSlots.includes(slot.id);
      if (canEdit && !current) {
        const editBase = busy ? 'cell-edit busy' : 'cell-edit';
        html += `<td class="${slotClass(slot.id, editBase)}" data-slot="${slot.id}"><input type="checkbox" class="busy-chk" data-key="${key}" data-slot="${slot.id}" ${busy ? 'checked' : ''}></td>`;
      } else {
        html += current
          ? `<td class="current-slot" data-slot="${slot.id}" title="Lich hoc hien tai">&#9679;</td>`
          : busy ? `<td class="busy" data-slot="${slot.id}">&times;</td>` : `<td class="${slotClass(slot.id, 'free')}" data-slot="${slot.id}">&middot;</td>`;
      }
    });
    if (showDelete) html += `<td class="act-cell schedule-actions"><button class="btn-del-stu" data-key="${key}" title="Xoa hoc sinh">&times;</button></td>`;
    html += '</tr>';
  });

  html += '<tr class="summary"><td></td><td class="name">S&#7889; ng&#432;&#7901;i b&#7853;n</td>';
  const values = slots.map((slot) => busyCount[slot.id]);
  const minBusy = Math.min(...values);
  const maxBusy = Math.max(...values);
  slots.forEach((slot) => {
    const n = busyCount[slot.id];
    let className = '';
    if (currentSlots.includes(slot.id)) className = 'current-slot';
    else if (n === 0) className = 'best zero-slot';
    else if (n === minBusy) className = 'best';
    else if (n === maxBusy && maxBusy > 0) className = 'worst';
    html += `<td class="${className}" data-slot="${slot.id}">${n}</td>`;
  });
  if (showDelete) html += '<td class="schedule-actions"></td>';
  html += '</tr></tbody></table></div>';
  return html;
}

function countBusy(slots, submissions) {
  const busyCount = {};
  slots.forEach((slot) => busyCount[slot.id] = 0);
  submissions.forEach((student) => (student.busySlots || []).forEach((slotId) => {
    if (busyCount[slotId] !== undefined) busyCount[slotId]++;
  }));
  return busyCount;
}

function renderRecommendation(slots, approved, currentSlots = []) {
  const busyCount = countBusy(slots, approved);
  const availableSlots = slots.filter((slot) => !currentSlots.includes(slot.id));
  if (!availableSlots.length) return '<div class="recommend"><div class="rec-title">Tất cả buổi đã nằm trong lịch hiện tại.</div></div>';
  const minBusy = Math.min(...availableSlots.map((slot) => busyCount[slot.id]));
  const best = availableSlots.filter((slot) => busyCount[slot.id] === minBusy);
  const byDay = {};
  best.forEach((slot) => {
    byDay[slot.dayIdx] = byDay[slot.dayIdx] || [];
    byDay[slot.dayIdx].push(slot.session);
  });
  let html = '<div class="recommend">';
  html += minBusy === 0
    ? '<div class="rec-title">Buổi tối ưu (không ai bận):</div>'
    : `<div class="rec-title">Không có buổi cả lớp rảnh. Ít người bận nhất (${minBusy} người):</div>`;
  DAYS.forEach((day, dayIdx) => {
    if (byDay[dayIdx]) html += `<div class="rec-line"><b>${escapeHtml(DAYS_SHORT[dayIdx])}:</b> ${byDay[dayIdx].map(escapeHtml).join(', ')}</div>`;
  });
  html += '</div>';
  return html;
}

function encodeKey(item) {
  return encodeURIComponent(JSON.stringify({ studentName: item.studentName, dob: item.dob || '' }));
}

function decodeKey(key) {
  return JSON.parse(decodeURIComponent(key));
}

function buildLightExportTable(sourceTable) {
  const table = sourceTable.cloneNode(true);
  table.querySelectorAll('.schedule-actions').forEach((cell) => cell.remove());
  table.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const mark = document.createTextNode(input.checked ? (input.classList.contains('current-chk') ? '\u25cf' : '\u00d7') : '\u00b7');
    input.replaceWith(mark);
  });
  table.style.cssText = 'border-collapse:collapse;border-spacing:0;width:max-content;min-width:100%;font:13px Arial,sans-serif;color:#111827;background:#ffffff;';
  table.querySelectorAll('th,td').forEach((cell) => {
    let background = '#ffffff';
    let color = '#111827';
    let weight = cell.tagName === 'TH' || cell.closest('tr')?.classList.contains('summary') ? '700' : '400';
    if (cell.tagName === 'TH') background = '#fafbfe';
    if (cell.closest('tr')?.classList.contains('summary')) background = '#f3f4f6';
    if (cell.classList.contains('zero-slot') || cell.classList.contains('best')) {
      background = '#d1fae5'; color = '#065f46'; weight = '700';
    }
    if (cell.classList.contains('busy')) {
      background = '#fee2e2'; color = '#b91c1c'; weight = '700';
    }
    if (cell.classList.contains('worst')) color = '#b91c1c';
    if (cell.classList.contains('current-slot')) {
      background = '#f9a8d4'; color = '#831843'; weight = '700';
    }
    if (cell.classList.contains('free') && !cell.classList.contains('zero-slot')) color = '#d1d5db';
    cell.style.cssText = `border:1px solid #d1d5db;padding:7px 9px;text-align:${cell.classList.contains('name') ? 'left' : 'center'};vertical-align:middle;background:${background};color:${color};font-weight:${weight};white-space:nowrap;`;
  });
  return table;
}

function exportTableText(table) {
  return [...table.rows].map((row) => [...row.cells]
    .map((cell) => cell.textContent.trim().replace(/\s+/g, ' '))
    .join('\t')).join('\n');
}

function setExportButtonStatus(button, text, isError = false) {
  if (!button) return;
  const original = button.dataset.originalText || button.textContent;
  button.dataset.originalText = original;
  button.textContent = text;
  button.classList.toggle('export-error', isError);
  clearTimeout(Number(button.dataset.statusTimer || 0));
  const timer = setTimeout(() => {
    button.textContent = original;
    button.classList.remove('export-error');
  }, 2200);
  button.dataset.statusTimer = String(timer);
}

function fallbackCopyHtml(table) {
  const holder = document.createElement('div');
  holder.contentEditable = 'true';
  holder.style.position = 'fixed';
  holder.style.left = '-10000px';
  holder.appendChild(table);
  document.body.appendChild(holder);
  const range = document.createRange();
  range.selectNodeContents(holder);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const ok = document.execCommand('copy');
  selection.removeAllRanges();
  holder.remove();
  if (!ok) throw new Error('Tr\u00ecnh duy\u1ec7t kh\u00f4ng cho ph\u00e9p copy.');
}

async function copyScheduleToExcel(detail, button) {
  const source = detail.querySelector('table.schedule');
  if (!source) return;
  const table = buildLightExportTable(source);
  const html = `<meta charset="utf-8">${table.outerHTML}`;
  const textValue = exportTableText(table);
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([textValue], { type: 'text/plain' })
      })]);
    } else {
      fallbackCopyHtml(table);
    }
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 copy');
  } catch (err) {
    try {
      fallbackCopyHtml(table);
      setExportButtonStatus(button, '\u2713 \u0110\u00e3 copy');
    } catch (fallbackError) {
      setExportButtonStatus(button, 'Copy l\u1ed7i', true);
      alert(fallbackError.message || err.message);
    }
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Kh\u00f4ng t\u1ea1o \u0111\u01b0\u1ee3c \u1ea3nh.')),
    type,
    quality
  ));
}

async function renderScheduleImage(source) {
  const table = buildLightExportTable(source);
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:max-content;background:#fff;z-index:-1;';
  stage.appendChild(table);
  document.body.appendChild(stage);
  await document.fonts?.ready;
  const tableRect = table.getBoundingClientRect();
  const width = Math.ceil(tableRect.width);
  const height = Math.ceil(tableRect.height);
  const maxPixels = 30000000;
  const scale = Math.min(2, Math.sqrt(maxPixels / Math.max(1, width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  table.querySelectorAll('th,td').forEach((cell) => {
    const rect = cell.getBoundingClientRect();
    const x = rect.left - tableRect.left;
    const y = rect.top - tableRect.top;
    const style = getComputedStyle(cell);
    context.fillStyle = style.backgroundColor || '#ffffff';
    context.fillRect(x, y, rect.width, rect.height);
    context.strokeStyle = '#d1d5db';
    context.lineWidth = 1;
    context.strokeRect(x + .5, y + .5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1));
    const value = cell.textContent.trim().replace(/\s+/g, ' ');
    if (!value) return;
    context.save();
    context.beginPath();
    context.rect(x + 2, y + 2, Math.max(0, rect.width - 4), Math.max(0, rect.height - 4));
    context.clip();
    context.fillStyle = style.color || '#111827';
    context.font = `${style.fontWeight || '400'} 13px Arial, sans-serif`;
    context.textBaseline = 'middle';
    context.textAlign = cell.classList.contains('name') ? 'left' : 'center';
    const textX = cell.classList.contains('name') ? x + 9 : x + rect.width / 2;
    context.fillText(value, textX, y + rect.height / 2, Math.max(0, rect.width - 12));
    context.restore();
  });
  stage.remove();
  return canvas;
}

async function copyScheduleAsImage(detail, button) {
  const source = detail.querySelector('table.schedule');
  if (!source) return;
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    setExportButtonStatus(button, 'Kh\u00f4ng h\u1ed7 tr\u1ee3', true);
    return;
  }
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.disabled = true;
  button.textContent = '\u0110ang t\u1ea1o \u1ea3nh...';
  try {
    const canvas = await renderScheduleImage(source);
    const jpeg = await canvasBlob(canvas, 'image/jpeg', .94);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/jpeg': jpeg })]);
    } catch (jpegError) {
      const png = await canvasBlob(canvas, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    }
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 copy \u1ea3nh');
  } catch (err) {
    setExportButtonStatus(button, 'T\u1ea1o \u1ea3nh l\u1ed7i', true);
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

function wireTeacherClassEvents(id, detail) {
  setupDobInput($('#teacher-new-dob'));
  detail.querySelector('#btn-copy-excel')?.addEventListener('click', (event) => copyScheduleToExcel(detail, event.currentTarget));
  detail.querySelector('#btn-copy-image')?.addEventListener('click', (event) => copyScheduleAsImage(detail, event.currentTarget));

  detail.querySelector('#btn-edit')?.addEventListener('click', async () => {
    if (!editMode) {
      editDirtyKeys = new Set();
      editMode = true;
      currentScheduleMode = false;
      openClass(id);
      return;
    }
    await saveBusyEdits(id, detail);
    editMode = false;
    editDirtyKeys = new Set();
    await refreshTeacherView(id);
  });

  detail.querySelector('#btn-current-schedule')?.addEventListener('click', async () => {
    if (!currentScheduleMode) {
      currentScheduleMode = true;
      editMode = false;
      openClass(id);
      return;
    }
    const currentSlots = [...detail.querySelectorAll('.current-chk:checked')].map((input) => input.dataset.slot);
    const button = detail.querySelector('#btn-current-schedule');
    if (button) { button.disabled = true; button.textContent = 'Đang lưu...'; }
    try {
      await api(`/classes/${id}/set-current-slots`, { method: 'POST', body: JSON.stringify({ currentSlots }) });
      currentScheduleMode = false;
      await refreshTeacherView(id);
    } catch (err) {
      if (button) { button.disabled = false; button.textContent = 'Lưu lại lịch hiện tại'; }
      alert(err.message);
    }
  });

  detail.querySelectorAll('.current-chk').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      detail.querySelectorAll(`[data-slot="${checkbox.dataset.slot}"]`).forEach((cell) => {
        cell.classList.toggle('current-slot', checkbox.checked);
      });
    });
  });

  detail.querySelectorAll('.busy-chk').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      editDirtyKeys.add(checkbox.dataset.key);
      checkbox.closest('td')?.classList.toggle('busy', checkbox.checked);
    });
  });

  const addStudent = async () => {
    const studentName = $('#teacher-new-student')?.value.trim();
    const dob = normalizeDob($('#teacher-new-dob')?.value);
    const msg = $('#teacher-add-student-msg');
    if (!studentName || !dob) {
      if (msg) { msg.textContent = 'Nhập họ tên và ngày sinh'; msg.className = 'msg err'; }
      return;
    }
    const btn = $('#btn-teacher-add-student');
    btn.disabled = true;
    if (msg) { msg.textContent = 'Đang thêm...'; msg.className = 'msg'; }
    try {
      await api(`/classes/${id}/add-student`, { method: 'POST', body: JSON.stringify({ studentName, dob }) });
      await refreshTeacherView(id);
    } catch (err) {
      btn.disabled = false;
      if (msg) { msg.textContent = err.message; msg.className = 'msg err'; }
    }
  };
  $('#btn-teacher-add-student')?.addEventListener('click', addStudent);
  $('#teacher-new-student')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addStudent(); });
  $('#teacher-new-dob')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addStudent(); });

  $('#btn-save-sessions')?.addEventListener('click', async () => {
    const raw = $('#class-sessions-input')?.value || '';
    const sessions = parseSessionInput(raw);
    const msg = $('#sessions-msg');
    if (sessions.length === 0) {
      if (msg) { msg.textContent = 'Cần ít nhất 1 buổi'; msg.className = 'msg err'; }
      return;
    }
    try {
      await api(`/classes/${id}/set-sessions`, { method: 'POST', body: JSON.stringify({ sessions }) });
      if (msg) { msg.textContent = 'Đã cập nhật buổi'; msg.className = 'msg ok'; }
      await refreshTeacherView(id);
    } catch (err) {
      if (msg) { msg.textContent = err.message; msg.className = 'msg err'; }
    }
  });

  detail.querySelectorAll('.btn-del-stu').forEach((button) => {
    button.addEventListener('click', async () => {
      const student = decodeKey(button.dataset.key);
      if (!confirm(`Xoá học sinh "${student.studentName}" khỏi lớp?`)) return;
      button.disabled = true;
      button.textContent = '...';
      await api(`/classes/${id}/reject`, { method: 'POST', body: JSON.stringify(student) });
      await refreshTeacherView(id);
    });
  });

  detail.querySelectorAll('.btn-approve').forEach((button) => {
    button.addEventListener('click', async () => {
      const student = decodeKey(button.dataset.key);
      button.disabled = true;
      button.textContent = 'Đang duyệt...';
      await api(`/classes/${id}/approve`, { method: 'POST', body: JSON.stringify(student) });
      await refreshTeacherView(id);
    });
  });

  detail.querySelectorAll('.btn-reject').forEach((button) => {
    button.addEventListener('click', async () => {
      const student = decodeKey(button.dataset.key);
      button.disabled = true;
      button.textContent = 'Đang xoá...';
      await api(`/classes/${id}/reject`, { method: 'POST', body: JSON.stringify(student) });
      await refreshTeacherView(id);
    });
  });
}

function parseSessionInput(value) {
  const seen = {};
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
}

async function saveBusyEdits(id, detail) {
  if (editDirtyKeys.size === 0) return;
  const updates = [...editDirtyKeys].map((key) => {
    const student = decodeKey(key);
    return {
      ...student,
      busySlots: [...detail.querySelectorAll(`.busy-chk[data-key="${key}"]`)]
        .filter((input) => input.checked)
        .map((input) => input.dataset.slot),
    };
  });
  await api(`/classes/${id}/bulk-update-busy`, { method: 'POST', body: JSON.stringify({ updates }) });
}

function scheduleClassRefresh(id) {
  const teacherTabIsOpen = $('#tab-teacher')?.classList.contains('active');
  const dashboardIsOpen = !$('#teacher-dashboard')?.classList.contains('hidden');
  if (!teacherTabIsOpen || !dashboardIsOpen || editMode || currentScheduleMode) return;
  classRefreshTimer = setTimeout(() => {
    if (selectedClassId === id) refreshTeacherView(id);
  }, 60000);
}

function initArchived() {
  $('#btn-clear-archived')?.addEventListener('click', async () => {
    if (!confirm('Xoá vĩnh viễn TẤT CẢ lớp đã lưu trữ? Không thể khôi phục.')) return;
    await api('/archived-classes', { method: 'DELETE' });
    loadArchived();
  });
}

async function loadArchived() {
  const ul = $('#archived-list');
  if (!ul) return;
  const list = sortClasses(await api('/archived-classes'));
  ul.innerHTML = '';
  if ($('#btn-clear-archived')) $('#btn-clear-archived').style.display = list.length ? '' : 'none';
  if (list.length === 0) {
    ul.innerHTML = '<li class="placeholder">Chưa có lớp nào bị xoá.</li>';
    return;
  }
  list.forEach((cls) => {
    const li = document.createElement('li');
    li.className = 'archived-item';
    li.innerHTML = `<span>${escapeHtml(cls.name)} <small>(${cls.approvedCount} học sinh)</small></span>
      <span class="acts"><button class="btn-approve" data-id="${cls.id}">Khôi phục</button><button class="btn-reject" data-id="${cls.id}">Xoá</button></span>`;
    li.querySelector('.btn-approve')?.addEventListener('click', async () => {
      await api(`/classes/${cls.id}/restore`, { method: 'POST' });
      loadArchived();
      loadClasses();
    });
    li.querySelector('.btn-reject')?.addEventListener('click', async () => {
      if (!confirm(`Xoá vĩnh viễn lớp "${cls.name}"? Không thể khôi phục.`)) return;
      await api(`/classes/${cls.id}`, { method: 'DELETE' });
      loadArchived();
    });
    ul.appendChild(li);
  });
}

function initTeacherAccounts() {
  $('#btn-add-account')?.addEventListener('click', addTeacherAccount);
  ['#account-name', '#account-username', '#account-password'].forEach((selector) => {
    $(selector)?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addTeacherAccount();
    });
  });
}

async function addTeacherAccount() {
  if (!isOwner()) return;
  const name = $('#account-name')?.value.trim();
  const username = $('#account-username')?.value.trim();
  const password = $('#account-password')?.value || '';
  const msg = $('#account-create-msg');
  if (!name || !username || password.length < 6) {
    return showMsg(msg, 'Nhập đủ tên, tài khoản và mật khẩu từ 6 ký tự.', 'err');
  }
  const button = $('#btn-add-account');
  try {
    button.disabled = true;
    showMsg(msg, 'Đang tạo tài khoản...', '');
    const created = await api('/teacher-accounts', { method: 'POST', body: JSON.stringify({ name, username, password }) });
    $('#account-name').value = '';
    $('#account-username').value = '';
    $('#account-password').value = '';
    selectedTeacherAccountId = created.id;
    showMsg(msg, 'Đã tạo tài khoản giáo viên.', 'ok');
    await loadTeacherAccounts();
  } catch (err) {
    showMsg(msg, err.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function loadTeacherAccounts() {
  if (!isOwner()) return;
  const list = $('#teacher-account-list');
  if (!list) return;
  list.innerHTML = '<li class="placeholder">Đang tải...</li>';
  try {
    const [accounts, classes] = await Promise.all([api('/teacher-accounts'), api('/teacher/classes')]);
    teacherAccounts = [...accounts].sort((a, b) => compareText(a.name, b.name) || compareText(a.username, b.username));
    studentClasses = sortClasses(classes);
    renderTeacherAccountList();
    if (selectedTeacherAccountId) renderTeacherAssignment(selectedTeacherAccountId);
  } catch (err) {
    list.innerHTML = `<li class="placeholder">${escapeHtml(err.message)}</li>`;
  }
}

function renderTeacherAccountList() {
  const list = $('#teacher-account-list');
  if (!list) return;
  if (!teacherAccounts.length) {
    list.innerHTML = '<li class="placeholder">Chưa có tài khoản giáo viên bộ môn.</li>';
    $('#account-assignment').innerHTML = '<p class="placeholder">Tạo tài khoản đầu tiên để phân công lớp.</p>';
    return;
  }
  list.innerHTML = '';
  teacherAccounts.forEach((account) => {
    const item = document.createElement('li');
    item.classList.toggle('selected', account.id === selectedTeacherAccountId);
    item.innerHTML = `<strong>${escapeHtml(account.name)}</strong><small>@${escapeHtml(account.username)} · ${(account.classIds || []).length} lớp</small>`;
    item.addEventListener('click', () => {
      selectedTeacherAccountId = account.id;
      renderTeacherAccountList();
      renderTeacherAssignment(account.id);
    });
    list.appendChild(item);
  });
}

function renderTeacherAssignment(accountId) {
  const account = teacherAccounts.find((item) => item.id === accountId);
  const wrap = $('#account-assignment');
  if (!account || !wrap) return;
  let html = `<div class="assignment-head"><div><h2>${escapeHtml(account.name)}</h2><p>@${escapeHtml(account.username)}</p></div><button id="btn-delete-account" class="btn-del-class">Xóa tài khoản</button></div>`;
  html += '<h3>Các lớp phụ trách</h3><div class="assignment-classes">';
  if (!studentClasses.length) html += '<p class="placeholder">Chưa có lớp học nào.</p>';
  studentClasses.forEach((cls) => {
    const checked = (account.classIds || []).includes(cls.id);
    html += `<label class="class-check"><input type="checkbox" value="${escapeHtml(cls.id)}" ${checked ? 'checked' : ''}><span>${escapeHtml(cls.name)}</span></label>`;
  });
  html += '</div><button id="btn-save-assignment" class="primary">Lưu phân công</button><p id="assignment-msg" class="msg"></p>';
  wrap.innerHTML = html;

  $('#btn-save-assignment')?.addEventListener('click', async () => {
    const classIds = [...wrap.querySelectorAll('.assignment-classes input:checked')].map((input) => input.value);
    const button = $('#btn-save-assignment');
    try {
      button.disabled = true;
      showMsg($('#assignment-msg'), 'Đang lưu...', '');
      await api(`/teacher-accounts/${account.id}/classes`, { method: 'POST', body: JSON.stringify({ classIds }) });
      showMsg($('#assignment-msg'), 'Đã lưu phân công lớp.', 'ok');
      account.classIds = classIds;
      renderTeacherAccountList();
    } catch (err) {
      showMsg($('#assignment-msg'), err.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('#btn-delete-account')?.addEventListener('click', async () => {
    if (!confirm(`Xóa tài khoản giáo viên "${account.name}"?`)) return;
    await api(`/teacher-accounts/${account.id}`, { method: 'DELETE' });
    selectedTeacherAccountId = null;
    await loadTeacherAccounts();
  });
}

function initStudent() {
  if (!$('#btn-submit')) return;
  setupDobInput($('#s-dob'));
  $('#btn-submit').addEventListener('click', submitSchedule);
  $('#btn-lookup')?.addEventListener('click', lookupClassSchedule);
  loadStudentClasses();
}

async function loadStudentClasses() {
  const wrap = $('#s-classes');
  if (!wrap) return;
  studentClasses = sortClasses(await api('/classes'));
  const validIds = new Set(studentClasses.map((cls) => cls.id));
  selectedStudentClassIds = new Set([...selectedStudentClassIds].filter((id) => validIds.has(id)));
  renderStudentClassList();
  renderStudentGrid();
}

function renderStudentClassList() {
  const wrap = $('#s-classes');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.classList.toggle('has-sectors', studentClasses.some((cls) => cls.sectorId));
  if (!studentClasses.length) {
    wrap.innerHTML = '<p class="placeholder">Ch&#432;a c&#243; l&#7899;p h&#7885;c n&#224;o.</p>';
    return;
  }

  const groups = buildSectorGroups(studentClasses);
  const hasRealSector = groups.some((group) => !group.system);
  if (!hasRealSector) {
    studentClasses.forEach((cls) => wrap.appendChild(createStudentClassCheck(cls)));
    return;
  }

  groups.forEach((sector) => {
    wrap.appendChild(createStudentSectorTitle(sector));
    if (isStudentSectorCollapsed(sector.id)) return;
    sector.classes.forEach((cls) => wrap.appendChild(createStudentClassCheck(cls)));
  });
}

function createStudentSectorTitle(sector) {
  const collapsed = isStudentSectorCollapsed(sector.id);
  const div = document.createElement('div');
  div.className = 'student-sector-title';
  div.classList.toggle('collapsed', collapsed);
  div.innerHTML = `
    <span class="sector-title-main">
      <button class="sector-toggle" type="button" title="${collapsed ? 'Mo rong' : 'Thu gon'}">${collapsed ? '&#9654;' : '&#9662;'}</button>
      <span class="sector-name">${escapeHtml(sector.name)}</span>
      <span class="sector-count">${sector.classes.length}</span>
    </span>
  `;
  div.addEventListener('click', () => toggleStudentSectorCollapsed(sector.id));
  div.querySelector('.sector-toggle')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleStudentSectorCollapsed(sector.id);
  });
  return div;
}

function createStudentClassCheck(cls) {
  const label = document.createElement('label');
  label.className = 'class-check';
  label.innerHTML = `<input type="checkbox" value="${escapeHtml(cls.id)}" ${selectedStudentClassIds.has(cls.id) ? 'checked' : ''} /> <span>${escapeHtml(cls.name)}</span>`;
  label.querySelector('input')?.addEventListener('change', (event) => {
    if (event.target.checked) selectedStudentClassIds.add(cls.id);
    else selectedStudentClassIds.delete(cls.id);
    lookupStates = [];
    $('#lookup-result') && ($('#lookup-result').innerHTML = '');
    $('#lookup-msg') && ($('#lookup-msg').textContent = '');
    renderStudentGrid();
  });
  return label;
}

function renderStudentGrid() {
  const wrap = $('#s-grid');
  if (!wrap) return;
  const classes = selectedStudentClasses();
  if (classes.length === 0) {
    wrap.innerHTML = '<p class="placeholder">Tick một hoặc nhiều lớp để hiện bảng lịch.</p>';
    return;
  }
  const sessions = selectedGridSessions(classes);
  const currentKeys = currentGridKeys(classes);
  let html = '<table class="grid"><thead><tr><th></th>';
  DAYS.forEach((day) => html += `<th>${escapeHtml(day)}</th>`);
  html += '</tr></thead><tbody>';
  sessions.forEach((session) => {
    html += `<tr><th>${escapeHtml(session)}</th>`;
    DAYS.forEach((day, dayIdx) => {
      const key = `${dayIdx}-${sessionKey(session)}`;
      const current = currentKeys.has(key);
      html += `<td class="${current ? 'current-slot student-current-slot' : ''}" ${current ? 'title="Lịch học hiện tại của lớp đã chọn"' : ''}><input type="checkbox" data-day="${dayIdx}" data-session-key="${escapeHtml(sessionKey(session))}" ${current ? 'disabled' : ''} /></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function submitSchedule() {
  const classes = selectedStudentClasses();
  const studentName = $('#s-name')?.value.trim();
  const dob = normalizeDob($('#s-dob')?.value);
  const msg = $('#submit-msg');
  msg.className = 'msg';
  if (classes.length === 0) return showMsg(msg, 'Hãy chọn ít nhất một lớp', 'err');
  if (!studentName) return showMsg(msg, 'Hãy nhập đầy đủ họ tên', 'err');
  if (!dob) return showMsg(msg, 'Hãy nhập ngày tháng năm sinh', 'err');
  const btn = $('#btn-submit');
  try {
    if (btn) btn.disabled = true;
    showMsg(msg, 'Đang gửi...', '');
    const results = await Promise.allSettled(classes.map((cls) =>
      api(`/classes/${cls.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ studentName, dob, busySlots: busySlotsForClass(cls) }),
      }).then(() => cls.name)
    ));
    const ok = results.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const failed = results.filter((item) => item.status === 'rejected');
    if (failed.length) {
      const firstError = failed[0].reason?.message || 'Không gửi được một số lớp';
      const prefix = ok.length ? `Đã gửi ${ok.length}/${classes.length} lớp. ` : '';
      return showMsg(msg, prefix + firstError, ok.length ? 'ok' : 'err');
    }
    showMsg(msg, `Đã gửi ${ok.length} lớp! Chờ giáo viên duyệt.`, 'ok');
  } catch (err) {
    showMsg(msg, err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showMsg(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${type || ''}`;
}

async function lookupClassSchedule() {
  const classes = selectedStudentClasses();
  const studentName = $('#s-name')?.value.trim();
  const dob = normalizeDob($('#s-dob')?.value);
  const msg = $('#lookup-msg');
  const result = $('#lookup-result');
  if (result) result.innerHTML = '';
  if (classes.length === 0) return showMsg(msg, 'Hãy chọn ít nhất một lớp', 'err');
  if (!studentName || !dob) return showMsg(msg, 'Nhập họ tên và ngày sinh để tra cứu', 'err');
  try {
    showMsg(msg, 'Đang tra cứu...', '');
    const results = await Promise.all(classes.map((cls) =>
      api(`/classes/${cls.id}/student-class`, { method: 'POST', body: JSON.stringify({ studentName, dob }) })
    ));
    lookupStates = results;
    const editableCount = lookupStates.filter((item) => item.canRequestChange).length;
    showMsg(
      msg,
      editableCount ? `Tìm thấy ${editableCount}/${lookupStates.length} lớp có học sinh khớp.` : 'Không tìm thấy học sinh khớp họ tên và ngày sinh trong các lớp đã chọn.',
      editableCount ? 'ok' : 'err'
    );
    renderLookupResults();
  } catch (err) {
    showMsg(msg, err.message, 'err');
  }
}

function renderLookupResults(changeClassId = null) {
  const result = $('#lookup-result');
  if (!result || !lookupStates.length) return;
  let html = '';
  lookupStates.forEach((state) => {
    const changeMode = changeClassId === state.id;
    const sessions = getSessions(state);
    const slots = buildSlots(sessions);
    const submissions = sortSubmissions(state.submissions);
    const nameCounts = countNames(submissions);
    html += `<div class="lookup-block" data-lookup-class="${escapeHtml(state.id)}">`;
    html += `<div class="lookup-head"><h3>${escapeHtml(state.name)}</h3>`;
    if (state.canRequestChange) {
      html += `<button class="btn-edit btn-request-change${changeMode ? ' active' : ''}" data-id="${escapeHtml(state.id)}">${changeMode ? 'Đang sửa' : 'Yêu cầu đổi'}</button>`;
      if (changeMode) html += `<button class="btn-edit active btn-send-change" data-id="${escapeHtml(state.id)}">Gửi yêu cầu</button>`;
    }
    html += '</div>';
    html += renderScheduleTable({ slots, sessions, submissions, editable: changeMode, showDelete: false, nameCounts, studentLookup: true, currentSlots: state.currentSlots || [] });
    html += '</div>';
  });
  result.innerHTML = html;
  result.querySelectorAll('.btn-request-change').forEach((button) => {
    button.addEventListener('click', () => renderLookupResults(button.dataset.id));
  });
  result.querySelectorAll('.btn-send-change').forEach((button) => {
    button.addEventListener('click', () => sendChangeRequest(button.dataset.id));
  });
}

async function sendChangeRequest(classId) {
  const state = lookupStates.find((item) => item.id === classId);
  if (!state) return;
  const target = state.submissions.find((item) => item.canEdit);
  if (!target) return;
  const key = encodeKey(target);
  const block = [...document.querySelectorAll('#lookup-result .lookup-block')].find((item) => item.dataset.lookupClass === classId);
  const busySlots = [...(block?.querySelectorAll(`.busy-chk[data-key="${key}"]`) || [])]
    .filter((input) => input.checked)
    .map((input) => input.dataset.slot);
  const msg = $('#lookup-msg');
  try {
    await api(`/classes/${state.id}/request-change`, {
      method: 'POST',
      body: JSON.stringify({ studentName: $('#s-name')?.value.trim(), dob: normalizeDob($('#s-dob')?.value), busySlots }),
    });
    showMsg(msg, `Đã gửi yêu cầu đổi cho lớp ${state.name}. Chờ giáo viên duyệt.`, 'ok');
    lookupClassSchedule();
  } catch (err) {
    showMsg(msg, err.message, 'err');
  }
}

(async function init() {
  initTheme();
  initTabs();
  initTeacher();
  initArchived();
  initTeacherAccounts();
  const cfg = await api('/config');
  DAYS = cfg.days;
  DAYS_SHORT = cfg.daysShort || cfg.days;
  DEFAULT_SESSIONS = cfg.sessions || ['S1', 'S2', 'C', '57', 'T'];
  initStudent();
})();
