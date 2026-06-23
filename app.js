// ---------- Trạng thái & cấu hình ----------
let DAYS = [];
let DAYS_SHORT = [];
let SESSIONS = [];
let SESSIONS_FULL = [];
let SLOTS = [];
let selectedClassId = null;
let editMode = false;
let manageMode = false;
let classRefreshTimer = null;
let editDirtyNames = new Set();

const $ = (sel) => document.querySelector(sel);
const API_BASE = window.API_BASE || '';
const GAS_API_URL = window.GAS_API_URL || '';
const STUDENT_KEY = window.STUDENT_KEY || '';
const TEACHER_KEY = window.TEACHER_KEY || '';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------- Dark / Light mode ----------
const THEME_KEY = 'lichlop-theme';

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
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
}

function shortName(full) {
  const parts = (full || '').trim().split(/\s+/);
  return parts.length <= 2 ? (full || '').trim() : parts.slice(-2).join(' ');
}

function buildSlots() {
  SLOTS = [];
  DAYS.forEach((day, dayIdx) => {
    SESSIONS.forEach((session, sessionIdx) => {
      SLOTS.push({
        id: `${dayIdx}-${sessionIdx}`,
        dayIdx,
        day,
        session,
        sessionFull: SESSIONS_FULL[sessionIdx] || session,
        label: `${day} ${session}`,
      });
    });
  });
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
      if (data && data.error) reject(new Error(data.error));
      else resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('Không gọi được Google Apps Script.'));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

async function gasApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};

  if (path === '/config') return jsonp({ action: 'config' });
  if (path === '/login' && method === 'POST') {
    return jsonp({ action: 'login', username: body.username, password: body.password });
  }
  if (path === '/classes' && method === 'GET') {
    return jsonp({ action: 'classes', key: STUDENT_KEY });
  }
  if (path === '/classes' && method === 'POST') {
    return jsonp({ action: 'addClass', key: TEACHER_KEY, name: body.name });
  }
  if (path === '/archived-classes' && method === 'GET') {
    return jsonp({ action: 'archivedClasses', key: TEACHER_KEY });
  }
  if (path === '/archived-classes' && method === 'DELETE') {
    return jsonp({ action: 'clearArchived', key: TEACHER_KEY });
  }

  let match = path.match(/^\/classes\/([^/]+)$/);
  if (match && method === 'GET') {
    return jsonp({ action: 'class', key: TEACHER_KEY, classId: match[1] });
  }
  if (match && method === 'DELETE') {
    return jsonp({ action: 'deleteClass', key: TEACHER_KEY, classId: match[1] });
  }

  match = path.match(/^\/classes\/([^/]+)\/(archive|restore|submit|approve|reject|update-busy|bulk-update-busy)$/);
  if (match) {
    const classId = match[1];
    const action = match[2];
    if (action === 'archive') return jsonp({ action: 'archiveClass', key: TEACHER_KEY, classId });
    if (action === 'restore') return jsonp({ action: 'restoreClass', key: TEACHER_KEY, classId });
    if (action === 'submit') {
      return jsonp({
        action: 'submit',
        key: STUDENT_KEY,
        classId,
        studentName: body.studentName,
        busySlots: JSON.stringify(body.busySlots || []),
      });
    }
    if (action === 'approve') {
      return jsonp({ action: 'approve', key: TEACHER_KEY, classId, studentName: body.studentName });
    }
    if (action === 'reject') {
      return jsonp({ action: 'reject', key: TEACHER_KEY, classId, studentName: body.studentName });
    }
    if (action === 'update-busy') {
      return jsonp({
        action: 'updateBusy',
        key: TEACHER_KEY,
        classId,
        studentName: body.studentName,
        busySlots: JSON.stringify(body.busySlots || []),
      });
    }
    if (action === 'bulk-update-busy') {
      return jsonp({
        action: 'bulkUpdateBusy',
        key: TEACHER_KEY,
        classId,
        updates: JSON.stringify(body.updates || []),
      });
    }
  }

  throw new Error('API Google Sheet chưa hỗ trợ thao tác này.');
}

