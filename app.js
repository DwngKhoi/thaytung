let DAYS = [];
let DAYS_SHORT = [];
let DEFAULT_SESSIONS = [];
let selectedClassId = null;
let editMode = false;
let manageMode = false;
let classRefreshTimer = null;
let editDirtyKeys = new Set();
let studentClasses = [];
let lookupState = null;

const $ = (sel) => document.querySelector(sel);
const API_BASE = window.API_BASE || '';
const GAS_API_URL = window.GAS_API_URL || '';
const STUDENT_KEY = window.STUDENT_KEY || '';
const TEACHER_KEY = window.TEACHER_KEY || '';
const TEACHER_SESSION_KEY = 'lichlop-teacher-session';
const CLASSES_CACHE_KEY = 'lichlop-classes-cache';
const SELECTED_CLASS_KEY = 'lichlop-selected-class';

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
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const vn = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (vn) return `${vn[3]}-${String(vn[2]).padStart(2, '0')}-${String(vn[1]).padStart(2, '0')}`;
  return raw;
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

async function api(path, opts = {}) {
  if (GAS_API_URL) return gasApi(path, opts);
  const res = await fetch(API_BASE + '/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Lỗi máy chủ');
  return data;
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
  if (path === '/classes' && method === 'POST') return gasRequest({ action: 'addClass', key: TEACHER_KEY, name: body.name });
  if (path === '/archived-classes' && method === 'GET') return gasRequest({ action: 'archivedClasses', key: TEACHER_KEY });
  if (path === '/archived-classes' && method === 'DELETE') return gasRequest({ action: 'clearArchived', key: TEACHER_KEY });

  let match = path.match(/^\/classes\/([^/]+)$/);
  if (match && method === 'GET') return gasRequest({ action: 'class', key: TEACHER_KEY, classId: match[1] });
  if (match && method === 'DELETE') return gasRequest({ action: 'deleteClass', key: TEACHER_KEY, classId: match[1] });

  match = path.match(/^\/classes\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('API chưa hỗ trợ thao tác này.');
  const classId = match[1];
  const action = match[2];
  const teacherBase = { key: TEACHER_KEY, classId };

  if (action === 'archive') return gasRequest({ action: 'archiveClass', ...teacherBase });
  if (action === 'restore') return gasRequest({ action: 'restoreClass', ...teacherBase });
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
    $('#teacher-dashboard')?.classList.add('hidden');
    $('#teacher-login')?.classList.remove('hidden');
    selectedClassId = null;
  });
  $('#btn-manage')?.addEventListener('click', () => {
    manageMode = !manageMode;
    $('#btn-manage')?.classList.toggle('active', manageMode);
    loadClasses();
  });
  $('#btn-add-class')?.addEventListener('click', addClass);
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
    showTeacherDashboard(result.name);
    localStorage.setItem(TEACHER_SESSION_KEY, JSON.stringify({ name: result.name, at: Date.now() }));
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
    if (!session?.name) return;
    showTeacherDashboard(session.name);
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

function showTeacherDashboard(name) {
  if ($('#teacher-name')) $('#teacher-name').textContent = name;
  $('#teacher-login')?.classList.add('hidden');
  $('#teacher-dashboard')?.classList.remove('hidden');
}

async function refreshTeacherView(id = selectedClassId) {
  const tasks = [loadClasses()];
  if (id) tasks.push(openClass(id));
  await Promise.all(tasks);
}

async function loadClasses() {
  const classes = await api('/classes');
  sessionStorage.setItem(CLASSES_CACHE_KEY, JSON.stringify(classes));
  renderClassList(classes);
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
  ul.innerHTML = '';
  if (classes.length === 0) {
    ul.innerHTML = '<li class="placeholder">Chưa có lớp nào.</li>';
    return;
  }
  classes.forEach((cls) => {
    const li = document.createElement('li');
    if (cls.id === selectedClassId) li.classList.add('selected');
    const right = manageMode
      ? '<button class="cls-del" title="Xoá lớp">×</button>'
      : cls.pendingCount
      ? `<span class="badge">${cls.pendingCount} chờ</span>`
      : '';
    li.innerHTML = `<span class="cls-name">${escapeHtml(cls.name)}</span><span class="cls-right">${right}</span>`;
    li.addEventListener('click', () => {
      selectedClassId = cls.id;
      localStorage.setItem(SELECTED_CLASS_KEY, cls.id);
      editMode = false;
      loadClasses();
      openClass(cls.id);
    });
    li.querySelector('.cls-del')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`Xoá lớp "${cls.name}"? Lớp sẽ chuyển vào mục "Lớp cũ".`)) return;
      await api('/classes/' + cls.id + '/archive', { method: 'POST' });
      if (selectedClassId === cls.id) {
        selectedClassId = null;
        localStorage.removeItem(SELECTED_CLASS_KEY);
        const detail = $('#class-detail');
        if (detail) detail.innerHTML = '<p class="placeholder">← Chọn một lớp để xem lịch</p>';
      }
      loadClasses();
    });
    ul.appendChild(li);
  });
}

async function addClass() {
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
  const approved = cls.submissions.filter((s) => s.status === 'approved');
  const pending = cls.submissions.filter((s) => s.status === 'pending');
  if (!detail) return;

  detail.innerHTML = renderTeacherClass(cls, sessions, approved, pending);
  wireTeacherClassEvents(id, detail);
  scheduleClassRefresh(id);
}

function renderTeacherClass(cls, sessions, approved, pending) {
  const slots = buildSlots(sessions);
  const nameCounts = countNames([...approved, ...pending]);
  let html = `<div class="detail-head"><div class="detail-title"><h3>${escapeHtml(cls.name)}</h3>
    <button id="btn-edit" class="btn-edit${editMode ? ' active' : ''}">${editMode ? '✓ Xong' : 'Chỉnh sửa'}</button></div></div>`;
  if (editMode) html += '<p class="hint">Đang chỉnh sửa: tick/bỏ tick các ô rồi bấm Xong để lưu một lần.</p>';

  if (approved.length === 0) {
    html += '<p class="placeholder">Chưa có học sinh nào được duyệt.</p>';
  } else {
    html += renderScheduleTable({ slots, sessions, submissions: approved, editable: editMode, showDelete: true, nameCounts });
    html += renderRecommendation(slots, approved);
  }

  if (!editMode) {
    html += `<div class="teacher-add-student">
      <input id="teacher-new-student" type="text" placeholder="Họ tên đầy đủ..." />
      <input id="teacher-new-dob" type="date" />
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
      <span class="acts">
        <button class="btn-approve" data-key="${key}">Duyệt</button>
        <button class="btn-reject" data-key="${key}">Xoá</button>
      </span></div>`;
  });
  html += '</div>';
  return html;
}