// ---------- Tabs ----------
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

// ---------- Đăng nhập giáo viên ----------
function initTeacher() {
  const loginBtn = $('#btn-login');
  if (!loginBtn) return;

  loginBtn.addEventListener('click', loginTeacher);
  $('#t-password')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loginTeacher();
  });

  $('#btn-logout')?.addEventListener('click', () => {
    clearTimeout(classRefreshTimer);
    $('#teacher-dashboard')?.classList.add('hidden');
    $('#teacher-login')?.classList.remove('hidden');
    if ($('#t-password')) $('#t-password').value = '';
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
}

async function loginTeacher() {
  const username = $('#t-username')?.value || '';
  const password = $('#t-password')?.value || '';
  const error = $('#login-error');
  if (error) error.textContent = '';

  try {
    const result = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if ($('#teacher-name')) $('#teacher-name').textContent = result.name;
    $('#teacher-login')?.classList.add('hidden');
    $('#teacher-dashboard')?.classList.remove('hidden');
    loadClasses();
  } catch (err) {
    if (error) error.textContent = err.message;
  }
}

// ---------- Panel danh sách lớp ----------
async function loadClasses() {
  const ul = $('#class-list');
  if (!ul) return;

  const classes = await api('/classes');
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

// ---------- Chi tiết lớp ----------
async function openClass(id) {
  clearTimeout(classRefreshTimer);
  const cls = await api('/classes/' + id);
  const approved = cls.submissions.filter((s) => s.status === 'approved');
  const pending = cls.submissions.filter((s) => s.status === 'pending');
  const detail = $('#class-detail');
  if (!detail) return;

  let html = `<div class="detail-head">
      <h3>${escapeHtml(cls.name)}</h3>
      <button id="btn-edit" class="btn-edit${editMode ? ' active' : ''}">${
    editMode ? '✓ Xong' : '✏️ Chỉnh sửa'
  }</button>
    </div>`;

  if (editMode) {
    html += '<p class="hint">Đang ở chế độ chỉnh sửa: tích/bỏ tích ô để đổi lịch bận của học sinh.</p>';
  }

  if (approved.length === 0) {
    html += '<p class="placeholder">Chưa có học sinh nào được duyệt.</p>';
  } else {
    const busyCount = {};
    SLOTS.forEach((slot) => (busyCount[slot.id] = 0));
    approved.forEach((student) => {
      (student.busySlots || []).forEach((slotId) => {
        if (busyCount[slotId] !== undefined) busyCount[slotId]++;
      });
    });

    const minBusy = Math.min(...SLOTS.map((slot) => busyCount[slot.id]));
    const maxBusy = Math.max(...SLOTS.map((slot) => busyCount[slot.id]));

    html += '<div class="schedule-scroll"><table class="schedule"><thead>';
    html += '<tr><th rowspan="2">STT</th><th rowspan="2">Học sinh</th>';
    DAYS.forEach((day) => (html += `<th colspan="${SESSIONS.length}">${escapeHtml(day)}</th>`));
    html += '<th rowspan="2"></th></tr><tr>';
    DAYS.forEach(() => SESSIONS.forEach((session) => (html += `<th>${escapeHtml(session)}</th>`)));
    html += '</tr></thead><tbody>';

    approved.forEach((student, idx) => {
      const encodedName = encodeURIComponent(student.studentName);
      html += `<tr><td>${idx + 1}</td><td class="name">${escapeHtml(shortName(student.studentName))}</td>`;
      SLOTS.forEach((slot) => {
        const busy = (student.busySlots || []).includes(slot.id);
        if (editMode) {
          html += `<td class="cell-edit${busy ? ' busy' : ''}"><input type="checkbox" class="busy-chk" data-name="${encodedName}" data-slot="${slot.id}" ${
            busy ? 'checked' : ''
          }></td>`;
        } else {
          html += busy ? '<td class="busy">×</td>' : '<td class="free">·</td>';
        }
      });
      html += `<td class="act-cell"><button class="btn-del-stu" data-name="${encodedName}" title="Xoá học sinh">×</button></td></tr>`;
    });

    html += '<tr class="summary"><td></td><td class="name">Số người bận</td>';
    SLOTS.forEach((slot) => {
      const n = busyCount[slot.id];
      let className = '';
      if (n === minBusy) className = 'best';
      else if (n === maxBusy && maxBusy > 0) className = 'worst';
      html += `<td class="${className}">${n}</td>`;
    });
    html += '<td></td></tr></tbody></table></div>';

    const best = SLOTS.filter((slot) => busyCount[slot.id] === minBusy);
    const byDay = {};
    best.forEach((slot) => {
      byDay[slot.dayIdx] = byDay[slot.dayIdx] || [];
      byDay[slot.dayIdx].push(slot.sessionFull);
    });

    html += '<div class="recommend">';
    html += minBusy === 0
      ? '<div class="rec-title">✅ Buổi tối ưu (không ai bận):</div>'
      : `<div class="rec-title">⚠️ Không có buổi cả lớp rảnh. Ít người bận nhất (${minBusy} người):</div>`;
    DAYS.forEach((day, dayIdx) => {
      if (byDay[dayIdx]) {
        html += `<div class="rec-line"><b>${escapeHtml(DAYS_SHORT[dayIdx])}:</b> ${byDay[dayIdx].map(escapeHtml).join(', ')}</div>`;
      }
    });
    html += '</div>';
  }

  html += `<div class="pending-box"><h4>Chờ duyệt (${pending.length})</h4>`;
  if (pending.length === 0) {
    html += '<p class="placeholder">Không có đăng ký mới.</p>';
  } else {
    pending.forEach((item) => {
      const encodedName = encodeURIComponent(item.studentName);
      const isUpdate = approved.some((student) => student.studentName.toLowerCase() === item.studentName.toLowerCase());
      html += `<div class="pending-item">
        <span>${escapeHtml(shortName(item.studentName))} <small>(${(item.busySlots || []).length} buổi bận)</small>
          ${isUpdate ? '<em>- sửa lại</em>' : ''}</span>
        <span class="acts">
          <button class="btn-approve" data-name="${encodedName}">Duyệt</button>
          <button class="btn-reject" data-name="${encodedName}">Xoá</button>
        </span>
      </div>`;
    });
  }
  html += '</div>';

  detail.innerHTML = html;

  detail.querySelector('#btn-edit')?.addEventListener('click', async () => {
    if (!editMode) {
      editDirtyNames = new Set();
      editMode = true;
      openClass(id);
      return;
    }

    await saveBusyEdits(id, detail);
    editMode = false;
    editDirtyNames = new Set();
    openClass(id);
    loadClasses();
  });

  detail.querySelectorAll('.busy-chk').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      editDirtyNames.add(checkbox.dataset.name);
      checkbox.closest('td')?.classList.toggle('busy', checkbox.checked);
    });
  });

  detail.querySelectorAll('.btn-del-stu').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = decodeURIComponent(button.dataset.name);
      if (!confirm(`Xoá học sinh "${shortName(name)}" khỏi lớp?`)) return;
      await api(`/classes/${id}/reject`, { method: 'POST', body: JSON.stringify({ studentName: name }) });
      openClass(id);
      loadClasses();
    });
  });

  detail.querySelectorAll('.btn-approve').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/classes/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ studentName: decodeURIComponent(button.dataset.name) }),
      });
      openClass(id);
      loadClasses();
    });
  });

  detail.querySelectorAll('.btn-reject').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/classes/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ studentName: decodeURIComponent(button.dataset.name) }),
      });
      openClass(id);
      loadClasses();
    });
  });

  scheduleClassRefresh(id);
}