function renderScheduleTable({ slots, sessions, submissions, editable, showDelete, nameCounts, studentLookup }) {
  let html = '<div class="schedule-scroll"><table class="schedule"><thead><tr><th rowspan="2">STT</th><th rowspan="2">Học sinh</th>';
  DAYS.forEach((day) => html += `<th colspan="${sessions.length}">${escapeHtml(day)}</th>`);
  html += showDelete ? '<th rowspan="2">Xoá HS</th>' : '</tr>';
  if (showDelete) html += '</tr>';
  html += '<tr>';
  DAYS.forEach(() => sessions.forEach((session) => html += `<th>${escapeHtml(session)}</th>`));
  html += '</tr></thead><tbody>';

  submissions.forEach((student, idx) => {
    const key = encodeKey(student);
    const canEdit = editable && (!studentLookup || student.canEdit);
    html += `<tr><td>${idx + 1}</td><td class="name">${escapeHtml(displayName(student, nameCounts))}</td>`;
    slots.forEach((slot) => {
      const busy = (student.busySlots || []).includes(slot.id);
      if (canEdit) {
        html += `<td class="cell-edit${busy ? ' busy' : ''}"><input type="checkbox" class="busy-chk" data-key="${key}" data-slot="${slot.id}" ${busy ? 'checked' : ''}></td>`;
      } else {
        html += busy ? '<td class="busy">×</td>' : '<td class="free">·</td>';
      }
    });
    if (showDelete) html += `<td class="act-cell"><button class="btn-del-stu" data-key="${key}" title="Xoá học sinh">×</button></td>`;
    html += '</tr>';
  });

  html += '<tr class="summary"><td></td><td class="name">Số người bận</td>';
  const busyCount = countBusy(slots, submissions);
  const values = slots.map((slot) => busyCount[slot.id]);
  const minBusy = Math.min(...values);
  const maxBusy = Math.max(...values);
  slots.forEach((slot) => {
    const n = busyCount[slot.id];
    let className = '';
    if (n === minBusy) className = 'best';
    else if (n === maxBusy && maxBusy > 0) className = 'worst';
    html += `<td class="${className}">${n}</td>`;
  });
  if (showDelete) html += '<td></td>';
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

function renderRecommendation(slots, approved) {
  const busyCount = countBusy(slots, approved);
  const minBusy = Math.min(...slots.map((slot) => busyCount[slot.id]));
  const best = slots.filter((slot) => busyCount[slot.id] === minBusy);
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

function wireTeacherClassEvents(id, detail) {
  detail.querySelector('#btn-edit')?.addEventListener('click', async () => {
    if (!editMode) {
      editDirtyKeys = new Set();
      editMode = true;
      openClass(id);
      return;
    }
    await saveBusyEdits(id, detail);
    editMode = false;
    editDirtyKeys = new Set();
    await refreshTeacherView(id);
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
  if (!teacherTabIsOpen || !dashboardIsOpen || editMode) return;
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
  const list = await api('/archived-classes');
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

function initStudent() {
  if (!$('#btn-submit')) return;
  $('#btn-submit').addEventListener('click', submitSchedule);
  $('#btn-lookup')?.addEventListener('click', lookupClassSchedule);
  $('#s-class')?.addEventListener('change', renderStudentGrid);
  loadStudentClasses();
}

async function loadStudentClasses() {
  const select = $('#s-class');
  if (!select) return;
  studentClasses = await api('/classes');
  select.innerHTML = '';
  studentClasses.forEach((cls) => {
    const option = document.createElement('option');
    option.value = cls.id;
    option.textContent = cls.name;
    select.appendChild(option);
  });
  renderStudentGrid();
}

function selectedStudentClass() {
  const id = $('#s-class')?.value;
  return studentClasses.find((cls) => cls.id === id);
}

function renderStudentGrid() {
  const wrap = $('#s-grid');
  const cls = selectedStudentClass();
  if (!wrap || !cls) return;
  const sessions = getSessions(cls);
  let html = '<table class="grid"><thead><tr><th></th>';
  DAYS.forEach((day) => html += `<th>${escapeHtml(day)}</th>`);
  html += '</tr></thead><tbody>';
  sessions.forEach((session, sessionIdx) => {
    html += `<tr><th>${escapeHtml(session)}</th>`;
    DAYS.forEach((day, dayIdx) => html += `<td><input type="checkbox" data-slot="${dayIdx}-${sessionIdx}" /></td>`);
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function submitSchedule() {
  const classId = $('#s-class')?.value;
  const studentName = $('#s-name')?.value.trim();
  const dob = normalizeDob($('#s-dob')?.value);
  const msg = $('#submit-msg');
  msg.className = 'msg';
  if (!classId) return showMsg(msg, 'Hãy chọn lớp', 'err');
  if (!studentName) return showMsg(msg, 'Hãy nhập đầy đủ họ tên', 'err');
  if (!dob) return showMsg(msg, 'Hãy nhập ngày tháng năm sinh', 'err');
  const busySlots = [...document.querySelectorAll('#s-grid input:checked')].map((input) => input.dataset.slot);
  try {
    await api(`/classes/${classId}/submit`, { method: 'POST', body: JSON.stringify({ studentName, dob, busySlots }) });
    showMsg(msg, 'Đã gửi! Chờ giáo viên duyệt.', 'ok');
  } catch (err) {
    showMsg(msg, err.message, 'err');
  }
}

function showMsg(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${type || ''}`;
}

async function lookupClassSchedule() {
  const classId = $('#s-class')?.value;
  const studentName = $('#s-name')?.value.trim();
  const dob = normalizeDob($('#s-dob')?.value);
  const msg = $('#lookup-msg');
  const result = $('#lookup-result');
  if (result) result.innerHTML = '';
  if (!classId) return showMsg(msg, 'Hãy chọn lớp', 'err');
  if (!studentName || !dob) return showMsg(msg, 'Nhập họ tên và ngày sinh để tra cứu', 'err');
  try {
    showMsg(msg, 'Đang tra cứu...', '');
    lookupState = await api(`/classes/${classId}/student-class`, { method: 'POST', body: JSON.stringify({ studentName, dob }) });
    showMsg(msg, lookupState.canRequestChange ? '' : 'Không tìm thấy học sinh khớp họ tên và ngày sinh trong danh sách đã duyệt.', lookupState.canRequestChange ? '' : 'err');
    renderLookupResult(false);
  } catch (err) {
    showMsg(msg, err.message, 'err');
  }
}

function renderLookupResult(changeMode) {
  const result = $('#lookup-result');
  if (!result || !lookupState) return;
  const sessions = getSessions(lookupState);
  const slots = buildSlots(sessions);
  const nameCounts = countNames(lookupState.submissions);
  let html = `<div class="lookup-head"><h3>${escapeHtml(lookupState.name)}</h3>`;
  if (lookupState.canRequestChange) {
    html += `<button id="btn-request-change" class="btn-edit${changeMode ? ' active' : ''}">${changeMode ? 'Đang sửa' : 'Yêu cầu đổi'}</button>`;
    if (changeMode) html += '<button id="btn-send-change" class="btn-edit active">Gửi yêu cầu</button>';
  }
  html += '</div>';
  html += renderScheduleTable({ slots, sessions, submissions: lookupState.submissions, editable: changeMode, showDelete: false, nameCounts, studentLookup: true });
  result.innerHTML = html;
  $('#btn-request-change')?.addEventListener('click', () => renderLookupResult(true));
  $('#btn-send-change')?.addEventListener('click', sendChangeRequest);
}

async function sendChangeRequest() {
  if (!lookupState) return;
  const target = lookupState.submissions.find((item) => item.canEdit);
  if (!target) return;
  const key = encodeKey(target);
  const busySlots = [...document.querySelectorAll(`#lookup-result .busy-chk[data-key="${key}"]`)]
    .filter((input) => input.checked)
    .map((input) => input.dataset.slot);
  const msg = $('#lookup-msg');
  try {
    await api(`/classes/${lookupState.id}/request-change`, {
      method: 'POST',
      body: JSON.stringify({ studentName: $('#s-name')?.value.trim(), dob: normalizeDob($('#s-dob')?.value), busySlots }),
    });
    showMsg(msg, 'Đã gửi yêu cầu đổi. Chờ giáo viên duyệt.', 'ok');
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
  const cfg = await api('/config');
  DAYS = cfg.days;
  DAYS_SHORT = cfg.daysShort || cfg.days;
  DEFAULT_SESSIONS = cfg.sessions || ['S1', 'S2', 'C', '57', 'T'];
  initStudent();
})();