async function saveBusyEdits(id, detail) {
  if (editDirtyNames.size === 0) return;

  const updates = [...editDirtyNames].map((encodedName) => ({
    studentName: decodeURIComponent(encodedName),
    busySlots: [...detail.querySelectorAll(`.busy-chk[data-name="${encodedName}"]`)]
      .filter((input) => input.checked)
      .map((input) => input.dataset.slot),
  }));

  await api(`/classes/${id}/bulk-update-busy`, {
    method: 'POST',
    body: JSON.stringify({ updates }),
  });
}

function scheduleClassRefresh(id) {
  const teacherTabIsOpen = $('#tab-teacher')?.classList.contains('active');
  const dashboardIsOpen = !$('#teacher-dashboard')?.classList.contains('hidden');
  if (!teacherTabIsOpen || !dashboardIsOpen || editMode) return;

  classRefreshTimer = setTimeout(() => {
    if (selectedClassId === id) {
      openClass(id);
      loadClasses();
    }
  }, 60000);
}

// ---------- Lớp cũ ----------
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
      <span class="acts">
        <button class="btn-approve" data-id="${cls.id}">Khôi phục</button>
        <button class="btn-reject" data-id="${cls.id}">Xoá</button>
      </span>`;

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

// ---------- Trang học sinh ----------
function initStudent() {
  const submitBtn = $('#btn-submit');
  if (!submitBtn) return;

  renderStudentGrid();
  loadStudentClasses();
  submitBtn.addEventListener('click', submitSchedule);
}

async function loadStudentClasses() {
  const select = $('#s-class');
  if (!select) return;

  const classes = await api('/classes');
  select.innerHTML = '';
  if (classes.length === 0) {
    select.innerHTML = '<option value="">Chưa có lớp</option>';
    return;
  }

  classes.forEach((cls) => {
    const option = document.createElement('option');
    option.value = cls.id;
    option.textContent = cls.name;
    select.appendChild(option);
  });
}

function renderStudentGrid() {
  const wrap = $('#s-grid');
  if (!wrap) return;

  let html = '<table class="grid"><thead><tr><th></th>';
  DAYS.forEach((day) => (html += `<th>${escapeHtml(day)}</th>`));
  html += '</tr></thead><tbody>';
  SESSIONS.forEach((session, sessionIdx) => {
    html += `<tr><th>${escapeHtml(session)}</th>`;
    DAYS.forEach((day, dayIdx) => {
      html += `<td><input type="checkbox" data-slot="${dayIdx}-${sessionIdx}" /></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function submitSchedule() {
  const classId = $('#s-class')?.value;
  const name = $('#s-name')?.value.trim();
  const msg = $('#submit-msg');
  if (!msg) return;

  msg.className = 'msg';
  if (!classId) {
    msg.textContent = 'Hãy chọn lớp';
    msg.classList.add('err');
    return;
  }
  if (!name) {
    msg.textContent = 'Hãy nhập họ tên';
    msg.classList.add('err');
    return;
  }

  const busySlots = [...document.querySelectorAll('#s-grid input:checked')].map((input) => input.dataset.slot);
  try {
    await api(`/classes/${classId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ studentName: name, busySlots }),
    });
    msg.textContent = '✅ Đã gửi! Chờ giáo viên duyệt. Gửi lại cùng tên nếu cần sửa lịch cũ.';
    msg.classList.add('ok');
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('err');
  }
}

// ---------- Khởi tạo ----------
(async function init() {
  initTheme();
  initTabs();
  initTeacher();
  initArchived();

  const cfg = await api('/config');
  DAYS = cfg.days;
  DAYS_SHORT = cfg.daysShort || cfg.days;
  SESSIONS = cfg.sessions;
  SESSIONS_FULL = cfg.sessionsFull || cfg.sessions;
  buildSlots();

  initStudent();
})();
