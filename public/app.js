let DAYS = [];
let DAYS_SHORT = [];
let DEFAULT_SESSIONS = [];
let selectedClassId = null;
let editMode = false;
let currentScheduleMode = false;
let manageMode = false;
let classRefreshTimer = null;
let finalScheduleTimer = null;
let editDirtyKeys = new Set();
let studentClasses = [];
let selectedStudentClassIds = new Set();
let lookupStates = [];
let teacherSession = null;
let teacherAccounts = [];
let selectedTeacherAccountId = null;
let teacherClasses = [];
let teacherClassSectors = [];
let scheduleClassId = null;
let scheduleEditorData = null;
let scheduleSelectedWeekStart = '';
let scheduleDirty = false;
let scheduleOverviewEditMode = false;
let scheduleOverviewData = { classes: [], weeks: [] };
let lessonPickerOutsideHandler = null;
let lessonPickerEscapeHandler = null;
let homeroomClassId = '';
let homeroomRecordType = 'LR';
let homeroomEditMode = false;
let homeroomWireAbort = null;
let attendanceRows = [];
let attendanceSaveTimers = new Map();
let vocabDeck = [];
let vocabIndex = 0;
let vocabRevealed = false;
let vocabKnown = new Set();
let vocabCustomizations = [];
let teacherDirectory = [];
const HOMEROOM_DATA_PREFIX = 'lichlop-homeroom-record:';
const HOMEROOM_SELECTED_CLASS_KEY = 'lichlop-homeroom-class';
const HOMEROOM_RECORD_TYPE_KEY = 'lichlop-homeroom-record-type';
const SCHEDULE_OVERVIEW_WEEK_KEY = 'lichlop-overview-week-start';
const SCHEDULE_OVERVIEW_DATA_PREFIX = 'lichlop-overview-data:';
const SCHEDULE_OVERVIEW_WEEKS_KEY = 'lichlop-overview-weeks';
const SCHEDULE_OVERVIEW_COLLAPSED_KEY = 'lichlop-overview-collapsed';
const SCHEDULE_OVERVIEW_MODE_KEY = 'lichlop-overview-mode';
const SCHEDULE_EXPANDED_SECTORS_KEY = 'lichlop-schedule-expanded-sectors';

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

function canManageAssignedClass() {
  return teacherSession?.role === 'owner' || teacherSession?.role === 'teacher';
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

function displayLessonLabel(value) {
  const label = String(value || '').toUpperCase();
  if (label === 'REVIEW') return 'Ôn tập';
  if (label === 'OFF') return 'Off';
  if (label === 'LESSON') return '';
  return String(value || '');
}

function scheduleLessonTypeFromLabel(value, courseKind = 'skills') {
  const label = String(value || '').trim().toUpperCase();
  if (!label) return '';
  if (label === 'OFF') return 'OFF';
  if (label === 'LESSON') return courseKind === 'grammar' ? 'LESSON' : '';
  const match = label.match(/^(LR|MT|FT|S|W|L|R)/);
  if (match) return match[1];
  if (label === 'REVIEW') return '';
  return courseKind === 'grammar' ? 'LESSON' : '';
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

function formatDobInputValue(dob) {
  const match = normalizeDob(dob).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(dob || '');
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatDateOnly(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
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

function titleCaseName(value) {
  const lowerWords = new Set(['và', 'van', 'văn', 'thị']);
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('vi-VN')
    .split(' ')
    .filter(Boolean)
    .map((word, index) => {
      if (index > 0 && lowerWords.has(word)) return word === 'van' ? 'Văn' : word;
      return word.charAt(0).toLocaleUpperCase('vi-VN') + word.slice(1);
    })
    .join(' ');
}

function normalizeStudentNameInput(input) {
  const cleaned = titleCaseName(input?.value || '');
  if (input && cleaned) input.value = cleaned;
  return cleaned;
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
  if (path === '/public-schedule' && method === 'POST') return supabaseRpc('api_public_schedule', {
    student_key: STUDENT_KEY,
    class_id: body.classId
  });
  if (path === '/teacher/classes' && method === 'GET') return supabaseRpc('api_teacher_classes', { teacher_key: teacherToken() });
  if (path === '/final-schedule' && method === 'GET') return supabaseRpc('api_final_schedule', { teacher_key: teacherToken() });
  if (path === '/schedule-overview' && method === 'GET') return supabaseRpc('api_schedule_overview', {
    teacher_key: teacherToken(),
    week_start: body.weekStart || null
  });
  if (path === '/class-sectors' && method === 'GET') return supabaseRpc('api_class_sectors', { teacher_key: teacherToken() });
  if (path === '/class-sectors' && method === 'POST') return supabaseRpc('api_add_class_sector', { teacher_key: teacherToken(), name: body.name, class_ids: body.classIds || [] });
  if (path === '/classes' && method === 'POST') return supabaseRpc('api_add_class', { teacher_key: teacherToken(), name: body.name });
  if (path === '/archived-classes' && method === 'GET') return supabaseRpc('api_archived_classes', { teacher_key: teacherToken() });
  if (path === '/archived-classes' && method === 'DELETE') return supabaseRpc('api_clear_archived', { teacher_key: teacherToken() });
  if (path === '/deleted-submissions' && method === 'GET') return supabaseRpc('api_deleted_submissions', { teacher_key: teacherToken() });
  if (path === '/deleted-submissions' && method === 'DELETE') return supabaseRpc('api_clear_deleted_submissions', { teacher_key: teacherToken() });
  {
    const deletedMatch = path.match(/^\/deleted-submissions\/([^/]+)(?:\/(restore))?$/);
    if (deletedMatch && method === 'POST' && deletedMatch[2] === 'restore') return supabaseRpc('api_restore_deleted_submission', { teacher_key: teacherToken(), deleted_id: deletedMatch[1] });
    if (deletedMatch && method === 'DELETE') return supabaseRpc('api_delete_deleted_submission', { teacher_key: teacherToken(), deleted_id: deletedMatch[1] });
  }
  if (path === '/teacher-accounts' && method === 'GET') return supabaseRpc('api_teacher_accounts', { teacher_key: teacherToken() });
  if (path === '/teacher-accounts' && method === 'POST') return supabaseRpc('api_add_teacher_account', { teacher_key: teacherToken(), display_name: body.name, username: body.username, password: body.password });
  if (path === '/teacher-directory' && method === 'GET') return supabaseRpc('api_teacher_directory', { teacher_key: teacherToken() });
  if (path === '/vocabulary-customizations' && method === 'GET') return supabaseRpc('api_vocabulary_customizations', { teacher_key: teacherToken() });
  if (path === '/vocabulary-customizations' && method === 'POST') return supabaseRpc('api_add_vocabulary_word', {
    teacher_key: teacherToken(), book_id: body.bookId, unit_no: body.unitNo, word: body.word || {}
  });
  if (path === '/vocabulary-customizations' && method === 'DELETE') return supabaseRpc('api_remove_vocabulary_word', {
    teacher_key: teacherToken(), book_id: body.bookId, unit_no: body.unitNo,
    word_key: body.wordKey, custom_id: body.customId || null
  });
  if (path === '/profile-fields' && method === 'GET') return supabaseRpc('api_profile_fields', { teacher_key: teacherToken() });
  if (path === '/profile-fields' && method === 'POST') return supabaseRpc('api_save_profile_field', { teacher_key: teacherToken(), field: body.field || {} });
  if (path === '/attendance' && method === 'GET') return supabaseRpc('api_attendance_rows', { teacher_key: teacherToken() });
  if (path === '/attendance' && method === 'POST') return supabaseRpc('api_save_attendance_entry', {
    teacher_key: teacherToken(),
    class_id: body.classId,
    record_type: body.recordType,
    lesson_index: body.lessonIndex,
    entry: body.entry || {}
  });
  {
    const fieldMatch = path.match(/^\/profile-fields\/([^/]+)$/);
    if (fieldMatch && method === 'DELETE') return supabaseRpc('api_delete_profile_field', { teacher_key: teacherToken(), field_id: fieldMatch[1] });
  }
  if (path === '/students/search' && method === 'POST') return supabaseRpc('api_search_students', { teacher_key: teacherToken(), query: body.query || '' });
  {
    const studentMatch = path.match(/^\/students\/([^/]+)\/(profile|regenerate-code|identity)$/);
    if (studentMatch && studentMatch[2] === 'profile' && method === 'GET') return supabaseRpc('api_student_profile', { teacher_key: teacherToken(), student_id: studentMatch[1] });
    if (studentMatch && studentMatch[2] === 'profile' && method === 'POST') return supabaseRpc('api_save_student_profile', { teacher_key: teacherToken(), student_id: studentMatch[1], data: body.data || {} });
    if (studentMatch && studentMatch[2] === 'regenerate-code' && method === 'POST') return supabaseRpc('api_regenerate_student_code', { teacher_key: teacherToken(), student_id: studentMatch[1] });
    if (studentMatch && studentMatch[2] === 'identity' && method === 'POST') return supabaseRpc('api_update_student_identity', {
      teacher_key: teacherToken(),
      student_id: studentMatch[1],
      new_name: body.name,
      new_dob: body.dob
    });
  }
  if (path === '/parent-lookup' && method === 'POST') return supabaseRpc('api_parent_lookup', { student_key: STUDENT_KEY, code: body.code || '' });

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
  if (action === 'set-current-slots') return supabaseRpc('api_set_current_slots', { teacher_key: teacherToken(), class_id, current_slots: body.currentSlots || [], final_subjects: body.finalSubjects || {} });
  if (action === 'schedule') {
    if (method === 'GET') return supabaseRpc('api_schedule_class', {
      teacher_key: teacherToken(),
      class_id,
      selected_week_start: body.weekStart || null
    });
    return supabaseRpc('api_save_schedule_week', {
      teacher_key: teacherToken(),
      class_id,
      week_start: body.weekStart,
      title: body.title,
      week_slots: body.slots || {},
      week_details: body.details || {},
      current_slots: body.currentSlots || [],
      sessions: body.sessions || [],
      lesson_starts: body.lessonStarts || {}
    });
  }
  if (action === 'schedule-meta' && method === 'POST') return supabaseRpc('api_save_schedule_extra_details', {
    teacher_key: teacherToken(), class_id, week_start: body.weekStart, details: body.details || {}
  });
  if (action === 'schedule-settings' && method === 'POST') return supabaseRpc('api_save_schedule_settings', {
    teacher_key: teacherToken(),
    class_id,
    course_kind: body.courseKind || 'skills',
    lesson_starts: body.lessonStarts || {}
  });
  if (action.startsWith('homeroom-sync/')) {
    const type = decodeURIComponent(action.split('/')[1] || '');
    return supabaseRpc('api_homeroom_schedule_sync', { teacher_key: teacherToken(), class_id, record_type: type });
  }
  if (action.startsWith('homeroom-record/')) {
    const type = decodeURIComponent(action.split('/')[1] || '');
    if (method === 'GET') return supabaseRpc('api_homeroom_record', { teacher_key: teacherToken(), class_id, record_type: type });
    return supabaseRpc('api_save_homeroom_record', {
      teacher_key: teacherToken(),
      class_id,
      record_type: type,
      cells: body.cells || {},
      styles: body.styles || {},
      lesson_count: body.lessonCount || 3
    });
  }
  if (action === 'add-student') return supabaseRpc('api_add_student', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob });
  if (action === 'approve') return supabaseRpc('api_set_submission_status', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob, status: 'approved' });
  if (action === 'reject') return supabaseRpc('api_delete_submission', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob });
  if (action === 'transfer-submission') return supabaseRpc('api_transfer_submission', { teacher_key: teacherToken(), class_id, student_name: body.studentName, dob: body.dob, target_class_ids: body.classIds || [] });
  if (action === 'manage-student') return supabaseRpc('api_update_student_profile_classes', { teacher_key: teacherToken(), class_id, old_student_name: body.oldStudentName, old_dob: body.oldDob, new_student_name: body.studentName, new_dob: body.dob, class_ids: body.classIds || [] });
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
      if (btn.dataset.tab !== 'schedule' && scheduleClassId) {
        scheduleClassId = null;
        scheduleEditorData = null;
        scheduleSelectedWeekStart = '';
        history.pushState({}, '', appBasePath());
      }
      if (btn.dataset.tab === 'archived') loadArchived();
      if (btn.dataset.tab === 'accounts') loadTeacherAccounts();
      if (btn.dataset.tab === 'schedule') loadScheduleHome();
      if (btn.dataset.tab === 'homeroom') renderHomeroomHome();
      if (btn.dataset.tab === 'profiles') renderProfilesHome();
      if (btn.dataset.tab === 'games') renderVocabGame();
      if (btn.dataset.tab === 'attendance') loadAttendance();
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
    clearTimeout(finalScheduleTimer);
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
    hideBulkSessionsPanel();
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
  $('#btn-open-bulk-sessions')?.addEventListener('click', () => showBulkSessionsPanel());
  $('#btn-close-bulk-sessions')?.addEventListener('click', () => hideBulkSessionsPanel());
  $('#btn-bulk-select-all')?.addEventListener('click', () => setBulkClassSelection(true));
  $('#btn-bulk-clear')?.addEventListener('click', () => setBulkClassSelection(false));
  $('#btn-bulk-save')?.addEventListener('click', saveBulkSessions);
  window.addEventListener('popstate', handleScheduleRoute);
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
    await Promise.all([loadClasses(), loadTeacherDirectory(), loadVocabCustomizations()]);
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
    loadTeacherDirectory();
    loadVocabCustomizations();
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
  if (session.role !== 'owner') hideBulkSessionsPanel();
  setSectorToolsVisible();
  $('#teacher-login')?.classList.add('hidden');
  $('#teacher-dashboard')?.classList.remove('hidden');
  if ($('#tab-attendance')?.classList.contains('active')) loadAttendance();
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
  if (!$('#bulk-sessions-panel')?.classList.contains('hidden')) renderBulkSessions();
  if ($('#tab-schedule')?.classList.contains('active')) renderScheduleHome();
  if ($('#tab-homeroom')?.classList.contains('active')) renderHomeroomHome();
  activateInitialScheduleRoute();
}

function showBulkSessionsPanel() {
  if (!isOwner()) return;
  $('#bulk-sessions-panel')?.classList.remove('hidden');
  renderBulkSessions();
  $('#bulk-sessions-input')?.focus();
}

function hideBulkSessionsPanel() {
  $('#bulk-sessions-panel')?.classList.add('hidden');
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
  const finalSubjects = cls.finalSubjects || {};
  const finalDetails = cls.finalDetails || {};
  const nameCounts = countNames([...approved, ...pending]);
  const canManage = canManageAssignedClass();
  const hasScheduleTable = approved.length > 0 || currentSlots.length > 0 || currentScheduleMode;
  let html = `<div class="detail-head"><div class="detail-title"><h3>${escapeHtml(cls.name)}</h3>`;
  if (canManage) {
    html += `<button id="btn-edit" class="btn-edit${editMode ? ' active' : ''}">${editMode ? '✓ Xong' : 'Chỉnh sửa'}</button>
      <button id="btn-current-schedule" class="btn-current${currentScheduleMode ? ' active' : ''}">${currentScheduleMode ? '✓ Lưu các ô lịch' : 'Chọn ô lịch'}</button>`;
  }
  if (hasScheduleTable) {
    html += '<button id="btn-copy-excel" class="btn-export" type="button">Copy Excel</button>';
    html += '<button id="btn-download-excel" class="btn-export btn-download-excel" type="button">T&#7843;i Excel</button>';
    html += '<button id="btn-copy-image" class="btn-export btn-export-image" type="button">In &#7842;nh</button>';
  }
  html += '</div></div>';
  if (editMode) html += '<p class="hint">Đang chỉnh sửa: tick/bỏ tick các ô rồi bấm Xong để lưu một lần.</p>';
  if (currentScheduleMode) html += '<p class="hint current-hint">Chỉ tick/bỏ tick các ô lớp học. Tên ca và nội dung S/W/LR/MT/FT được chỉnh trong tab <b>Lịch</b>.</p>';
  if (canManage && approved.length === 0 && !currentScheduleMode && currentSlots.length === 0) {
    html += '<p class="placeholder">Chưa có học sinh nào được duyệt.</p>';
    html += renderPendingBox(pending, nameCounts, sessions);
  } else {
    html += renderScheduleTable({ slots, sessions, submissions: approved, editable: editMode, showDelete: canManage && editMode, nameCounts, currentSlots, currentEditable: currentScheduleMode, finalSubjects, finalDetails, courseKind: cls.courseKind || 'skills' });
    if (canManage) html += renderPendingBox(pending, nameCounts, sessions);
    if (approved.length) html += renderRecommendation(slots, approved, currentSlots);
  }

  if (canManage && !editMode && !currentScheduleMode) {
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

  return html;
}

function renderPendingBox(pending, nameCounts, sessions = DEFAULT_SESSIONS) {
  let html = `<div class="pending-box pending-box-above-recommend"><h4>Ch\u1edd duy\u1ec7t (${pending.length})</h4>`;
  if (pending.length === 0) html += '<p class="placeholder">Kh\u00f4ng c\u00f3 \u0111\u0103ng k\u00fd m\u1edbi.</p>';
  pending.forEach((item) => {
    const key = encodeKey(item);
    const busyText = busySlotLabels(item.busySlots || [], sessions).join(', ') || 'Kh\u00f4ng tick bu\u1ed5i b\u1eadn';
    const timeText = formatDateTime(item.updatedAt || item.updated_at);
    const timeHtml = timeText ? `<small class="pending-time">G\u1eedi/c\u1eadp nh\u1eadt: ${escapeHtml(timeText)}</small>` : '';
    html += `<div class="pending-item-wrap">
      <div class="pending-item"><span class="pending-student-title"><b>${escapeHtml(displayName(item, nameCounts))}</b> <small>(${(item.busySlots || []).length} bu\u1ed5i b\u1eadn)</small>${timeHtml}</span>
        <span class="acts"><button class="btn-approve" data-key="${key}">Duy\u1ec7t</button><button class="btn-transfer" data-key="${key}">Chuy\u1ec3n</button><button class="btn-reject" data-key="${key}">Xo\u00e1</button><button class="btn-pending-toggle" data-key="${key}" title="Xem l\u1ecbch \u0111\u00e3 tick">\u25b8</button></span></div>
      <div class="pending-detail hidden" data-detail="${key}">
        <div class="pending-busy-summary">${escapeHtml(busyText)}</div>
        ${renderPendingScheduleTable(item, sessions)}
      </div>
    </div>`;
  });
  html += '</div>';
  return html;
}

function renderPendingScheduleTable(item, sessions = DEFAULT_SESSIONS) {
  const busy = new Set(item.busySlots || []);
  let html = '<div class="pending-schedule-scroll"><table class="pending-schedule-table"><thead><tr><th>Th\u1ee9</th>';
  sessions.forEach((session) => { html += `<th>${escapeHtml(session)}</th>`; });
  html += '</tr></thead><tbody>';
  DAYS.forEach((day, dayIdx) => {
    html += `<tr><th>${escapeHtml(DAYS_SHORT[dayIdx] || day)}</th>`;
    sessions.forEach((session, sessionIdx) => {
      const slotId = `${dayIdx}-${sessionIdx}`;
      const checked = busy.has(slotId);
      html += `<td class="${checked ? 'pending-busy-cell' : 'pending-free-cell'}">${checked ? '&times;' : '&middot;'}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function busySlotLabels(slotIds, sessions = DEFAULT_SESSIONS) {
  return [...(slotIds || [])].sort().map((slotId) => {
    const [dayIdx, sessionIdx] = String(slotId).split('-').map(Number);
    return `${DAYS_SHORT[dayIdx] || DAYS[dayIdx] || '?'} ${sessions?.[sessionIdx] || '?'}`;
  });
}

function otherClassSlotLabel(student, slotId) {
  const value = student?.otherClassSlots?.[slotId];
  if (Array.isArray(value)) return value.filter(Boolean).join('/');
  return value ? String(value) : '';
}

function isStudentUnavailable(student, slotId) {
  return (student.busySlots || []).includes(slotId) || Boolean(otherClassSlotLabel(student, slotId));
}

function currentScheduleCellHtml(slotId, finalSubjects = {}, finalDetails = {}, courseKind = 'skills') {
  const lesson = displayLessonLabel(finalSubjects[slotId] || '');
  const courseNo = String(finalDetails[slotId]?.courseNo || '').trim();
  if (!lesson && !courseNo) return '&middot;';
  return `<span class="current-course-cell">${courseNo ? `<b>${escapeHtml(courseNo)}</b>` : ''}${courseKind !== 'grammar' && lesson ? `<small>${escapeHtml(lesson)}</small>` : ''}</span>`;
}

function renderScheduleTable({ slots, sessions, submissions, editable, showDelete, nameCounts, studentLookup, currentSlots = [], currentEditable = false, finalSubjects = {}, finalDetails = {}, courseKind = 'skills' }) {
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
  html += '</tr>';
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
        const scheduleInfo = current ? currentScheduleCellHtml(slot.id, finalSubjects, finalDetails, courseKind) : '';
        html += `<td class="${slotClass(slot.id, 'current-picker')}" data-slot="${slot.id}"><label class="current-picker-content"><input type="checkbox" class="current-chk" data-slot="${slot.id}" ${current ? 'checked' : ''}>${scheduleInfo ? `<span>${scheduleInfo}</span>` : ''}</label></td>`;
      } else {
        html += `<td class="${slotClass(slot.id, current ? '' : 'free')}" data-slot="${slot.id}">${current ? currentScheduleCellHtml(slot.id, finalSubjects, finalDetails, courseKind) : '&middot;'}</td>`;
      }
    });
    html += '</tr>';
  }

  submissions.forEach((student, idx) => {
    const key = encodeKey(student);
    const canEdit = editable && (!studentLookup || student.canEdit);
    const studentActions = showDelete
      ? `<span class="student-row-actions"><button class="btn-del-stu" data-key="${key}" title="Xoá học sinh">&times;</button><button class="btn-manage-stu" data-key="${key}" data-classes="${escapeHtml((student.classIds || []).join(','))}" title="Quản lý học sinh">&#9881;</button></span>`
      : '';
    const submittedDate = formatDateTime(student.updatedAt || student.updated_at);
    const dateHtml = submittedDate ? `<small class="student-submit-date">(${escapeHtml(submittedDate)})</small>` : '';
    const codeHtml = student.code ? `<span class="student-code-chip" title="M&atilde; h&#7885;c sinh">${escapeHtml(student.code)}</span>` : '';
    html += `<tr><td>${idx + 1}</td><td class="name student-name-cell"><span class="student-name-wrap"><span class="student-name-main-row"><span class="student-name-text">${escapeHtml(displayName(student, nameCounts))}</span>${codeHtml}${studentActions}</span>${dateHtml}</span></td>`;
    slots.forEach((slot) => {
      const manualBusy = (student.busySlots || []).includes(slot.id);
      const otherClassLabel = otherClassSlotLabel(student, slot.id);
      const current = currentSlots.includes(slot.id);
      if (otherClassLabel) {
        const preserveManualBusy = canEdit && manualBusy
          ? `<input type="checkbox" class="busy-chk hidden" data-key="${key}" data-slot="${slot.id}" checked>`
          : '';
        html += `<td class="other-class-slot" data-slot="${slot.id}" title="Trung lich lop khac: ${escapeHtml(otherClassLabel)}">${escapeHtml(otherClassLabel)}${preserveManualBusy}</td>`;
      } else if (canEdit && !current) {
        const editBase = manualBusy ? 'cell-edit busy' : 'cell-edit';
        html += `<td class="${slotClass(slot.id, editBase)}" data-slot="${slot.id}"><input type="checkbox" class="busy-chk" data-key="${key}" data-slot="${slot.id}" ${manualBusy ? 'checked' : ''}></td>`;
      } else {
        html += current
          ? `<td class="current-slot" data-slot="${slot.id}" title="L\u1ecbch h\u1ecdc hi\u1ec7n t\u1ea1i">${currentScheduleCellHtml(slot.id, finalSubjects, finalDetails, courseKind)}</td>`
          : manualBusy ? `<td class="busy" data-slot="${slot.id}">&times;</td>` : `<td class="${slotClass(slot.id, 'free')}" data-slot="${slot.id}">&middot;</td>`;
      }
    });
    html += '</tr>';
  });

  if (!studentLookup) {
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
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function countBusy(slots, submissions) {
  const busyCount = {};
  slots.forEach((slot) => busyCount[slot.id] = 0);
  submissions.forEach((student) => {
    slots.forEach((slot) => {
      if (busyCount[slot.id] !== undefined && isStudentUnavailable(student, slot.id)) busyCount[slot.id]++;
    });
  });
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

function measureExportText(value, font = '700 13px Arial, sans-serif') {
  const canvas = measureExportText.canvas || (measureExportText.canvas = document.createElement('canvas'));
  const context = canvas.getContext('2d');
  if (!context) return String(value || '').length * 7.5;
  context.font = font;
  return context.measureText(String(value || '')).width;
}

function fitExportColumnWidths(table) {
  const bodyRows = [...(table.tBodies[0]?.rows || [])];
  if (table.classList.contains('week-planner')) {
    const columnCount = Math.max(1, ...bodyRows.map((row) => row.cells.length));
    const sessionRow = [...(table.tHead?.rows || [])].find((row) => row.querySelector('.planner-session-label'));
    const widths = Array.from({ length: columnCount }, (_, index) => {
      const values = bodyRows.map((row) => row.cells[index]?.textContent.trim().replace(/\s+/g, ' ') || '');
      const session = sessionRow?.cells[index]?.textContent.trim() || '';
      return Math.ceil(Math.min(180, Math.max(78, measureExportText(session) + 18, ...values.map((value) => measureExportText(value) + 18))));
    });
    const colgroup = document.createElement('colgroup');
    widths.forEach((width) => {
      const col = document.createElement('col');
      col.style.cssText = `width:${width}px;min-width:${width}px;max-width:${width}px;`;
      col.setAttribute('width', String(width));
      colgroup.appendChild(col);
    });
    table.insertBefore(colgroup, table.firstChild);
    table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    table.style.minWidth = '0';
    table.style.tableLayout = 'fixed';
    return;
  }
  const columnCount = Math.max(2, ...bodyRows.map((row) => row.cells.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const values = bodyRows.map((row) => {
      const cell = row.cells[columnIndex];
      if (!cell) return '';
      const dateEl = cell.querySelector('.student-submit-date');
      if (!dateEl) return cell.textContent.trim();
      const nameText = cell.querySelector('.student-name-text')?.textContent.trim() || '';
      const dateText = dateEl.textContent.trim();
      return nameText.length >= dateText.length ? nameText : dateText;
    });
    if (columnIndex === 0) values.push('STT');
    if (columnIndex === 1) values.push(table.tHead?.rows[0]?.cells[1]?.textContent.trim() || 'H\u1ecdc sinh');
    if (columnIndex >= 2) {
      const sessionHeader = table.tHead?.rows[1]?.cells[columnIndex - 2];
      if (sessionHeader) values.push(sessionHeader.textContent.trim());
    }
    let contentWidth = Math.max(0, ...values.map((value) => measureExportText(value)));
    if (columnIndex === 1 && table.tHead?.rows[0]?.cells[1]?.classList.contains('image-class-title')) {
      contentWidth = Math.max(contentWidth, measureExportText(table.tHead.rows[0].cells[1].textContent.trim(), '900 16px Arial, sans-serif'));
    }
    if (columnIndex === 0) return Math.ceil(Math.max(36, contentWidth + 12));
    if (columnIndex === 1) {
      const longestLength = Math.max(0, ...values.map((value) => [...String(value)].length));
      return Math.ceil(Math.max(130, contentWidth + 30, (longestLength * 8.5) + 28));
    }
    return Math.ceil(Math.max(28, contentWidth + 12));
  });

  let logicalColumn = 2;
  [...(table.tHead?.rows[0]?.cells || [])].slice(2).forEach((dayCell) => {
    const span = Number(dayCell.colSpan || 1);
    const required = measureExportText(dayCell.textContent.trim()) + 20;
    const current = widths.slice(logicalColumn, logicalColumn + span).reduce((sum, width) => sum + width, 0);
    if (required > current && span > 0) {
      const extra = Math.ceil((required - current) / span);
      for (let index = logicalColumn; index < logicalColumn + span; index++) widths[index] += extra;
    }
    logicalColumn += span;
  });

  const colgroup = document.createElement('colgroup');
  widths.forEach((width) => {
    const col = document.createElement('col');
    col.style.cssText = `width:${width}px;min-width:${width}px;max-width:${width}px;mso-width-source:userset;mso-width-alt:${Math.round(width * 48)};`;
    col.setAttribute('width', String(width));
    colgroup.appendChild(col);
  });
  table.insertBefore(colgroup, table.firstChild);
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  table.style.width = `${tableWidth}px`;
  table.style.minWidth = '0';
  table.style.tableLayout = 'fixed';
  table.setAttribute('width', String(tableWidth));

  const applyWidth = (cell, width) => {
    if (!cell || !width) return;
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.style.maxWidth = `${width}px`;
    cell.style.setProperty('mso-width-source', 'userset');
    cell.style.setProperty('mso-width-alt', String(Math.round(width * 48)));
    cell.setAttribute('width', String(width));
  };

  bodyRows.forEach((row) => [...row.cells].forEach((cell, index) => {
    applyWidth(cell, widths[index]);
  }));
  const firstHeaderRow = table.tHead?.rows[0];
  applyWidth(firstHeaderRow?.cells[0], widths[0]);
  applyWidth(firstHeaderRow?.cells[1], widths[1]);
  let dayColumn = 2;
  [...(firstHeaderRow?.cells || [])].slice(2).forEach((cell) => {
    const span = Number(cell.colSpan || 1);
    applyWidth(cell, widths.slice(dayColumn, dayColumn + span).reduce((sum, width) => sum + width, 0));
    dayColumn += span;
  });
  [...(table.tHead?.rows[1]?.cells || [])].forEach((cell, index) => {
    applyWidth(cell, widths[index + 2]);
  });
}

const IMAGE_DAY_COLORS = {
  blue: '#16afe5',
  yellow: '#ffc20e',
  green: '#8bd34a'
};

function colorDistance(first, second) {
  const parse = (value) => {
    const hex = String(value || '').replace('#', '');
    return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) || 0);
  };
  const a = parse(first);
  const b = parse(second);
  return Math.sqrt(a.reduce((sum, channel, index) => sum + ((channel - b[index]) ** 2), 0));
}

function automaticDayColor(classColor) {
  return Object.values(IMAGE_DAY_COLORS)
    .sort((first, second) => colorDistance(second, classColor) - colorDistance(first, classColor))[0];
}

function compactPlannerForImage(table) {
  if (!table.classList.contains('week-planner')) return;
  const bodyRows = [...(table.tBodies[0]?.rows || [])];
  const sessionRow = table.tHead?.rows[1];
  const dayRow = table.tHead?.rows[0];
  if (!bodyRows.length || !sessionRow || !dayRow) return;

  const sourceCells = [...bodyRows[0].cells];
  const keepColumns = sourceCells.map((cell) => cell.classList.contains('current-slot'));
  if (!keepColumns.some(Boolean) || keepColumns.every(Boolean)) return;

  bodyRows.forEach((row) => {
    [...row.cells].forEach((cell, index) => {
      if (!keepColumns[index]) cell.remove();
    });
  });
  [...sessionRow.cells].forEach((cell, index) => {
    if (!keepColumns[index]) cell.remove();
  });

  let offset = 0;
  [...dayRow.cells].forEach((dayCell) => {
    const originalSpan = Number(dayCell.colSpan || 1);
    const keptInDay = keepColumns.slice(offset, offset + originalSpan).filter(Boolean).length;
    offset += originalSpan;
    if (!keptInDay) dayCell.remove();
    else dayCell.colSpan = keptInDay;
  });
  table.classList.add('image-compacted');
}

function exportPrintTimestampLabel() {
  return `In lúc ${formatDateTime(Date.now())}`;
}

function buildLightExportTable(sourceTable, imageTitleOptions = null, exportOptions = {}) {
  const table = sourceTable.cloneNode(true);
  table.querySelectorAll('.schedule-actions').forEach((cell) => cell.remove());
  table.querySelectorAll('.student-row-actions').forEach((actions) => actions.remove());
  table.querySelectorAll('.student-code-chip').forEach((chip) => chip.remove());
  table.querySelectorAll('.slot-edit-btn').forEach((button) => button.remove());
  if (!exportOptions.printTimestamp) table.querySelectorAll('.student-submit-date').forEach((el) => el.remove());
  if (exportOptions.printTimestamp) {
    const currentLabel = table.querySelector('tr.current-row td.name');
    if (currentLabel) {
      currentLabel.textContent = exportPrintTimestampLabel();
      currentLabel.classList.add('image-day-title');
    }
  }
  if (exportOptions.compactPlanner) compactPlannerForImage(table);
  const isPlanner = table.classList.contains('week-planner');
  const studentHeader = table.tHead?.rows[0]?.cells[1];
  if (studentHeader && imageTitleOptions && !isPlanner) {
    studentHeader.textContent = imageTitleOptions.className;
    studentHeader.classList.add('image-class-title');
    [...(table.tHead?.rows[0]?.cells || [])].slice(2).forEach((cell) => cell.classList.add('image-day-title'));
  } else if (imageTitleOptions && isPlanner) {
    const dayRow = table.tHead?.rows[0];
    [...(dayRow?.cells || [])].forEach((cell) => cell.classList.add('image-day-title'));
    const titleRow = table.tHead.insertRow(0);
    const titleCell = document.createElement('th');
    titleRow.appendChild(titleCell);
    titleCell.colSpan = Math.max(1, table.tBodies[0]?.rows[0]?.cells.length || 1);
    titleCell.textContent = imageTitleOptions.className;
    titleCell.className = 'image-class-title planner-export-title';
  }
  table.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const mark = document.createTextNode(input.checked ? (input.classList.contains('current-chk') ? '\u25cf' : '\u00d7') : '\u00b7');
    input.replaceWith(mark);
  });
  table.style.cssText = 'border-collapse:collapse;border-spacing:0;width:max-content;min-width:100%;font:13px Arial,sans-serif;color:#111827;background:#ffffff;';
  table.querySelectorAll('th,td').forEach((cell) => {
    let background = '#ffffff';
    let color = '#111827';
    let weight = cell.tagName === 'TH' || cell.closest('tr')?.classList.contains('summary') ? '700' : '400';
    let fontSize = '13px';
    let textShadow = 'none';
    if (cell.tagName === 'TH') background = '#fafbfe';
    if (cell.closest('tr')?.classList.contains('summary')) background = '#f3f4f6';
    if (cell.classList.contains('zero-slot') || cell.classList.contains('best')) {
      background = '#d1fae5'; color = '#065f46'; weight = '700';
    }
    if (cell.classList.contains('busy')) {
      background = '#fee2e2'; color = '#b91c1c'; weight = '700';
    }
    if (cell.classList.contains('other-class-slot')) {
      background = '#2563eb'; color = '#ffffff'; weight = '900';
    }
    if (cell.classList.contains('worst')) color = '#b91c1c';
    if (cell.classList.contains('current-slot')) {
      background = '#fdfd0a'; color = '#3f3f00'; weight = '700';
    }
    if (cell.classList.contains('image-class-title') && imageTitleOptions) {
      background = imageTitleOptions.backgroundColor;
      color = imageTitleOptions.textColor;
      weight = '900';
      fontSize = '16px';
      textShadow = '0 1px 0 rgba(255,255,255,.35), 0 2px 3px rgba(0,0,0,.22)';
    }
    if (cell.classList.contains('image-day-title') && imageTitleOptions) {
      background = imageTitleOptions.dayColor;
      color = '#111827';
      weight = '900';
      fontSize = '14px';
    }
    if (cell.classList.contains('free') && !cell.classList.contains('zero-slot')) color = '#d1d5db';
    cell.style.cssText = `box-sizing:border-box;border:1px solid #d1d5db;padding:7px 9px;text-align:${cell.classList.contains('name') ? 'left' : 'center'};vertical-align:middle;background:${background};color:${color};font-size:${fontSize};font-weight:${weight};text-shadow:${textShadow};white-space:${isPlanner ? 'normal' : 'nowrap'};`;
  });
  fitExportColumnWidths(table);
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

function showCopiedUrl(button) {
  if (!button) return;
  button.classList.add('copy-confirmed');
  setExportButtonStatus(button, '✓ Đã copy URL');
  clearTimeout(Number(button.dataset.copyClassTimer || 0));
  button.dataset.copyClassTimer = String(setTimeout(() => {
    button.classList.remove('copy-confirmed');
  }, 2600));
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

async function copyScheduleToExcel(detail, button, titleOptions) {
  const source = detail.querySelector('table.schedule');
  if (!source) return;
  const table = buildLightExportTable(source, titleOptions);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><style>table{border-collapse:collapse;table-layout:fixed}col,td,th{mso-width-source:userset;white-space:nowrap}</style></head><body>${table.outerHTML}</body></html>`;
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

let excelJsLoader = null;

function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (excelJsLoader) return excelJsLoader;
  excelJsLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/exceljs.min.js';
    script.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('Kh\u00f4ng n\u1ea1p \u0111\u01b0\u1ee3c ExcelJS.'));
    script.onerror = () => reject(new Error('Kh\u00f4ng n\u1ea1p \u0111\u01b0\u1ee3c th\u01b0 vi\u1ec7n t\u1ea1o Excel.'));
    document.head.appendChild(script);
  });
  return excelJsLoader;
}

function excelArgb(value, fallback = 'FF111827') {
  const raw = String(value || '').trim();
  const shortHex = raw.match(/^#([0-9a-f]{3})$/i);
  if (shortHex) return `FF${[...shortHex[1]].map((char) => char + char).join('').toUpperCase()}`;
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) return `FF${hex[1].toUpperCase()}`;
  const rgb = raw.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
  if (rgb) return `FF${rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return fallback;
}

async function downloadScheduleExcel(detail, button, titleOptions) {
  const source = detail.querySelector('table.schedule');
  if (!source) return;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.disabled = true;
  button.textContent = '\u0110ang t\u1ea1o file...';
  try {
    const ExcelJS = await loadExcelJs();
    const table = buildLightExportTable(source, titleOptions);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Olympus English';
    const sheetName = titleOptions.className.replace(/[\\/*?:[\]]/g, '-').slice(0, 31) || 'Lich lop';
    const worksheet = workbook.addWorksheet(sheetName, {
      views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });

    const columns = [...(table.querySelector('colgroup')?.children || [])];
    columns.forEach((col, index) => {
      const pixels = Number.parseFloat(col.style.width) || Number(col.getAttribute('width')) || 40;
      worksheet.getColumn(index + 1).width = Math.max(3.5, (pixels - 5) / 7);
    });

    const occupied = new Set();
    [...table.rows].forEach((row, rowIndex) => {
      const excelRow = rowIndex + 1;
      worksheet.getRow(excelRow).height = table.classList.contains('week-planner')
        ? rowIndex < 3 ? 24 : 44
        : rowIndex < 2 ? 24 : 21;
      let excelColumn = 1;
      [...row.cells].forEach((htmlCell) => {
        while (occupied.has(`${excelRow}:${excelColumn}`)) excelColumn++;
        const rowSpan = Number(htmlCell.rowSpan || 1);
        const colSpan = Number(htmlCell.colSpan || 1);
        const excelCell = worksheet.getCell(excelRow, excelColumn);
        excelCell.value = htmlCell.textContent.trim().replace(/\s+/g, ' ');
        const background = excelArgb(htmlCell.style.backgroundColor, 'FFFFFFFF');
        const foreground = excelArgb(htmlCell.style.color, 'FF111827');
        excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: background } };
        excelCell.font = {
          name: 'Arial',
          size: Number.parseFloat(htmlCell.style.fontSize) || 13,
          bold: Number.parseInt(htmlCell.style.fontWeight, 10) >= 600,
          color: { argb: foreground }
        };
        excelCell.alignment = {
          horizontal: htmlCell.style.textAlign === 'left' ? 'left' : 'center',
          vertical: 'middle',
          wrapText: table.classList.contains('week-planner')
        };
        excelCell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } }
        };
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
          for (let colOffset = 0; colOffset < colSpan; colOffset++) {
            occupied.add(`${excelRow + rowOffset}:${excelColumn + colOffset}`);
          }
        }
        if (rowSpan > 1 || colSpan > 1) {
          worksheet.mergeCells(excelRow, excelColumn, excelRow + rowSpan - 1, excelColumn + colSpan - 1);
        }
        excelColumn += colSpan;
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${titleOptions.className.replace(/[\\/:*?"<>|]/g, '-').trim() || 'lich-lop'}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 t\u1ea3i Excel');
  } catch (err) {
    setExportButtonStatus(button, 'T\u1ea1o Excel l\u1ed7i', true);
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Kh\u00f4ng t\u1ea1o \u0111\u01b0\u1ee3c \u1ea3nh.')),
    type,
    quality
  ));
}

async function renderScheduleImage(source, titleOptions) {
  const table = buildLightExportTable(source, titleOptions, { compactPlanner: true, printTimestamp: true });
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:max-content;background:#fff;z-index:-1;';
  stage.appendChild(table);
  document.body.appendChild(stage);
  await document.fonts?.ready;
  stage.style.width = `${table.getBoundingClientRect().width}px`;
  const stageRect = stage.getBoundingClientRect();
  const width = Math.ceil(stageRect.width);
  const height = Math.ceil(stageRect.height);
  const maxPixels = 45000000;
  const scale = Math.min(3, Math.sqrt(maxPixels / Math.max(1, width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  table.querySelectorAll('th,td').forEach((cell) => {
    const rect = cell.getBoundingClientRect();
    const x = rect.left - stageRect.left;
    const y = rect.top - stageRect.top;
    const style = getComputedStyle(cell);
    context.fillStyle = style.backgroundColor || '#ffffff';
    context.fillRect(x, y, rect.width, rect.height);
    context.strokeStyle = '#d1d5db';
    context.lineWidth = 1;
    context.strokeRect(x + .5, y + .5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1));
    if (cell.classList.contains('week-slot')) {
      const lines = [
        cell.querySelector('.slot-lesson')?.textContent.trim(),
        cell.querySelector('.slot-location')?.textContent.trim(),
        cell.querySelector('.slot-note')?.textContent.trim()
      ].filter(Boolean);
      if (!lines.length) return;
      context.save();
      context.beginPath();
      context.rect(x + 3, y + 3, Math.max(0, rect.width - 6), Math.max(0, rect.height - 6));
      context.clip();
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const lineHeight = Math.min(16, Math.max(11, (rect.height - 10) / lines.length));
      const startY = y + rect.height / 2 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, index) => {
        context.fillStyle = index === 0 ? '#3f3f00' : '#52525b';
        context.font = `${index === 0 ? '700 14px' : '600 10px'} Arial, sans-serif`;
        context.fillText(line, x + rect.width / 2, startY + index * lineHeight, Math.max(0, rect.width - 10));
      });
      context.restore();
      return;
    }
    const submitDate = cell.querySelector('.student-submit-date');
    if (submitDate) {
      const nameText = (cell.querySelector('.student-name-text')?.textContent || cell.textContent.replace(submitDate.textContent, '')).trim().replace(/\s+/g, ' ');
      const dateText = submitDate.textContent.trim().replace(/\s+/g, ' ');
      context.save();
      context.beginPath();
      context.rect(x + 2, y + 2, Math.max(0, rect.width - 4), Math.max(0, rect.height - 4));
      context.clip();
      context.textBaseline = 'middle';
      context.textAlign = 'left';
      context.fillStyle = style.color || '#111827';
      context.font = '700 13px Arial, sans-serif';
      context.fillText(nameText, x + 9, y + rect.height / 2 - 8, Math.max(0, rect.width - 12));
      if (dateText) {
        context.fillStyle = '#6b7280';
        context.font = '400 11px Arial, sans-serif';
        context.fillText(dateText, x + 9, y + rect.height / 2 + 9, Math.max(0, rect.width - 12));
      }
      context.restore();
      return;
    }
    const value = cell.textContent.trim().replace(/\s+/g, ' ');
    if (!value) return;
    context.save();
    context.beginPath();
    context.rect(x + 2, y + 2, Math.max(0, rect.width - 4), Math.max(0, rect.height - 4));
    context.clip();
    context.fillStyle = style.color || '#111827';
    context.font = `${style.fontWeight || '400'} ${style.fontSize || '13px'} Arial, sans-serif`;
    if (cell.classList.contains('image-class-title')) {
      context.shadowColor = 'rgba(0,0,0,.28)';
      context.shadowBlur = 2;
      context.shadowOffsetY = 1;
    }
    context.textBaseline = 'middle';
    context.textAlign = cell.classList.contains('name') ? 'left' : 'center';
    const textX = cell.classList.contains('name') ? x + 9 : x + rect.width / 2;
    context.fillText(value, textX, y + rect.height / 2, Math.max(0, rect.width - 12));
    context.restore();
  });
  stage.remove();
  return canvas;
}

async function copyScheduleAsImage(detail, button, titleOptions) {
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
    const canvas = await renderScheduleImage(source, titleOptions);
    const png = await canvasBlob(canvas, 'image/png');
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    } catch (pngError) {
      const jpeg = await canvasBlob(canvas, 'image/jpeg', .98);
      await navigator.clipboard.write([new ClipboardItem({ 'image/jpeg': jpeg })]);
    }
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 copy \u1ea3nh');
  } catch (err) {
    setExportButtonStatus(button, 'T\u1ea1o \u1ea3nh l\u1ed7i', true);
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

function openExportStyleDialog(detail, button, exportType) {
  document.querySelector('.image-export-overlay')?.remove();
  const isExcel = exportType === 'excel';
  const isExcelDownload = exportType === 'xlsx';
  const exportName = isExcelDownload ? 'file Excel' : isExcel ? 'Excel' : '&#7843;nh';
  const plannerExport = Boolean(detail.querySelector('table.week-planner'));
  const className = detail.querySelector('.detail-title h3, .planner-topbar h2')?.textContent.trim() || 'L\u1ecbch l\u1edbp';
  const presets = {
    orange: { backgroundColor: '#f59e0b', textColor: '#111827' },
    blue: { backgroundColor: '#2563eb', textColor: '#ffffff' },
    green: { backgroundColor: '#22c55e', textColor: '#111827' }
  };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lichlop-image-title-colors') || '{}'); } catch (err) { saved = {}; }
  const initialPreset = presets[saved.preset] ? saved.preset : 'orange';
  const initial = presets[initialPreset];
  const overlay = document.createElement('div');
  overlay.className = 'image-export-overlay';
  overlay.innerHTML = `
    <div class="image-export-dialog" role="dialog" aria-modal="true" aria-label="T&#249;y ch&#7881;nh ${exportName}">
      <h3>T&#249;y ch&#7881;nh ${exportName}</h3>
      <p class="hint">${plannerExport
        ? `Ch&#7885;n m&#224;u ti&#234;u &#273;&#7873; ng&#224;y khi ${isExcelDownload ? 't&#7843;i file Excel' : isExcel ? 'copy Excel' : 'xu&#7845;t &#7843;nh'}.${!isExcel && !isExcelDownload ? ' C&#225;c c&#7897;t ca ho&#224;n to&#224;n tr&#7889;ng s&#7869; t&#7921; &#273;&#7897;ng &#273;&#432;&#7907;c c&#7855;t b&#7887;.' : ''}`
        : `Khi ${isExcelDownload ? 't&#7843;i file Excel' : isExcel ? 'copy Excel' : 'xu&#7845;t &#7843;nh'}, &#244; H&#7885;c sinh s&#7869; hi&#7875;n th&#7883; t&#234;n l&#7899;p v&#7899;i m&#224;u &#273;&#227; ch&#7885;n.`}</p>
      <label>M&#7851;u m&#224;u
        <select class="image-color-preset">
          <option value="orange">Cam / &#273;en</option>
          <option value="blue">Xanh d&#432;&#417;ng / tr&#7855;ng</option>
          <option value="green">Xanh l&#225; / &#273;en</option>
          <option value="custom">T&#249;y ch&#7881;nh</option>
        </select>
      </label>
      <div class="image-color-fields">
        <label>M&#224;u n&#7873;n<input class="image-bg-color" type="color" /></label>
        <label>M&#224;u ch&#7919;<input class="image-text-color" type="color" /></label>
      </div>
      <label>M&#224;u c&#225;c &#244; Th&#7913;
        <select class="image-day-color">
          <option value="auto">T&#7921; &#273;&#7897;ng ch&#7885;n m&#224;u kh&#225;c &#244; l&#7899;p</option>
          <option value="blue">Xanh d&#432;&#417;ng</option>
          <option value="yellow">V&#224;ng</option>
          <option value="green">Xanh l&#225;</option>
        </select>
      </label>
      <div class="image-title-preview"></div>
      <div class="image-day-preview">Th&#7913; Hai &middot; Th&#7913; Ba &middot; Th&#7913; T&#432;</div>
      <div class="image-export-actions">
        <button class="image-export-cancel" type="button">H&#7911;y</button>
        <button class="image-export-confirm primary" type="button">${isExcelDownload ? 'T&#7843;i Excel' : isExcel ? 'Copy Excel' : 'Copy &#7843;nh'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const presetSelect = overlay.querySelector('.image-color-preset');
  const bgInput = overlay.querySelector('.image-bg-color');
  const textInput = overlay.querySelector('.image-text-color');
  const dayColorSelect = overlay.querySelector('.image-day-color');
  const preview = overlay.querySelector('.image-title-preview');
  const dayPreview = overlay.querySelector('.image-day-preview');
  presetSelect.value = saved.preset || initialPreset;
  bgInput.value = saved.backgroundColor || initial.backgroundColor;
  textInput.value = saved.textColor || initial.textColor;
  dayColorSelect.value = saved.dayColorChoice && (saved.dayColorChoice === 'auto' || IMAGE_DAY_COLORS[saved.dayColorChoice])
    ? saved.dayColorChoice
    : 'auto';

  const updatePreview = () => {
    preview.textContent = className;
    preview.style.backgroundColor = bgInput.value;
    preview.style.color = textInput.value;
    const dayColor = dayColorSelect.value === 'auto'
      ? automaticDayColor(bgInput.value)
      : IMAGE_DAY_COLORS[dayColorSelect.value];
    dayPreview.style.backgroundColor = dayColor;
    dayPreview.style.color = '#111827';
  };
  presetSelect.addEventListener('change', () => {
    const colors = presets[presetSelect.value];
    if (colors) {
      bgInput.value = colors.backgroundColor;
      textInput.value = colors.textColor;
    }
    updatePreview();
  });
  [bgInput, textInput].forEach((input) => input.addEventListener('input', () => {
    presetSelect.value = 'custom';
    updatePreview();
  }));
  dayColorSelect.addEventListener('change', updatePreview);
  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  };
  const onKeydown = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeydown);
  overlay.querySelector('.image-export-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.image-export-confirm').addEventListener('click', async () => {
    const dayColorChoice = dayColorSelect.value;
    const options = {
      className,
      backgroundColor: bgInput.value,
      textColor: textInput.value,
      dayColor: dayColorChoice === 'auto' ? automaticDayColor(bgInput.value) : IMAGE_DAY_COLORS[dayColorChoice]
    };
    try { localStorage.setItem('lichlop-image-title-colors', JSON.stringify({ preset: presetSelect.value, dayColorChoice, ...options })); } catch (err) { /* Continue without persistence. */ }
    close();
    if (isExcelDownload) await downloadScheduleExcel(detail, button, options);
    else if (isExcel) await copyScheduleToExcel(detail, button, options);
    else await copyScheduleAsImage(detail, button, options);
  });
  updatePreview();
  presetSelect.focus();
}

function wireTeacherClassEvents(id, detail) {
  setupDobInput($('#teacher-new-dob'));
  detail.querySelector('#btn-copy-excel')?.addEventListener('click', (event) => openExportStyleDialog(detail, event.currentTarget, 'excel'));
  detail.querySelector('#btn-download-excel')?.addEventListener('click', (event) => openExportStyleDialog(detail, event.currentTarget, 'xlsx'));
  detail.querySelector('#btn-copy-image')?.addEventListener('click', (event) => openExportStyleDialog(detail, event.currentTarget, 'image'));

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
    const studentName = normalizeStudentNameInput($('#teacher-new-student'));
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

  detail.querySelectorAll('.btn-manage-stu').forEach((button) => {
    button.addEventListener('click', () => {
      const student = decodeKey(button.dataset.key);
      const classIds = String(button.dataset.classes || id).split(',').filter(Boolean);
      openStudentManageDialog(id, student, classIds);
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

  detail.querySelectorAll('.btn-transfer').forEach((button) => {
    button.addEventListener('click', () => openTransferDialog(id, decodeKey(button.dataset.key)));
  });

  detail.querySelectorAll('.btn-pending-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const detailBox = detail.querySelector(`.pending-detail[data-detail="${CSS.escape(button.dataset.key)}"]`);
      detailBox?.classList.toggle('hidden');
      button.textContent = detailBox?.classList.contains('hidden') ? '▸' : '▾';
    });
  });
}

function closeMiniDialog() {
  document.querySelector('.mini-dialog-backdrop')?.remove();
}

function openMiniDialog(title, bodyHtml, onSave) {
  closeMiniDialog();
  const overlay = document.createElement('div');
  overlay.className = 'mini-dialog-backdrop';
  overlay.innerHTML = `<div class="mini-dialog">
    <div class="mini-dialog-head"><h3>${escapeHtml(title)}</h3><button type="button" class="mini-dialog-close">&times;</button></div>
    <div class="mini-dialog-body">${bodyHtml}</div>
    <div class="mini-dialog-actions"><button type="button" class="mini-cancel">Hủy</button><button type="button" class="mini-save primary">Lưu</button></div>
    <p class="msg mini-msg"></p>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeMiniDialog(); });
  overlay.querySelector('.mini-dialog-close')?.addEventListener('click', closeMiniDialog);
  overlay.querySelector('.mini-cancel')?.addEventListener('click', closeMiniDialog);
  overlay.querySelector('.mini-save')?.addEventListener('click', async () => {
    const button = overlay.querySelector('.mini-save');
    const msg = overlay.querySelector('.mini-msg');
    try {
      button.disabled = true;
      showMsg(msg, 'Đang lưu...', '');
      await onSave(overlay);
      closeMiniDialog();
    } catch (err) {
      button.disabled = false;
      showMsg(msg, err.message, 'err');
    }
  });
  return overlay;
}

function classChecklistHtml(selectedIds = [], excludeId = '') {
  const selected = new Set(selectedIds.map(String));
  const groups = buildSectorGroups(teacherClasses.filter((cls) => cls.id !== excludeId));
  return `<div class="mini-class-list">${groups.map((group) => `
    <section class="mini-class-sector">
      <h4>${escapeHtml(group.name)}</h4>
      ${group.classes.map((cls) => `<label class="mini-class-check"><input type="checkbox" value="${escapeHtml(cls.id)}" ${selected.has(cls.id) ? 'checked' : ''}> ${escapeHtml(cls.name)}</label>`).join('')}
    </section>`).join('')}</div>`;
}

function selectedDialogClassIds(overlay) {
  return [...overlay.querySelectorAll('.mini-class-check input:checked')].map((input) => input.value);
}

function openTransferDialog(classId, student) {
  openMiniDialog(
    `Chuyển ${student.studentName}`,
    `<p class="hint">Tick lớp đúng để chuyển phiếu chờ duyệt sang lớp đó. Phiếu ở lớp hiện tại sẽ được gỡ.</p>${classChecklistHtml([], classId)}`,
    async (overlay) => {
      const classIds = selectedDialogClassIds(overlay);
      if (!classIds.length) throw new Error('Chọn ít nhất 1 lớp để chuyển');
      await api(`/classes/${classId}/transfer-submission`, { method: 'POST', body: JSON.stringify({ ...student, classIds }) });
      await loadClasses();
      await refreshTeacherView(classId);
    }
  );
}

function openStudentManageDialog(classId, student, classIds) {
  const dobText = formatDobInputValue(student.dob);
  openMiniDialog(
    `Quản lý học sinh`,
    `<label>Họ tên<input id="mini-student-name" type="text" value="${escapeHtml(student.studentName)}"></label>
     <label>Ngày sinh<input id="mini-student-dob" type="text" value="${escapeHtml(dobText)}" placeholder="dd/mm/yyyy" inputmode="numeric" maxlength="10"></label>
     <p class="hint">Tick/detick lớp để chuyển học sinh giữa các lớp. Lớp mới sẽ nhận học sinh ở trạng thái đã duyệt.</p>
     ${classChecklistHtml(classIds)}`,
    async (overlay) => {
      const nameInput = overlay.querySelector('#mini-student-name');
      const dobInput = overlay.querySelector('#mini-student-dob');
      const name = normalizeStudentNameInput(nameInput);
      const dob = normalizeDob(dobInput?.value);
      const selectedClassIds = selectedDialogClassIds(overlay);
      if (!name || !dob) throw new Error('Nhập họ tên và ngày sinh');
      if (!selectedClassIds.length) throw new Error('Chọn ít nhất 1 lớp');
      await api(`/classes/${classId}/manage-student`, { method: 'POST', body: JSON.stringify({ oldStudentName: student.studentName, oldDob: student.dob, studentName: name, dob, classIds: selectedClassIds }) });
      await loadClasses();
      await refreshTeacherView(classId);
    }
  );
  setupDobInput(document.querySelector('#mini-student-dob'));
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
    if (!confirm('Xoa vinh vien tat ca lop cu va yeu cau duyet da xoa? Khong the khoi phuc.')) return;
    await Promise.all([
      api('/archived-classes', { method: 'DELETE' }),
      api('/deleted-submissions', { method: 'DELETE' })
    ]);
    loadArchived();
  });
}

async function loadArchived() {
  const classListEl = $('#archived-list');
  const deletedListEl = $('#deleted-submission-list');
  if (!classListEl) return;
  classListEl.innerHTML = '<li class="placeholder">Dang tai...</li>';
  if (deletedListEl) deletedListEl.innerHTML = '<li class="placeholder">Dang tai...</li>';
  try {
    const [classes, deleted] = await Promise.all([
      api('/archived-classes'),
      api('/deleted-submissions')
    ]);
    renderArchivedClasses(sortClasses(classes || []));
    renderDeletedSubmissions(deleted || []);
    const total = (classes || []).length + (deleted || []).length;
    if ($('#btn-clear-archived')) $('#btn-clear-archived').style.display = total ? '' : 'none';
  } catch (err) {
    classListEl.innerHTML = `<li class="placeholder">${escapeHtml(err.message)}</li>`;
    if (deletedListEl) deletedListEl.innerHTML = '';
  }
}

function renderArchivedClasses(list) {
  const ul = $('#archived-list');
  if (!ul) return;
  ul.innerHTML = '';
  if (list.length === 0) {
    ul.innerHTML = '<li class="placeholder">Chua co lop cu.</li>';
    return;
  }
  list.forEach((cls) => {
    const li = document.createElement('li');
    li.className = 'archived-item';
    li.innerHTML = `<span>${escapeHtml(cls.name)} <small>(${cls.approvedCount} hoc sinh)</small></span>
      <span class="acts"><button class="btn-approve" data-id="${cls.id}">Khoi phuc</button><button class="btn-reject" data-id="${cls.id}">Xoa vinh vien</button></span>`;
    li.querySelector('.btn-approve')?.addEventListener('click', async () => {
      await api(`/classes/${cls.id}/restore`, { method: 'POST' });
      loadArchived();
      loadClasses();
    });
    li.querySelector('.btn-reject')?.addEventListener('click', async () => {
      if (!confirm(`Xoa vinh vien lop "${cls.name}"? Khong the khoi phuc.`)) return;
      await api(`/classes/${cls.id}`, { method: 'DELETE' });
      loadArchived();
    });
    ul.appendChild(li);
  });
}

function renderDeletedSubmissions(list) {
  const ul = $('#deleted-submission-list');
  if (!ul) return;
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="placeholder">Chua co yeu cau duyet da xoa.</li>';
    return;
  }
  list.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'archived-item deleted-submission-item';
    const busyText = busySlotLabels(item.busySlots || [], item.sessions || DEFAULT_SESSIONS).join(', ') || 'Khong tick buoi ban';
    li.innerHTML = `<span><b>${escapeHtml(item.studentName)}</b> <small>${escapeHtml(item.className || item.classId)} - ${escapeHtml(dobNote(item.dob))}</small><br><small>${escapeHtml(busyText)}</small></span>
      <span class="acts"><button class="btn-approve" data-id="${item.id}">Khoi phuc</button><button class="btn-reject" data-id="${item.id}">Xoa vinh vien</button></span>`;
    li.querySelector('.btn-approve')?.addEventListener('click', async () => {
      await api(`/deleted-submissions/${item.id}/restore`, { method: 'POST' });
      loadArchived();
      if (selectedClassId === item.classId) refreshTeacherView(item.classId);
      else loadClasses();
    });
    li.querySelector('.btn-reject')?.addEventListener('click', async () => {
      if (!confirm(`Xoa vinh vien yeu cau cua "${item.studentName}"?`)) return;
      await api(`/deleted-submissions/${item.id}`, { method: 'DELETE' });
      loadArchived();
    });
    ul.appendChild(li);
  });
}

function appBasePath() {
  if (location.hostname.endsWith('github.io')) {
    const first = location.pathname.split('/').filter(Boolean)[0];
    return first ? `/${first}/` : '/';
  }
  return '/';
}

function slugifyClassName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('vi-VN')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function classRouteSlug(cls) {
  const slug = slugifyClassName(cls?.name);
  const duplicate = teacherClasses.filter((item) => {
    const other = slugifyClassName(item?.name);
    return other === slug;
  }).length > 1;
  return slug && !duplicate ? slug : cls?.id || slug;
}

function scheduleClassUrl(classId) {
  const cls = teacherClasses.find((item) => item.id === classId);
  return `${appBasePath()}${encodeURIComponent(classRouteSlug(cls) || classId)}`;
}

function publicScheduleUrl(classId) {
  const cls = teacherClasses.find((item) => item.id === classId);
  const slug = classRouteSlug(cls) || classId;
  return `${location.origin}${appBasePath()}schedule.html?class=${encodeURIComponent(slug)}`;
}

function requestedScheduleClassId() {
  const redirected = new URLSearchParams(location.search).get('route');
  if (redirected) return redirected.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
  const base = appBasePath();
  const relative = decodeURIComponent(location.pathname.slice(base.length)).replace(/^\/+|\/+$/g, '');
  return relative && !relative.includes('.') ? relative.split('/').pop() : '';
}

function activateScheduleTab() {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'schedule'));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'tab-schedule'));
}

function activateInitialScheduleRoute() {
  if (!teacherSession || scheduleClassId) return;
  const route = requestedScheduleClassId();
  const routedClass = teacherClasses.find((cls) => cls.id === route || classRouteSlug(cls) === route);
  if (!routedClass) return;
  activateScheduleTab();
  history.replaceState({ scheduleClassId: routedClass.id }, '', scheduleClassUrl(routedClass.id));
  openScheduleClass(routedClass.id, { updateUrl: false });
}

function handleScheduleRoute() {
  const route = requestedScheduleClassId();
  const routedClass = teacherClasses.find((cls) => cls.id === route || classRouteSlug(cls) === route);
  if (routedClass) {
    activateScheduleTab();
    openScheduleClass(routedClass.id, { updateUrl: false });
  } else if ($('#tab-schedule')?.classList.contains('active')) {
    scheduleClassId = null;
    renderScheduleHome();
  }
}

function scheduleExpandedSectorIds() {
  try {
    const value = JSON.parse(localStorage.getItem(SCHEDULE_EXPANDED_SECTORS_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch (err) {
    return new Set();
  }
}

function toggleScheduleSector(sectorId) {
  const ids = scheduleExpandedSectorIds();
  const key = String(sectorId);
  if (ids.has(key)) ids.delete(key);
  else ids.add(key);
  localStorage.setItem(SCHEDULE_EXPANDED_SECTORS_KEY, JSON.stringify([...ids]));
  renderScheduleHome();
}

async function loadScheduleHome() {
  clearTimeout(finalScheduleTimer);
  if (!teacherSession) return;
  if (!teacherClasses.length) {
    try { await loadClasses(); } catch (err) { /* Render error below if needed. */ }
  }
  if (scheduleClassId) {
    await openScheduleClass(scheduleClassId, { updateUrl: false });
    return;
  }
  try {
    scheduleOverviewData = await api('/schedule-overview', {
      method: 'GET',
      body: JSON.stringify({ weekStart: overviewWeekStart() })
    });
  } catch (err) {
    scheduleOverviewData = {
      weekStart: overviewWeekStart(),
      weeks: [],
      classes: teacherClasses.map((cls) => ({
        ...cls,
        activeSlots: cls.currentSlots || [],
        slots: cls.finalSubjects || {},
        details: cls.finalDetails || {}
      }))
    };
  }
  renderScheduleHome();
}

function overviewWeekStart() {
  const saved = localStorage.getItem(SCHEDULE_OVERVIEW_WEEK_KEY);
  return saved || localIsoDate(mondayOf(new Date()));
}

function overviewRooms() {
  return [
    { id: 'A1', label: 'A1', place: 'T\u1ea7ng 1' },
    { id: 'A2', label: 'A2', place: 'T\u1ea7ng 2' },
    { id: 'CS2', label: 'CS2', place: 'C\u01a1 s\u1edf 2' }
  ];
}

function overviewSubRows() {
  return ['Gi\u1edd', 'L\u1edbp', 'K\u1ef9 n\u0103ng', 'Ghi ch\u00fa'];
}

function scheduleOverviewCollapsed() {
  return localStorage.getItem(SCHEDULE_OVERVIEW_COLLAPSED_KEY) === '1';
}

function scheduleOverviewMode() {
  return localStorage.getItem(SCHEDULE_OVERVIEW_MODE_KEY) === 'detail' ? 'detail' : 'compact';
}

function setScheduleOverviewMode(mode) {
  localStorage.setItem(SCHEDULE_OVERVIEW_MODE_KEY, mode === 'detail' ? 'detail' : 'compact');
  scheduleOverviewEditMode = false;
}

function setScheduleOverviewCollapsed(value) {
  localStorage.setItem(SCHEDULE_OVERVIEW_COLLAPSED_KEY, value ? '1' : '0');
}

function overviewWeeks() {
  try {
    const localWeeks = JSON.parse(localStorage.getItem(SCHEDULE_OVERVIEW_WEEKS_KEY) || '[]');
    const remoteWeeks = Array.isArray(scheduleOverviewData?.weeks) ? scheduleOverviewData.weeks : [];
    const merged = new Map();
    [...remoteWeeks, ...localWeeks].forEach((item) => {
      if (!item?.weekStart) return;
      const current = merged.get(item.weekStart) || {};
      merged.set(item.weekStart, { ...current, ...item, weekStart: item.weekStart });
    });
    return [...merged.values()].sort((a, b) => String(b.weekStart).localeCompare(String(a.weekStart)));
  } catch (err) {
    return [];
  }
}

function rememberOverviewWeek(weekStart, note = '') {
  if (!weekStart) return;
  const weeks = overviewWeeks().filter((item) => item.weekStart !== weekStart);
  weeks.unshift({ weekStart, note: note || loadOverviewData(weekStart).note || '', updatedAt: Date.now() });
  localStorage.setItem(SCHEDULE_OVERVIEW_WEEKS_KEY, JSON.stringify(weeks.slice(0, 80)));
}

function defaultOverviewLegend() {
  return overviewRooms().map((room) => ({
    code: room.label,
    text: room.place,
    backgroundColor: room.id === 'CS2' ? '#fdfd0a' : '#fb923c',
    color: '#111827'
  }));
}

function overviewSessions() {
  const sessions = selectedGridSessions(teacherClasses);
  return sessions.length ? sessions : (DEFAULT_SESSIONS.length ? DEFAULT_SESSIONS : ['S1', 'S2', 'C', '57', 'T']);
}

function normalizeOverviewStyle(style = {}) {
  if (!style || typeof style !== 'object') return {};
  const explicitBg = style.backgroundColor || style.bg;
  const backgroundColor = String(explicitBg || (!explicitBg ? style.color : '') || '').trim();
  const color = String(style.textColor || style.colorText || style.fg || style.foregroundColor || (explicitBg ? style.color : '') || '').trim();
  const result = {};
  if (backgroundColor) result.backgroundColor = backgroundColor;
  if (color) result.color = color;
  return result;
}

function normalizeOverviewLegendItem(item = {}) {
  const style = normalizeOverviewStyle(item);
  return {
    code: item.code || '',
    text: item.text || '',
    backgroundColor: style.backgroundColor || item.backgroundColor || item.color || '#ffffff',
    color: style.color || item.textColor || '#111827'
  };
}

function loadOverviewData(weekStart = overviewWeekStart()) {
  try {
    const raw = localStorage.getItem(SCHEDULE_OVERVIEW_DATA_PREFIX + weekStart);
    const data = JSON.parse(raw || '{}');
    return {
      note: data.note || '',
      noteStyle: normalizeOverviewStyle(data.noteStyle || {}),
      legendBoxStyle: normalizeOverviewStyle(data.legendBoxStyle || {}),
      legend: Array.isArray(data.legend) && data.legend.length
        ? data.legend.map(normalizeOverviewLegendItem)
        : defaultOverviewLegend(),
      cells: data.cells || {},
      styles: Object.fromEntries(Object.entries(data.styles || {}).map(([key, style]) => [key, { ...normalizeOverviewStyle(style), width: style?.width || '', height: style?.height || '' }]))
    };
  } catch (err) {
    return { note: '', noteStyle: {}, legendBoxStyle: {}, legend: defaultOverviewLegend(), cells: {}, styles: {} };
  }
}

function overviewRowClass(rowName) {
  const key = String(rowName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (key.includes('lop')) return 'lop';
  if (key.includes('ky')) return 'ky-nang';
  if (key.includes('gio')) return 'gio';
  return 'ghi-chu';
}

function overviewScheduleClasses() {
  return Array.isArray(scheduleOverviewData?.classes) && scheduleOverviewData.classes.length
    ? scheduleOverviewData.classes
    : teacherClasses.map((cls) => ({
      ...cls,
      activeSlots: cls.currentSlots || [],
      slots: cls.finalSubjects || {},
      details: cls.finalDetails || {}
    }));
}

function overviewRoomForDetail(detail = {}, rooms = overviewRooms()) {
  const key = String(detail.location || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (key.includes('cs2') || key.includes('co so 2')) return rooms.find((room) => room.id === 'CS2');
  if (key.includes('tang 2') || key === 'a2') return rooms.find((room) => room.id === 'A2');
  if (key.includes('tang 1') || key === 'a1') return rooms.find((room) => room.id === 'A1');
  return null;
}

function autoOverviewCells(sessions, rooms) {
  const cells = {};
  const occupied = {};
  sortClasses(overviewScheduleClasses()).forEach((cls) => {
    const clsSessions = getSessions(cls);
    const activeSlots = cls.activeSlots || cls.currentSlots || [];
    const subjects = cls.slots || cls.finalSubjects || {};
    const details = cls.details || cls.finalDetails || {};
    activeSlots.forEach((slotId) => {
      const [dayIdx, clsSessionIdx] = String(slotId).split('-').map(Number);
      const sessionName = clsSessions[clsSessionIdx];
      const overviewSession = sessions.find((item) => sessionKey(item) === sessionKey(sessionName));
      if (dayIdx < 0 || dayIdx > 6 || !overviewSession) return;
      const occKey = `${overviewSession}|${dayIdx}`;
      const detail = details[slotId] || {};
      const preferredRoom = overviewRoomForDetail(detail, rooms);
      const preferredIndex = preferredRoom ? rooms.indexOf(preferredRoom) : -1;
      let room = preferredRoom;
      if (!room || occupied[`${occKey}|${room.id}`]) {
        const start = preferredIndex >= 0 ? preferredIndex : (occupied[occKey] || 0);
        room = Array.from({ length: rooms.length }, (_, offset) => rooms[(start + offset) % rooms.length])
          .find((candidate) => !occupied[`${occKey}|${candidate.id}`]) || rooms[start % rooms.length];
      }
      occupied[occKey] = (occupied[occKey] || 0) + 1;
      occupied[`${occKey}|${room.id}`] = true;
      const base = `${overviewSession}|${dayIdx}|${room.id}`;
      const append = (rowName, value) => {
        const key = `${base}|${rowName}`;
        if (!value) return;
        cells[key] = cells[key] ? `${cells[key]} / ${value}` : String(value);
      };
      append('Gi\u1edd', detail.startTime || sessionName || '');
      append('L\u1edbp', cls.name);
      const skill = cls.courseKind === 'grammar' ? '' : displayLessonLabel(subjects[slotId] || '');
      append('K\u1ef9 n\u0103ng', skill);
      append('Ghi ch\u00fa', [detail.teacherName, detail.note].filter(Boolean).join(' \u00b7 '));
    });
  });
  return cells;
}

function overviewCellStyle(style = {}) {
  const normalized = normalizeOverviewStyle(style);
  const parts = [];
  if (normalized.backgroundColor) parts.push(`background:${escapeHtml(normalized.backgroundColor)} !important`);
  if (normalized.color) parts.push(`color:${escapeHtml(normalized.color)} !important`);
  if (style.width) {
    parts.push(`width:${escapeHtml(style.width)}`);
    parts.push(`min-width:${escapeHtml(style.width)}`);
  }
  if (style.height) parts.push(`height:${escapeHtml(style.height)}`);
  return parts.length ? ` style="${parts.join(';')}"` : '';
}

function overviewPalette() {
  return [
    { name: 'M\u00e0u da', bg: '#fde7cf', fg: '#111827' },
    { name: 'V\u00e0ng', bg: '#fdfd0a', fg: '#111827' },
    { name: 'Xanh l\u00e1', bg: '#22c55e', fg: '#052e16' },
    { name: 'H\u1ed3ng', bg: '#f9a8d4', fg: '#111827' },
    { name: 'Xanh lam', bg: '#7dd3fc', fg: '#111827' },
    { name: 'Xanh \u0111\u1eadm', bg: '#1d4ed8', fg: '#ffffff' },
    { name: '\u0110\u1ecf', bg: '#dc2626', fg: '#ffffff' }
  ];
}

function scheduleOverviewSelection() {
  const root = $('#schedule-overview');
  return root ? [...root.querySelectorAll('.overview-selected-cell')] : [];
}

function saveOverviewFromDom() {
  const root = $('#schedule-overview');
  if (!root) return;
  const weekStart = $('#overview-week-start')?.value || overviewWeekStart();
  const cells = {};
  const styles = {};
  root.querySelectorAll('[data-overview-cell]').forEach((cell) => {
    const value = cell.textContent.trim();
    const autoValue = cell.dataset.auto || '';
    if (value && value !== autoValue) cells[cell.dataset.overviewCell] = value;
    const bg = cell.dataset.bg || '';
    const fg = cell.dataset.fg || '';
    const width = cell.dataset.width || '';
    const height = cell.dataset.height || '';
    if (bg || fg || width || height) styles[cell.dataset.overviewCell] = { backgroundColor: bg, color: fg, width, height };
  });
  const note = $('#overview-note')?.value.trim() || '';
  const noteBox = $('#overview-note-box');
  const noteBg = noteBox?.dataset.bg || '';
  const noteFg = noteBox?.dataset.fg || '';
  const legendBox = root.querySelector('.overview-legend-box');
  const legendBoxBg = legendBox?.dataset.bg || '';
  const legendBoxFg = legendBox?.dataset.fg || '';
  const legend = [...root.querySelectorAll('.legend-item')].map((item) => ({
    code: item.querySelector('.legend-code')?.value.trim() || '',
    text: item.querySelector('.legend-text')?.value.trim() || '',
    backgroundColor: item.dataset.bg || '#ffffff',
    color: item.dataset.fg || '#111827'
  })).filter((item) => item.code || item.text);
  rememberOverviewWeek(weekStart, note);
  localStorage.setItem(SCHEDULE_OVERVIEW_DATA_PREFIX + weekStart, JSON.stringify({
    note,
    noteStyle: (noteBg || noteFg) ? { backgroundColor: noteBg, color: noteFg } : {},
    legendBoxStyle: (legendBoxBg || legendBoxFg) ? { backgroundColor: legendBoxBg, color: legendBoxFg } : {},
    legend: legend.length ? legend : defaultOverviewLegend(),
    cells,
    styles
  }));
}


function buildOverviewExportTable(sourceTable) {
  const table = sourceTable.cloneNode(true);
  table.querySelectorAll('.overview-col-resizer, .overview-row-resizer').forEach((item) => item.remove());
  table.querySelectorAll('.overview-selected-cell').forEach((item) => item.classList.remove('overview-selected-cell'));
  table.classList.add('overview-export-table');
  table.style.cssText = 'border-collapse:collapse;border-spacing:0;width:max-content;min-width:0;table-layout:fixed;font:13px Arial,sans-serif;color:#111827;background:#ffffff;';

  const widths = [];
  const occupied = new Set();
  const sourceRows = [...sourceTable.rows];
  const cloneRows = [...table.rows];
  sourceRows.forEach((row, rowIndex) => {
    let logicalColumn = 0;
    [...row.cells].forEach((sourceCell, cellIndex) => {
      while (occupied.has(`${rowIndex}:${logicalColumn}`)) logicalColumn++;
      const cloneCell = cloneRows[rowIndex]?.cells[cellIndex];
      if (!cloneCell) return;
      const rowSpan = Number(sourceCell.rowSpan || 1);
      const colSpan = Number(sourceCell.colSpan || 1);
      const rect = sourceCell.getBoundingClientRect();
      const style = getComputedStyle(sourceCell);
      const width = Math.max(28, Number(sourceCell.dataset.width?.replace('px', '')) || rect.width || 48);
      const height = Math.max(20, Number(sourceCell.dataset.height?.replace('px', '')) || rect.height || 24);
      const perColumn = Math.max(28, Math.ceil(width / Math.max(1, colSpan)));
      for (let offset = 0; offset < colSpan; offset++) {
        widths[logicalColumn + offset] = Math.max(widths[logicalColumn + offset] || 0, perColumn);
      }
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
        for (let colOffset = 0; colOffset < colSpan; colOffset++) {
          occupied.add(`${rowIndex + rowOffset}:${logicalColumn + colOffset}`);
        }
      }
      cloneCell.style.cssText = [
        'box-sizing:border-box',
        'border:1px solid #111827',
        `padding:${style.paddingTop || '4px'} ${style.paddingRight || '6px'} ${style.paddingBottom || '4px'} ${style.paddingLeft || '6px'}`,
        `text-align:${style.textAlign || 'center'}`,
        'vertical-align:middle',
        `background:${style.backgroundColor || '#ffffff'}`,
        `color:${style.color || '#111827'}`,
        `font-size:${style.fontSize || '13px'}`,
        `font-weight:${style.fontWeight || '600'}`,
        `width:${Math.ceil(width)}px`,
        `min-width:${Math.ceil(width)}px`,
        `height:${Math.ceil(height)}px`,
        'white-space:nowrap'
      ].join(';');
      cloneCell.setAttribute('width', String(Math.ceil(width)));
      logicalColumn += colSpan;
    });
  });
  const colgroup = document.createElement('colgroup');
  widths.forEach((width) => {
    const col = document.createElement('col');
    const safeWidth = Math.ceil(Math.max(28, width || 48));
    col.style.cssText = `width:${safeWidth}px;min-width:${safeWidth}px;max-width:${safeWidth}px;mso-width-source:userset;mso-width-alt:${Math.round(safeWidth * 48)};`;
    col.setAttribute('width', String(safeWidth));
    colgroup.appendChild(col);
  });
  table.insertBefore(colgroup, table.firstChild);
  const totalWidth = widths.reduce((sum, width) => sum + Math.ceil(Math.max(28, width || 48)), 0);
  table.style.width = `${totalWidth}px`;
  table.setAttribute('width', String(totalWidth));
  return table;
}

function overviewExportTitle() {
  const weekStart = overviewWeekStart();
  const note = $('#overview-note')?.value.trim() || loadOverviewData(weekStart).note || 'Lich tong quan';
  return `${note} ${weekRangeText(weekStart)}`.replace(/[\\/:*?"<>|]/g, '-').trim() || 'lich-tong-quan';
}

async function copyOverviewToExcel(button) {
  if (scheduleOverviewEditMode) saveOverviewFromDom();
  const source = $('#schedule-overview table.overview-grid');
  if (!source) return;
  const table = buildOverviewExportTable(source);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><style>table{border-collapse:collapse;table-layout:fixed}col,td,th{mso-width-source:userset;white-space:nowrap}</style></head><body>${table.outerHTML}</body></html>`;
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

async function downloadOverviewExcel(button) {
  if (scheduleOverviewEditMode) saveOverviewFromDom();
  const source = $('#schedule-overview table.overview-grid');
  if (!source) return;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.disabled = true;
  button.textContent = '\u0110ang t\u1ea1o file...';
  try {
    const ExcelJS = await loadExcelJs();
    const table = buildOverviewExportTable(source);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Olympus English';
    const worksheet = workbook.addWorksheet(overviewExportTitle().replace(/[\\/*?:[\]]/g, '-').slice(0, 31) || 'Lich tong quan', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 2 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    [...(table.querySelector('colgroup')?.children || [])].forEach((col, index) => {
      const pixels = Number.parseFloat(col.style.width) || Number(col.getAttribute('width')) || 48;
      worksheet.getColumn(index + 1).width = Math.max(3.5, pixels / 7);
    });
    const occupied = new Set();
    [...table.rows].forEach((row, rowIndex) => {
      const excelRow = rowIndex + 1;
      worksheet.getRow(excelRow).height = Math.max(18, Number.parseFloat(row.cells[0]?.style.height) || 22);
      let excelColumn = 1;
      [...row.cells].forEach((htmlCell) => {
        while (occupied.has(`${excelRow}:${excelColumn}`)) excelColumn++;
        const rowSpan = Number(htmlCell.rowSpan || 1);
        const colSpan = Number(htmlCell.colSpan || 1);
        const excelCell = worksheet.getCell(excelRow, excelColumn);
        excelCell.value = htmlCell.textContent.trim().replace(/\s+/g, ' ');
        excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: excelArgb(htmlCell.style.backgroundColor, 'FFFFFFFF') } };
        excelCell.font = {
          name: 'Arial',
          size: Number.parseFloat(htmlCell.style.fontSize) || 13,
          bold: Number.parseInt(htmlCell.style.fontWeight, 10) >= 600,
          color: { argb: excelArgb(htmlCell.style.color, 'FF111827') }
        };
        excelCell.alignment = { horizontal: htmlCell.style.textAlign === 'left' ? 'left' : 'center', vertical: 'middle', wrapText: false };
        excelCell.border = {
          top: { style: 'thin', color: { argb: 'FF111827' } },
          left: { style: 'thin', color: { argb: 'FF111827' } },
          bottom: { style: 'thin', color: { argb: 'FF111827' } },
          right: { style: 'thin', color: { argb: 'FF111827' } }
        };
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
          for (let colOffset = 0; colOffset < colSpan; colOffset++) occupied.add(`${excelRow + rowOffset}:${excelColumn + colOffset}`);
        }
        if (rowSpan > 1 || colSpan > 1) worksheet.mergeCells(excelRow, excelColumn, excelRow + rowSpan - 1, excelColumn + colSpan - 1);
        excelColumn += colSpan;
      });
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${overviewExportTitle()}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 t\u1ea3i Excel');
  } catch (err) {
    setExportButtonStatus(button, 'T\u1ea1o Excel l\u1ed7i', true);
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

async function renderOverviewImage(sourceTable) {
  const table = buildOverviewExportTable(sourceTable);
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:max-content;background:#fff;z-index:-1;';
  stage.appendChild(table);
  document.body.appendChild(stage);
  await document.fonts?.ready;
  const rect = table.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const maxPixels = 45000000;
  const scale = Math.min(3, Math.sqrt(maxPixels / Math.max(1, width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const stageRect = stage.getBoundingClientRect();
  table.querySelectorAll('th,td').forEach((cell) => {
    const cellRect = cell.getBoundingClientRect();
    const x = cellRect.left - stageRect.left;
    const y = cellRect.top - stageRect.top;
    const style = getComputedStyle(cell);
    context.fillStyle = style.backgroundColor || '#ffffff';
    context.fillRect(x, y, cellRect.width, cellRect.height);
    context.strokeStyle = '#111827';
    context.lineWidth = 1;
    context.strokeRect(x + .5, y + .5, Math.max(0, cellRect.width - 1), Math.max(0, cellRect.height - 1));
    const value = cell.textContent.trim().replace(/\s+/g, ' ');
    if (!value) return;
    context.save();
    context.beginPath();
    context.rect(x + 2, y + 2, Math.max(0, cellRect.width - 4), Math.max(0, cellRect.height - 4));
    context.clip();
    context.fillStyle = style.color || '#111827';
    context.font = `${style.fontWeight || '600'} ${style.fontSize || '13px'} Arial, sans-serif`;
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.fillText(value, x + cellRect.width / 2, y + cellRect.height / 2, Math.max(0, cellRect.width - 8));
    context.restore();
  });
  stage.remove();
  return canvas;
}

async function copyOverviewImage(button) {
  if (scheduleOverviewEditMode) saveOverviewFromDom();
  const source = $('#schedule-overview table.overview-grid');
  if (!source) return;
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    setExportButtonStatus(button, 'Kh\u00f4ng h\u1ed7 tr\u1ee3', true);
    return;
  }
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.disabled = true;
  button.textContent = '\u0110ang t\u1ea1o \u1ea3nh...';
  try {
    const canvas = await renderOverviewImage(source);
    const png = await canvasBlob(canvas, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 copy \u1ea3nh');
  } catch (err) {
    setExportButtonStatus(button, 'T\u1ea1o \u1ea3nh l\u1ed7i', true);
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

function compactCourseNumbers(cls) {
  const active = [...(cls.activeSlots || cls.currentSlots || [])]
    .sort((left, right) => {
      const [leftDay, leftSession] = String(left).split('-').map(Number);
      const [rightDay, rightSession] = String(right).split('-').map(Number);
      return leftDay - rightDay || leftSession - rightSession;
    });
  const slots = cls.slots || cls.finalSubjects || {};
  const details = cls.details || cls.finalDetails || {};
  let total = Math.max(0, Number(cls.lessonStarts?.COURSE || 1) - 1);
  let pendingAssessment = null;
  const result = {};
  active.forEach((slotId) => {
    const saved = String(details[slotId]?.courseNo || '').trim();
    if (saved) {
      result[slotId] = saved;
      const numeric = Number.parseInt(saved, 10);
      if (Number.isFinite(numeric)) total = Math.max(total, numeric);
      return;
    }
    const type = scheduleLessonTypeFromLabel(slots[slotId], cls.courseKind);
    if (!type || type === 'OFF') {
      result[slotId] = '';
      return;
    }
    if (type === 'MT' || type === 'FT') {
      if (pendingAssessment?.type === type) {
        result[slotId] = `${pendingAssessment.course}b`;
        pendingAssessment = null;
      } else {
        total += 1;
        result[slotId] = `${total}a`;
        pendingAssessment = { type, course: total };
      }
      return;
    }
    pendingAssessment = null;
    total += 1;
    result[slotId] = String(total);
  });
  return result;
}

function compactLessonClass(label) {
  const type = scheduleLessonTypeFromLabel(label);
  if (type === 'OFF') return ' is-off';
  if (type === 'MT' || type === 'FT') return ' is-test';
  if (!type || type === 'LESSON') return '';
  return ` is-${type.toLowerCase()}`;
}

function compactOverviewTable(weekStart) {
  const classes = sortClasses(overviewScheduleClasses());
  const groups = buildSectorGroups(classes).filter((group) => group.classes.length);
  let html = '<div class="schedule-scroll compact-overview-wrap"><table class="schedule overview-grid compact-overview-grid"><thead><tr><th rowspan="2" class="compact-class-heading">L\u1edbp</th>';
  DAYS.forEach((day, dayIdx) => {
    html += `<th colspan="2" class="${dayIdx >= 5 ? 'compact-weekend' : ''}">${escapeHtml(DAYS_SHORT[dayIdx] || day)}<small>${escapeHtml(dayDateLabel(weekStart, dayIdx))}</small></th>`;
  });
  html += '</tr><tr>';
  DAYS.forEach((day, dayIdx) => { html += `<th class="${dayIdx >= 5 ? 'compact-weekend' : ''}">Bu\u1ed5i</th><th class="${dayIdx >= 5 ? 'compact-weekend' : ''}">N\u1ed9i dung</th>`; });
  html += '</tr></thead><tbody>';
  groups.forEach((group) => {
    html += `<tr class="compact-sector-row"><th colspan="15">${escapeHtml(group.name)}</th></tr>`;
    group.classes.forEach((cls) => {
      const active = cls.activeSlots || cls.currentSlots || [];
      const slots = cls.slots || cls.finalSubjects || {};
      const details = cls.details || cls.finalDetails || {};
      const numbers = compactCourseNumbers(cls);
      const byDay = Array.from({ length: 7 }, () => []);
      active.forEach((slotId) => {
        const [dayIdx, sessionIdx] = String(slotId).split('-').map(Number);
        if (dayIdx < 0 || dayIdx > 6) return;
        const detail = details[slotId] || {};
        const label = slots[slotId] || '';
        byDay[dayIdx].push({
          slotId,
          sessionIdx,
          courseNo: numbers[slotId] || '',
          label,
          detail,
          sessionName: getSessions(cls)[sessionIdx] || ''
        });
      });
      byDay.forEach((entries) => entries.sort((a, b) => a.sessionIdx - b.sessionIdx));
      html += `<tr class="${cls.courseKind === 'grammar' ? 'compact-grammar-class' : ''}"><th class="compact-class-name"><a href="${escapeHtml(scheduleClassUrl(cls.id))}" data-class-id="${escapeHtml(cls.id)}">${escapeHtml(cls.name)}</a></th>`;
      byDay.forEach((entries) => {
        const title = entries.map((entry) => [
          entry.sessionName,
          entry.detail.startTime,
          entry.detail.location,
          entry.detail.teacherName,
          entry.detail.note
        ].filter(Boolean).join(' \u00b7 ')).filter(Boolean).join('\n');
        const numberHtml = entries.map((entry) => `<span class="compact-entry-number${compactLessonClass(entry.label)}">${escapeHtml(entry.courseNo || (entry.label === 'OFF' ? 'Off' : '\u00b7'))}</span>`).join('');
        const lessonHtml = entries.map((entry) => {
          if (entry.label === 'OFF') return '<span class="compact-entry-lesson is-off">Off</span>';
          if (cls.courseKind === 'grammar') return '<span class="compact-entry-lesson">&nbsp;</span>';
          return `<span class="compact-entry-lesson${compactLessonClass(entry.label)}">${escapeHtml(displayLessonLabel(entry.label) || '\u00b7')}</span>`;
        }).join('');
        html += `<td class="compact-number-cell" title="${escapeHtml(title)}">${numberHtml || '&nbsp;'}</td><td class="compact-lesson-cell" title="${escapeHtml(title)}">${lessonHtml || '&nbsp;'}</td>`;
      });
      html += '</tr>';
    });
  });
  html += '</tbody></table></div>';
  return html;
}

function renderCompactScheduleOverview() {
  const weekStart = overviewWeekStart();
  const collapsed = scheduleOverviewCollapsed();
  const weeks = overviewWeeks();
  return `<section id="schedule-overview" class="schedule-overview-card compact-overview-card ${collapsed ? 'overview-collapsed' : ''}">
    <div class="overview-head">
      <div>
        <h3>To\u00e0n c\u1ea3nh l\u1ecbch tu\u1ea7n</h3>
        <p class="hint">M\u1ed7i l\u1edbp hi\u1ec3n th\u1ecb s\u1ed1 bu\u1ed5i to\u00e0n kho\u00e1 v\u00e0 n\u1ed9i dung h\u1ecdc; MT/FT d\u00f9ng c\u1eb7p a\u2013b nh\u01b0 18a, 18b.</p>
      </div>
      <div class="overview-actions">
        <div class="overview-mode-switch" role="group" aria-label="Ch\u1ebf \u0111\u1ed9 l\u1ecbch">
          <button type="button" class="active" data-overview-mode="compact">T\u1ed1i gi\u1ea3n</button>
          <button type="button" data-overview-mode="detail">Th\u00eam ca</button>
        </div>
        <label>Ng\u00e0y \u0111\u1ea7u tu\u1ea7n <input id="overview-week-start" type="date" value="${escapeHtml(weekStart)}" /></label>
        <label>Tu\u1ea7n c\u0169 <select id="overview-week-select"><option value="">Ch\u1ecdn tu\u1ea7n...</option>${weeks.map((item) => `<option value="${escapeHtml(item.weekStart)}" ${item.weekStart === weekStart ? 'selected' : ''}>${escapeHtml(item.title || item.note || 'Tu\u1ea7n')} (${escapeHtml(weekRangeText(item.weekStart))})</option>`).join('')}</select></label>
        <button id="overview-copy-excel" class="btn-export" type="button">Copy Excel</button>
        <button id="overview-download-excel" class="btn-export btn-download-excel" type="button">T\u1ea3i Excel</button>
        <button id="overview-copy-image" class="btn-export btn-export-image" type="button">In \u1ea2nh</button>
        <button id="overview-toggle" type="button">${collapsed ? 'M\u1edf b\u1ea3ng' : 'Thu g\u1ecdn'}</button>
      </div>
    </div>
    <div class="overview-body ${collapsed ? 'hidden' : ''}">${compactOverviewTable(weekStart)}</div>
  </section>`;
}

function renderScheduleOverview() {
  if (scheduleOverviewMode() === 'compact') return renderCompactScheduleOverview();
  const weekStart = overviewWeekStart();
  const data = loadOverviewData(weekStart);
  const sessions = overviewSessions();
  const rooms = overviewRooms();
  const subRows = overviewSubRows();
  const autoCells = autoOverviewCells(sessions, rooms);
  const noteBg = data.noteStyle?.backgroundColor || '#fef08a';
  const noteFg = data.noteStyle?.color || '#111827';
  const legendBoxBg = data.legendBoxStyle?.backgroundColor || '#f8fafc';
  const legendBoxFg = data.legendBoxStyle?.color || '#111827';
  const palette = overviewPalette();
  rememberOverviewWeek(weekStart, data.note);
  const weeks = overviewWeeks();
  const collapsed = scheduleOverviewCollapsed();
  let html = `<section id="schedule-overview" class="schedule-overview-card ${scheduleOverviewEditMode ? 'overview-editing' : ''} ${collapsed ? 'overview-collapsed' : ''}">
    <div class="overview-head">
      <div>
        <h3>To\u00e0n c\u1ea3nh l\u1ecbch tu\u1ea7n</h3>
        <p class="hint">B\u1ea5m Ch\u1ec9nh s\u1eeda \u0111\u1ec3 s\u1eeda nhanh. Khi \u0111ang s\u1eeda, gi\u1eef Ctrl r\u1ed3i b\u1ea5m nhi\u1ec1u \u00f4 \u0111\u1ec3 \u00e1p d\u1ee5ng h\u00e0ng lo\u1ea1t.</p>
      </div>
      <div class="overview-actions">
        <div class="overview-mode-switch" role="group" aria-label="Ch\u1ebf \u0111\u1ed9 l\u1ecbch">
          <button type="button" data-overview-mode="compact">T\u1ed1i gi\u1ea3n</button>
          <button type="button" class="active" data-overview-mode="detail">Th\u00eam ca</button>
        </div>
        <label>Ng\u00e0y \u0111\u1ea7u tu\u1ea7n <input id="overview-week-start" type="date" value="${escapeHtml(weekStart)}" /></label>
        <label>Tu\u1ea7n c\u0169 <select id="overview-week-select"><option value="">Ch\u1ecdn tu\u1ea7n...</option>${weeks.map((item) => `<option value="${escapeHtml(item.weekStart)}" ${item.weekStart === weekStart ? 'selected' : ''}>${escapeHtml(item.note || 'Tu\u1ea7n')} (${escapeHtml(weekRangeText(item.weekStart))})</option>`).join('')}</select></label>
        <button id="overview-new-week" type="button">+ Tu\u1ea7n m\u1edbi</button>
        <button id="overview-copy-excel" class="btn-export" type="button">Copy Excel</button>
        <button id="overview-download-excel" class="btn-export btn-download-excel" type="button">T\u1ea3i Excel</button>
        <button id="overview-copy-image" class="btn-export btn-export-image" type="button">In \u1ea2nh</button>
        <button id="overview-toggle" type="button">${collapsed ? 'M\u1edf b\u1ea3ng' : 'Thu g\u1ecdn'}</button>
        <button id="overview-edit" type="button">${scheduleOverviewEditMode ? 'L\u01b0u to\u00e0n c\u1ea3nh' : 'Ch\u1ec9nh s\u1eeda'}</button>
      </div>
    </div>
    ${scheduleOverviewEditMode ? `<div id="overview-edit-panel" class="overview-edit-panel hidden">
      <div class="overview-edit-panel-head"><b>Ch\u1ec9nh \u00f4 \u0111ang ch\u1ecdn</b><small id="overview-edit-count">0 \u00f4</small></div>
      <label>N\u1ed9i dung<input id="overview-edit-content" placeholder="Nh\u1eadp n\u1ed9i dung..." /></label>
      <div class="overview-panel-row">
        <label>M\u00e0u \u00f4<input id="overview-edit-bg" type="color" value="#ffffff" /></label>
        <label>M\u00e0u ch\u1eef<input id="overview-edit-fg" type="color" value="#111827" /></label>
        <label>R\u1ed9ng<input id="overview-edit-width" type="text" placeholder="vd: 80px" /></label>
        <label>Cao<input id="overview-edit-height" type="text" placeholder="vd: 32px" /></label>
      </div>
      <div class="overview-palette">${palette.map((item) => `<button type="button" data-bg="${item.bg}" data-fg="${item.fg}" style="background:${item.bg};color:${item.fg};" title="${item.name}">${item.name}</button>`).join('')}</div>
      <div class="overview-panel-actions"><button id="overview-apply-cell" type="button">\u00c1p d\u1ee5ng</button><button id="overview-clear-cell" type="button">Xo\u00e1 m\u00e0u</button></div>
      <small>Gi\u1eef Ctrl khi b\u1ea5m \u0111\u1ec3 ch\u1ecdn nhi\u1ec1u \u00f4 v\u00e0 s\u1eeda h\u00e0ng lo\u1ea1t.</small>
    </div>` : ''}
    <div class="overview-body ${collapsed ? 'hidden' : ''}"><div class="overview-layout">
      <div class="schedule-scroll overview-table-wrap"><table class="schedule overview-grid"><thead><tr>
        ${['BU\u1ed4I','Ca','N\u1ed9i dung'].map((label) => {
          const key = `header|main|${label}`;
          const style = data.styles[key] || {};
          const normalizedStyle = normalizeOverviewStyle(style);
          const value = data.cells[key] ?? label;
          return `<th rowspan="2" class="overview-cell overview-header-cell has-value" data-overview-cell="${escapeHtml(key)}" data-auto="${escapeHtml(label)}" data-bg="${escapeHtml(normalizedStyle.backgroundColor || '')}" data-fg="${escapeHtml(normalizedStyle.color || '')}" data-width="${escapeHtml(style.width || '')}" data-height="${escapeHtml(style.height || '')}" data-col="main-${escapeHtml(label)}" data-row-id="header-main"${overviewCellStyle(style)}>${escapeHtml(value)}</th>`;
        }).join('')}`;
  DAYS.forEach((day, dayIdx) => {
    const label = overviewDayLabel(weekStart, dayIdx);
    const key = `header|day|${dayIdx}`;
    const style = data.styles[key] || {};
    const normalizedStyle = normalizeOverviewStyle(style);
    const value = normalizeOverviewDayHeaderValue(data.cells[key] ?? label, label, dayIdx, weekStart);
    html += `<th colspan="${rooms.length}" class="overview-cell overview-day-header has-value" data-overview-cell="${escapeHtml(key)}" data-auto="${escapeHtml(label)}" data-bg="${escapeHtml(normalizedStyle.backgroundColor || '')}" data-fg="${escapeHtml(normalizedStyle.color || '')}" data-width="${escapeHtml(style.width || '')}" data-height="${escapeHtml(style.height || '')}" data-col="day-${dayIdx}" data-row-id="header-days"${overviewCellStyle(style)}>${escapeHtml(value)}</th>`;
  });
  html += '</tr><tr>';
  DAYS.forEach((day, dayIdx) => rooms.forEach((room) => {
    const key = `header|room|${dayIdx}|${room.id}`;
    const style = data.styles[key] || {};
    const normalizedStyle = normalizeOverviewStyle(style);
    const value = data.cells[key] ?? room.label;
    html += `<th class="overview-cell overview-room overview-room-${escapeHtml(room.id.toLowerCase())} has-value" data-overview-cell="${escapeHtml(key)}" data-auto="${escapeHtml(room.label)}" data-bg="${escapeHtml(normalizedStyle.backgroundColor || '')}" data-fg="${escapeHtml(normalizedStyle.color || '')}" data-width="${escapeHtml(style.width || '')}" data-height="${escapeHtml(style.height || '')}" data-col="slot-${dayIdx}-${escapeHtml(room.id)}" data-row-id="header-rooms"${overviewCellStyle(style)}>${escapeHtml(value)}</th>`;
  }));
  html += '</tr></thead><tbody>';
  sessions.forEach((session, sessionIdx) => {
    subRows.forEach((rowName, rowIdx) => {
      html += '<tr>';
      if (rowIdx === 0) {
        const sessionKeyCell = `label|session|${session}`;
        const caKeyCell = `label|ca|${session}`;
        const sessionStyle = data.styles[sessionKeyCell] || {};
        const caStyle = data.styles[caKeyCell] || {};
        const sessionNorm = normalizeOverviewStyle(sessionStyle);
        const caNorm = normalizeOverviewStyle(caStyle);
        const sessionValue = data.cells[sessionKeyCell] ?? session;
        const caValue = data.cells[caKeyCell] ?? String(sessionIdx + 1);
        html += `<th rowspan="${subRows.length}" class="overview-cell overview-session has-value" data-overview-cell="${escapeHtml(sessionKeyCell)}" data-auto="${escapeHtml(session)}" data-bg="${escapeHtml(sessionNorm.backgroundColor || '')}" data-fg="${escapeHtml(sessionNorm.color || '')}" data-width="${escapeHtml(sessionStyle.width || '')}" data-height="${escapeHtml(sessionStyle.height || '')}" data-col="main-session" data-row-id="session-${escapeHtml(session)}"${overviewCellStyle(sessionStyle)}>${escapeHtml(sessionValue)}</th><th rowspan="${subRows.length}" class="overview-cell overview-ca has-value" data-overview-cell="${escapeHtml(caKeyCell)}" data-auto="${sessionIdx + 1}" data-bg="${escapeHtml(caNorm.backgroundColor || '')}" data-fg="${escapeHtml(caNorm.color || '')}" data-width="${escapeHtml(caStyle.width || '')}" data-height="${escapeHtml(caStyle.height || '')}" data-col="main-ca" data-row-id="session-${escapeHtml(session)}"${overviewCellStyle(caStyle)}>${escapeHtml(caValue)}</th>`;
      }
      const rowKey = `label|row|${session}|${rowName}`;
      const rowStyle = data.styles[rowKey] || {};
      const rowNorm = normalizeOverviewStyle(rowStyle);
      const rowValue = data.cells[rowKey] ?? rowName;
      html += `<th class="overview-cell overview-row-label has-value" data-overview-cell="${escapeHtml(rowKey)}" data-auto="${escapeHtml(rowName)}" data-bg="${escapeHtml(rowNorm.backgroundColor || '')}" data-fg="${escapeHtml(rowNorm.color || '')}" data-width="${escapeHtml(rowStyle.width || '')}" data-height="${escapeHtml(rowStyle.height || '')}" data-col="main-content" data-row-id="row-${escapeHtml(session)}-${escapeHtml(rowName)}"${overviewCellStyle(rowStyle)}>${escapeHtml(rowValue)}</th>`;
      DAYS.forEach((day, dayIdx) => rooms.forEach((room) => {
        const key = `${session}|${dayIdx}|${room.id}|${rowName}`;
        const autoValue = autoCells[key] || '';
        const value = data.cells[key] ?? autoValue;
        const style = data.styles[key] || {};
        const hasValue = String(value || '').trim() ? ' has-value' : '';
        const normalizedStyle = normalizeOverviewStyle(style);
        html += `<td class="overview-cell overview-${overviewRowClass(rowName)} overview-room-col-${escapeHtml(room.id.toLowerCase())}${hasValue}" data-overview-cell="${escapeHtml(key)}" data-auto="${escapeHtml(autoValue)}" data-bg="${escapeHtml(normalizedStyle.backgroundColor || '')}" data-fg="${escapeHtml(normalizedStyle.color || '')}" data-width="${escapeHtml(style.width || '')}" data-height="${escapeHtml(style.height || '')}" data-col="slot-${dayIdx}-${escapeHtml(room.id)}" data-row-id="row-${escapeHtml(session)}-${escapeHtml(rowName)}" data-row-label="${escapeHtml(rowName)}" spellcheck="false"${overviewCellStyle(style)}>${escapeHtml(value)}</td>`;
      }));
      html += '</tr>';
    });
  });
  html += `</tbody></table></div>
      <aside class="overview-side">
        <div id="overview-note-box" class="overview-mini-box overview-note-box overview-selectable-box" data-box-kind="note" data-bg="${escapeHtml(noteBg)}" data-fg="${escapeHtml(noteFg)}" style="background:${escapeHtml(noteBg)};color:${escapeHtml(noteFg)};">
          <label>Ghi ch\u00fa tu\u1ea7n<input id="overview-note" value="${escapeHtml(data.note)}" placeholder="vd: Tu\u1ea7n 26" ${scheduleOverviewEditMode ? '' : 'readonly'} /></label>
          <b>${escapeHtml(weekRangeText(weekStart))}</b>
        </div>
        <div class="overview-mini-box overview-legend-box overview-selectable-box" data-box-kind="legend" data-bg="${escapeHtml(legendBoxBg)}" data-fg="${escapeHtml(legendBoxFg)}" style="background:${escapeHtml(legendBoxBg)};color:${escapeHtml(legendBoxFg)};">
          <div class="legend-head"><b>K\u00fd hi\u1ec7u</b>${scheduleOverviewEditMode ? '<button id="overview-add-legend" type="button" title="Th\u00eam k\u00fd hi\u1ec7u">+</button>' : ''}</div>
          <div id="overview-legend-list" class="legend-table">
            <div class="legend-header"><span>Vi\u1ebft t\u1eaft</span><span>Gi\u1ea3i th\u00edch</span></div>
            ${data.legend.map((rawItem, index) => {
              const item = normalizeOverviewLegendItem(rawItem);
              return `<div class="legend-item overview-selectable-box" data-box-kind="legend-item" data-index="${index}" style="background:${escapeHtml(item.backgroundColor)};color:${escapeHtml(item.color)};" data-bg="${escapeHtml(item.backgroundColor)}" data-fg="${escapeHtml(item.color)}">
                <input class="legend-code" value="${escapeHtml(item.code || '')}" ${scheduleOverviewEditMode ? '' : 'readonly'} />
                <input class="legend-text" value="${escapeHtml(item.text || '')}" ${scheduleOverviewEditMode ? '' : 'readonly'} />
              </div>`;
            }).join('')}
          </div>
        </div>
      </aside>
    </div></div>
  </section>`;
  return html;
}


function positionCellEditPanel(panel, targets, topClass = 'cell-panel-docked') {
  if (!panel) return;
  panel.classList.remove('cell-panel-floating', 'cell-panel-docked', 'overview-panel-docked', 'homeroom-panel-docked');
  panel.style.left = '';
  panel.style.top = '';
  panel.style.right = '';
  if (!targets?.length) return;
  panel.classList.add(topClass);
}

function addOverviewResizeHandles(scope) {
  if (!scheduleOverviewEditMode) return;
  const cells = scope?.classList?.contains('overview-cell')
    ? [scope]
    : [...(scope || document).querySelectorAll('.overview-cell')];
  cells.forEach((cell) => {
    if (!cell.querySelector(':scope > .overview-col-resizer')) {
      const col = document.createElement('span');
      col.className = 'overview-col-resizer';
      col.contentEditable = 'false';
      col.title = 'K\u00e9o \u0111\u1ec3 \u0111\u1ed5i \u0111\u1ed9 r\u1ed9ng c\u1ed9t';
      cell.appendChild(col);
    }
    if (!cell.querySelector(':scope > .overview-row-resizer')) {
      const row = document.createElement('span');
      row.className = 'overview-row-resizer';
      row.contentEditable = 'false';
      row.title = 'K\u00e9o \u0111\u1ec3 \u0111\u1ed5i chi\u1ec1u cao h\u00e0ng';
      cell.appendChild(row);
    }
  });
}

function rgbToHex(value) {
  const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return '';
  return '#' + [match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('');
}

function wireScheduleOverview() {
  const root = $('#schedule-overview');
  if (!root) return;
  const panel = $('#overview-edit-panel');
  const contentInput = $('#overview-edit-content');
  const bgInput = $('#overview-edit-bg');
  const fgInput = $('#overview-edit-fg');
  const widthInput = $('#overview-edit-width');
  const heightInput = $('#overview-edit-height');
  const countLabel = $('#overview-edit-count');
  root.querySelectorAll('[data-overview-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      setScheduleOverviewMode(button.dataset.overviewMode);
      loadScheduleHome();
    });
  });
  root.querySelectorAll('.compact-class-name a[data-class-id]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openScheduleClass(link.dataset.classId);
    });
  });

  const selectedTargets = () => [...root.querySelectorAll('.overview-selected-cell')];
  const targetText = (target) => {
    if (target.dataset.boxKind === 'note') return $('#overview-note')?.value || '';
    if (target.dataset.boxKind === 'legend') return '';
    if (target.dataset.boxKind === 'legend-item') {
      const code = target.querySelector('.legend-code')?.value || '';
      const text = target.querySelector('.legend-text')?.value || '';
      return `${code}${text ? ' - ' + text : ''}`.trim();
    }
    return target.textContent.trim();
  };
  const applyTargetText = (target, text) => {
    if (target.dataset.boxKind === 'note') {
      const note = $('#overview-note');
      if (note) note.value = text;
      return;
    }
    if (target.dataset.boxKind === 'legend') return;
    if (target.dataset.boxKind === 'legend-item') {
      const parts = String(text || '').split(/\s+-\s+/);
      const code = target.querySelector('.legend-code');
      const desc = target.querySelector('.legend-text');
      if (code) code.value = parts.shift() || '';
      if (desc) desc.value = parts.join(' - ');
      return;
    }
    target.textContent = text;
    target.classList.toggle('has-value', Boolean(String(text || '').trim()));
    addOverviewResizeHandles(target);
  };
  const syncPanel = () => {
    const targets = selectedTargets();
    if (!panel) return;
    panel.classList.toggle('hidden', !scheduleOverviewEditMode || !targets.length);
    positionCellEditPanel(panel, targets, 'overview-panel-docked');
    if (countLabel) countLabel.textContent = `${targets.length} \u00f4`;
    const first = targets[0];
    if (!first) return;
    if (contentInput) {
      contentInput.value = targets.length === 1 ? targetText(first) : '';
      contentInput.placeholder = targets.length === 1 ? 'Nh\u1eadp n\u1ed9i dung...' : 'B\u1ecf tr\u1ed1ng n\u1ebfu ch\u1ec9 \u0111\u1ed5i m\u00e0u';
    }
    if (bgInput) bgInput.value = first.dataset.bg || rgbToHex(getComputedStyle(first).backgroundColor) || '#ffffff';
    if (fgInput) fgInput.value = first.dataset.fg || rgbToHex(getComputedStyle(first).color) || '#111827';
    if (widthInput) widthInput.value = first.dataset.width || '';
    if (heightInput) heightInput.value = first.dataset.height || '';
  };
  const selectTarget = (target, additive = false) => {
    if (!scheduleOverviewEditMode || !target) return;
    if (!additive) {
      root.querySelectorAll('.overview-selected-cell').forEach((item) => item.classList.remove('overview-selected-cell'));
    }
    target.classList.toggle('overview-selected-cell', additive ? !target.classList.contains('overview-selected-cell') : true);
    syncPanel();
  };
  const applyStyleToSelection = (bg, fg, options = {}) => {
    selectedTargets().forEach((target) => {
      if (bg !== undefined) {
        target.dataset.bg = bg || '';
        if (bg) target.style.setProperty('background', bg, 'important');
        else target.style.removeProperty('background');
      }
      if (fg !== undefined) {
        target.dataset.fg = fg || '';
        if (fg) target.style.setProperty('color', fg, 'important');
        else target.style.removeProperty('color');
      }
      if (options.width !== undefined) {
        target.dataset.width = options.width || '';
        if (options.width) {
          target.style.width = options.width;
          target.style.minWidth = options.width;
        } else {
          target.style.removeProperty('width');
          target.style.removeProperty('min-width');
        }
      }
      if (options.height !== undefined) {
        target.dataset.height = options.height || '';
        if (options.height) target.style.height = options.height;
        else target.style.removeProperty('height');
      }
      if (options.text !== undefined) applyTargetText(target, options.text);
    });
  };
  const sameColumnCells = (cell) => {
    const col = cell.dataset.col || '';
    return col ? [...root.querySelectorAll('.overview-cell')].filter((item) => item.dataset.col === col) : [cell];
  };
  const sameRowCells = (cell) => {
    const row = cell.dataset.rowId || '';
    return row ? [...root.querySelectorAll('.overview-cell')].filter((item) => item.dataset.rowId === row) : [cell];
  };
  const startOverviewResize = (event, cell, type) => {
    if (!scheduleOverviewEditMode || !cell) return;
    event.preventDefault();
    event.stopPropagation();
    const targets = type === 'col' ? sameColumnCells(cell) : sameRowCells(cell);
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = cell.getBoundingClientRect().width;
    const startHeight = cell.getBoundingClientRect().height;
    const onMove = (moveEvent) => {
      if (type === 'col') {
        const width = `${Math.max(28, Math.round(startWidth + moveEvent.clientX - startX))}px`;
        targets.forEach((target) => {
          target.dataset.width = width;
          target.style.width = width;
          target.style.minWidth = width;
        });
        if (widthInput && cell.classList.contains('overview-selected-cell')) widthInput.value = width;
      } else {
        const height = `${Math.max(20, Math.round(startHeight + moveEvent.clientY - startY))}px`;
        targets.forEach((target) => {
          target.dataset.height = height;
          target.style.height = height;
        });
        if (heightInput && cell.classList.contains('overview-selected-cell')) heightInput.value = height;
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  addOverviewResizeHandles(root);
  root.querySelectorAll('.overview-col-resizer').forEach((handle) => {
    handle.addEventListener('mousedown', (event) => startOverviewResize(event, handle.closest('.overview-cell'), 'col'));
  });
  root.querySelectorAll('.overview-row-resizer').forEach((handle) => {
    handle.addEventListener('mousedown', (event) => startOverviewResize(event, handle.closest('.overview-cell'), 'row'));
  });

  $('#overview-week-start')?.addEventListener('change', (event) => {
    if (scheduleOverviewEditMode) saveOverviewFromDom();
    localStorage.setItem(SCHEDULE_OVERVIEW_WEEK_KEY, event.target.value || localIsoDate(mondayOf(new Date())));
    scheduleOverviewEditMode = false;
    loadScheduleHome();
  });
  $('#overview-week-select')?.addEventListener('change', (event) => {
    const value = event.target.value;
    if (!value) return;
    if (scheduleOverviewEditMode) saveOverviewFromDom();
    localStorage.setItem(SCHEDULE_OVERVIEW_WEEK_KEY, value);
    scheduleOverviewEditMode = false;
    loadScheduleHome();
  });
  $('#overview-new-week')?.addEventListener('click', () => {
    if (scheduleOverviewEditMode) saveOverviewFromDom();
    const current = new Date(overviewWeekStart());
    current.setDate(current.getDate() + 7);
    const nextStart = prompt('Nh\u1eadp ng\u00e0y th\u1ee9 2 \u0111\u1ea7u tu\u1ea7n m\u1edbi (YYYY-MM-DD):', localIsoDate(current));
    if (!nextStart) return;
    const note = prompt('T\u00ean tu\u1ea7n:', `Tu\u1ea7n ${overviewWeeks().length + 1}`) || '';
    localStorage.setItem(SCHEDULE_OVERVIEW_WEEK_KEY, nextStart);
    const existing = loadOverviewData(nextStart);
    localStorage.setItem(SCHEDULE_OVERVIEW_DATA_PREFIX + nextStart, JSON.stringify({ ...existing, note, cells: existing.cells || {}, styles: existing.styles || {} }));
    rememberOverviewWeek(nextStart, note);
    scheduleOverviewEditMode = true;
    renderScheduleHome();
  });
  $('#overview-toggle')?.addEventListener('click', () => {
    setScheduleOverviewCollapsed(!scheduleOverviewCollapsed());
    loadScheduleHome();
  });
  $('#overview-copy-excel')?.addEventListener('click', (event) => copyOverviewToExcel(event.currentTarget));
  $('#overview-download-excel')?.addEventListener('click', (event) => downloadOverviewExcel(event.currentTarget));
  $('#overview-copy-image')?.addEventListener('click', (event) => copyOverviewImage(event.currentTarget));
  $('#overview-edit')?.addEventListener('click', () => {
    if (scheduleOverviewEditMode) {
      saveOverviewFromDom();
      scheduleOverviewEditMode = false;
    } else {
      scheduleOverviewEditMode = true;
    }
    renderScheduleHome();
  });
  const writeOverviewCell = (cell, value) => {
    cell.textContent = value;
    cell.classList.toggle('has-value', Boolean(String(value || '').trim()));
    addOverviewResizeHandles(cell);
  };
  root.querySelectorAll('[data-overview-cell]').forEach((cell) => {
    cell.contentEditable = 'true';
    cell.spellcheck = false;
    cell.addEventListener('input', () => {
      cell.classList.toggle('has-value', Boolean(cell.textContent.trim()));
      if (cell.classList.contains('overview-selected-cell') && selectedTargets().length === 1 && contentInput) {
        contentInput.value = cell.textContent.trim();
      }
    });
    cell.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') || '';
      if (pasteGridIntoTable(root.querySelector('table'), cell, text, writeOverviewCell)) event.preventDefault();
    });
    cell.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        if (fillSelectedFromFirst(selectedTargets())) {
          event.preventDefault();
          syncPanel();
        }
      }
    });
  });
  root.querySelectorAll('[data-overview-cell], .overview-selectable-box').forEach((target) => {
    target.addEventListener('click', (event) => {
      if (!scheduleOverviewEditMode) return;
      const item = event.target.closest('[data-overview-cell], .overview-selectable-box');
      if (!item || !root.contains(item)) return;
      event.stopPropagation();
      selectTarget(item, event.ctrlKey || event.metaKey);
    });
  });
  contentInput?.addEventListener('input', () => {
    const targets = selectedTargets();
    if (targets.length === 1) applyStyleToSelection(undefined, undefined, { text: contentInput.value });
  });
  $('#overview-apply-cell')?.addEventListener('click', () => {
    const text = contentInput?.value ?? '';
    const applyText = selectedTargets().length === 1 || text.trim();
    applyStyleToSelection(bgInput?.value || '', fgInput?.value || '', {
      ...(applyText ? { text } : {}),
      width: widthInput?.value.trim() || '',
      height: heightInput?.value.trim() || ''
    });
  });
  bgInput?.addEventListener('input', () => applyStyleToSelection(bgInput.value, undefined));
  fgInput?.addEventListener('input', () => applyStyleToSelection(undefined, fgInput.value));
  widthInput?.addEventListener('change', () => applyStyleToSelection(undefined, undefined, { width: widthInput.value.trim() }));
  heightInput?.addEventListener('change', () => applyStyleToSelection(undefined, undefined, { height: heightInput.value.trim() }));
  $('#overview-clear-cell')?.addEventListener('click', () => {
    applyStyleToSelection('', '');
    syncPanel();
  });
  root.querySelectorAll('.overview-palette button').forEach((button) => {
    button.addEventListener('click', () => {
      if (bgInput) bgInput.value = button.dataset.bg || '#ffffff';
      if (fgInput) fgInput.value = button.dataset.fg || '#111827';
      applyStyleToSelection(button.dataset.bg || '', button.dataset.fg || '');
    });
  });
  $('#overview-add-legend')?.addEventListener('click', () => {
    saveOverviewFromDom();
    const weekStart = overviewWeekStart();
    const data = loadOverviewData(weekStart);
    data.legend.push({ code: '', text: '', backgroundColor: '#ffffff', color: '#111827' });
    localStorage.setItem(SCHEDULE_OVERVIEW_DATA_PREFIX + weekStart, JSON.stringify(data));
    renderScheduleHome();
  });
}

function renderScheduleHome() {
  const target = $('#final-schedule-result');
  if (!target || scheduleClassId) return;
  const groups = buildSectorGroups(teacherClasses).filter((group) => group.classes.length);
  if (!groups.length) {
    target.innerHTML = '<p class="placeholder">Chưa có lớp để lập lịch.</p>';
    return;
  }
  const expanded = scheduleExpandedSectorIds();
  const overviewHtml = isOwner() ? renderScheduleOverview() : '';
  target.innerHTML = `${overviewHtml}<div class="schedule-directory"><div class="schedule-directory-head"><h3>L\u1ecbch chia theo l\u1edbp</h3><p class="hint">M\u1edf t\u1eebng l\u1edbp, b\u1ea5m tr\u1ef1c ti\u1ebfp v\u00e0o bu\u1ed5i \u0111\u1ec3 ch\u1ecdn LR/L/R/W/S, ki\u1ec3m tra ho\u1eb7c Off.</p></div>${groups.map((group) => {
    const open = expanded.has(String(group.id));
    return `<section class="schedule-sector${open ? ' expanded' : ''}">
      <button class="schedule-sector-head" type="button" data-sector="${escapeHtml(group.id)}">
        <span>${open ? '&#9662;' : '&#9656;'}</span>
        <b>${escapeHtml(group.name)}</b>
        <small>${group.classes.length} lớp</small>
      </button>
      <div class="schedule-sector-classes${open ? '' : ' hidden'}">
        ${group.classes.map((cls) => `<a href="${escapeHtml(scheduleClassUrl(cls.id))}" class="schedule-class-link" data-class-id="${escapeHtml(cls.id)}">${escapeHtml(cls.name)}<span>&#8250;</span></a>`).join('')}
      </div>
    </section>`;
  }).join('')}</div>`;
  wireScheduleOverview();
  target.querySelectorAll('.schedule-sector-head').forEach((button) => {
    button.addEventListener('click', () => toggleScheduleSector(button.dataset.sector));
  });
  target.querySelectorAll('.schedule-class-link').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openScheduleClass(link.dataset.classId);
    });
  });
}

function localIsoDate(date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 10);
}

function mondayOf(value = new Date()) {
  const date = new Date(value);
  date.setHours(12, 0, 0, 0);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function shortDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

function dayDateLabel(weekStart, dayIndex) {
  const date = addDays(new Date(`${weekStart}T12:00:00`), dayIndex);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function overviewDayLabel(weekStart, dayIndex) {
  return `${dayIndex === 6 ? 'Ch\u1ee7 nh\u1eadt' : `Th\u1ee9 ${dayIndex + 2}`} (${dayDateLabel(weekStart, dayIndex)})`;
}

function normalizeOverviewDayHeaderValue(value, label, dayIndex, weekStart) {
  const raw = String(value || '').trim();
  if (!raw) return label;
  const date = dayDateLabel(weekStart, dayIndex);
  const oldShort = (DAYS_SHORT[dayIndex] || DAYS[dayIndex] || '').trim();
  const oldFull = (DAYS[dayIndex] || '').trim();
  const compact = raw.replace(/\s+/g, '');
  const legacyCandidates = [
    `${oldShort}${date}`,
    `${oldShort}(${date})`,
    `${oldShort}-${date}`,
    `${oldFull}${date}`,
    `${oldFull}(${date})`,
    `T${dayIndex + 2}${date}`,
    `T${dayIndex + 2}(${date})`,
    dayIndex === 6 ? `CN${date}` : '',
    dayIndex === 6 ? `CN(${date})` : ''
  ].filter(Boolean).map((item) => item.replace(/\s+/g, ''));
  if (legacyCandidates.includes(compact)) return label;
  if (/^(T[2-8]|CN)\d{2}\/\d{2}$/i.test(compact)) return label;
  return raw;
}

function weekRangeText(weekStart) {
  return `${shortDate(weekStart)}–${shortDate(localIsoDate(addDays(new Date(`${weekStart}T12:00:00`), 6)))}`;
}

function defaultWeekTitle(weekStart) {
  const date = new Date(`${weekStart}T12:00:00`);
  const jan4 = new Date(date.getFullYear(), 0, 4, 12);
  const firstMonday = mondayOf(jan4);
  const week = Math.floor((mondayOf(date) - firstMonday) / 604800000) + 1;
  return `Tuần ${week}`;
}

async function openScheduleClass(classId, options = {}) {
  const target = $('#final-schedule-result');
  if (!target || !teacherSession) return;
  const switchingClass = scheduleClassId && scheduleClassId !== classId;
  if (switchingClass) scheduleSelectedWeekStart = '';
  scheduleClassId = classId;
  if (options.updateUrl !== false) history.pushState({ scheduleClassId: classId }, '', scheduleClassUrl(classId));
  target.innerHTML = '<p class="placeholder">Đang tải lịch lớp...</p>';
  try {
    if (!teacherDirectory.length) await loadTeacherDirectory();
    const weekStart = options.weekStart || scheduleSelectedWeekStart || null;
    scheduleEditorData = await api(`/classes/${classId}/schedule`, {
      method: 'GET',
      body: JSON.stringify({ weekStart })
    });
    scheduleSelectedWeekStart = scheduleEditorData.selectedWeekStart || scheduleEditorData.currentWeekStart;
    scheduleDirty = false;
    renderScheduleEditor();
  } catch (err) {
    target.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function lessonStartsFromEditor() {
  const starts = scheduleEditorData?.lessonStarts || {};
  return {
    S: Math.max(1, Number($('#lesson-start-s')?.value || starts.S || 1)),
    W: Math.max(1, Number($('#lesson-start-w')?.value || starts.W || 1)),
    LR: Math.max(1, Number($('#lesson-start-lr')?.value || starts.LR || 1)),
    L: Math.max(1, Number($('#lesson-start-l')?.value || starts.L || 1)),
    R: Math.max(1, Number($('#lesson-start-r')?.value || starts.R || 1)),
    COURSE: Math.max(1, Number($('#lesson-start-course')?.value || starts.COURSE || 1))
  };
}

function courseKindFromEditor() {
  return $('#planner-course-kind')?.value === 'grammar' ? 'grammar' : (scheduleEditorData?.courseKind === 'grammar' ? 'grammar' : 'skills');
}

function plannerLessonTypes(courseKind = courseKindFromEditor()) {
  return courseKind === 'grammar'
    ? [
      { type: 'LESSON', label: 'H\u1ecdc' },
      { type: 'MT', label: 'MT' },
      { type: 'FT', label: 'FT' },
      { type: 'OFF', label: 'Off' }
    ]
    : ['LR', 'L', 'R', 'W', 'S', 'MT', 'FT', 'OFF'].map((type) => ({ type, label: type === 'OFF' ? 'Off' : type }));
}

function plannerSlotDisplayHtml(label, courseNo, courseKind = courseKindFromEditor()) {
  const lesson = displayLessonLabel(label);
  const type = scheduleLessonTypeFromLabel(label, courseKind);
  if (!label && !courseNo) return '&middot;';
  if (type === 'OFF') return '<span class="planner-course-no planner-off-label">Off</span>';
  return `${courseNo ? `<span class="planner-course-no">${escapeHtml(courseNo)}</span>` : ''}${courseKind !== 'grammar' && lesson ? `<span class="planner-skill-label">${escapeHtml(lesson)}</span>` : ''}`;
}

function updatePlannerSlotDisplay(cell) {
  const target = cell?.querySelector('.slot-lesson');
  if (!target) return;
  target.innerHTML = plannerSlotDisplayHtml(cell.dataset.lesson || '', cell.dataset.courseNo || '');
  const hasLesson = Boolean(cell.dataset.lesson || cell.dataset.courseNo);
  cell.classList.toggle('has-lesson', hasLesson);
  cell.classList.toggle('off-slot', cell.dataset.lessonType === 'OFF');
  cell.classList.toggle('assessment-slot', ['MT', 'FT'].includes(cell.dataset.lessonType));
}

function resequenceScheduleWeek() {
  const starts = lessonStartsFromEditor();
  const before = scheduleEditorData?.sequenceBefore || {};
  const counters = {};
  ['LR', 'L', 'R', 'W', 'S'].forEach((type) => {
    counters[type] = Math.max(starts[type] - 1, Number(before[type] || 0));
  });
  let course = Math.max(starts.COURSE - 1, Number(before.COURSE || 0));
  const carriedAssessment = scheduleEditorData?.pendingAssessmentBefore || {};
  let pendingAssessment = ['MT', 'FT'].includes(carriedAssessment.type)
    && Number(carriedAssessment.course) > 0
    ? { type: carriedAssessment.type, course: Number(carriedAssessment.course) }
    : null;
  const courseKind = courseKindFromEditor();
  const cells = [...document.querySelectorAll('.week-slot.current-slot')]
    .sort((left, right) => {
      const [leftDay, leftSession] = String(left.dataset.slot).split('-').map(Number);
      const [rightDay, rightSession] = String(right.dataset.slot).split('-').map(Number);
      return leftDay - rightDay || leftSession - rightSession;
    });
  cells.forEach((cell) => {
    let type = cell.dataset.lessonType || scheduleLessonTypeFromLabel(cell.dataset.lesson, courseKind);
    if (courseKind === 'grammar' && !['MT', 'FT', 'OFF'].includes(type)) type = 'LESSON';
    cell.dataset.lessonType = type || '';
    if (!type) {
      cell.dataset.lesson = '';
      cell.dataset.courseNo = '';
      updatePlannerSlotDisplay(cell);
      return;
    }
    if (type === 'OFF') {
      cell.dataset.lesson = 'OFF';
      cell.dataset.courseNo = '';
      pendingAssessment = null;
      updatePlannerSlotDisplay(cell);
      return;
    }
    if (type === 'MT' || type === 'FT') {
      if (pendingAssessment?.type === type) {
        cell.dataset.lesson = `${type}2`;
        cell.dataset.courseNo = `${pendingAssessment.course}b`;
        pendingAssessment = null;
      } else {
        course += 1;
        cell.dataset.lesson = `${type}1`;
        cell.dataset.courseNo = `${course}a`;
        pendingAssessment = { type, course };
      }
      updatePlannerSlotDisplay(cell);
      return;
    }
    pendingAssessment = null;
    course += 1;
    cell.dataset.courseNo = String(course);
    if (courseKind === 'grammar' || type === 'LESSON') {
      cell.dataset.lessonType = 'LESSON';
      cell.dataset.lesson = 'LESSON';
    } else {
      counters[type] = (counters[type] || 0) + 1;
      cell.dataset.lesson = `${type}${counters[type]}`;
    }
    updatePlannerSlotDisplay(cell);
  });
  const summary = $('#planner-sequence-summary');
  if (summary) {
    summary.textContent = `Bu\u1ed5i kho\u00e1 ti\u1ebfp theo: ${course + 1}${courseKind === 'grammar' ? '' : ` \u00b7 LR${counters.LR + 1} \u00b7 L${counters.L + 1} \u00b7 R${counters.R + 1} \u00b7 W${counters.W + 1} \u00b7 S${counters.S + 1}`}`;
  }
}

function collectScheduleSlotValues() {
  const values = {};
  document.querySelectorAll('.week-slot.has-lesson').forEach((cell) => {
    if (cell.dataset.lesson) values[cell.dataset.slot] = cell.dataset.lesson;
  });
  return values;
}

function collectScheduleDetails() {
  const details = {};
  document.querySelectorAll('.week-slot.current-slot').forEach((cell) => {
    const locationValue = String(cell.dataset.location || '').trim();
    const note = String(cell.dataset.note || '').trim();
    const startTime = String(cell.dataset.startTime || '').trim();
    const teacherName = String(cell.dataset.teacherName || '').trim();
    const courseNo = String(cell.dataset.courseNo || '').trim();
    const lessonType = String(cell.dataset.lessonType || '').trim();
    if (locationValue || note || startTime || teacherName || courseNo || lessonType) {
      details[cell.dataset.slot] = { location: locationValue, note, startTime, teacherName, courseNo, lessonType };
    }
  });
  return details;
}

function slotDetailHtml(detail = {}) {
  const locationValue = String(detail.location || '').trim();
  const note = String(detail.note || '').trim();
  const startTime = String(detail.startTime || '').trim();
  const teacherName = String(detail.teacherName || '').trim();
  if (!locationValue && !note && !startTime && !teacherName) return '';
  return `<small class="slot-meta">${startTime ? `<span class="slot-time">🕒 ${escapeHtml(startTime)}</span>` : ''}${teacherName ? `<span class="slot-teacher">👤 ${escapeHtml(teacherName)}</span>` : ''}${locationValue ? `<span class="slot-location">📍 ${escapeHtml(locationValue)}</span>` : ''}${note ? `<span class="slot-note">📝 ${escapeHtml(note)}</span>` : ''}</small>`;
}

function renderScheduleEditor() {
  const target = $('#final-schedule-result');
  const data = scheduleEditorData;
  if (!target || !data) return;
  const sessions = getSessions(data);
  const week = data.selectedWeek || {};
  const historical = data.selectedWeekStart < data.currentWeekStart;
  const currentSlots = new Set(
    data.selectedWeekStart === data.currentWeekStart
      ? data.currentSlots || []
      : week.activeSlots || data.currentSlots || []
  );
  const weekSlots = week.slots || (data.selectedWeekStart === data.currentWeekStart ? data.finalSubjects || {} : {});
  const weekDetails = week.details || {};
  const starts = { S: 1, W: 1, LR: 1, L: 1, R: 1, COURSE: 1, ...(data.lessonStarts || {}) };
  const courseKind = data.courseKind === 'grammar' ? 'grammar' : 'skills';
  const title = week.title || defaultWeekTitle(data.selectedWeekStart);
  let table = '<div class="schedule-scroll"><table class="schedule week-planner"><thead><tr>';
  DAYS.forEach((day, dayIndex) => table += `<th colspan="${sessions.length}">${escapeHtml(day)} (${dayDateLabel(data.selectedWeekStart, dayIndex)})</th>`);
  table += '</tr><tr>';
  DAYS.forEach(() => sessions.forEach((session) => {
    table += `<th><span class="planner-session-label">${escapeHtml(session)}</span></th>`;
  }));
  table += '</tr></thead><tbody><tr>';
  DAYS.forEach((day, dayIdx) => sessions.forEach((session, sessionIdx) => {
    const slotId = `${dayIdx}-${sessionIdx}`;
    const active = currentSlots.has(slotId);
    const lesson = active ? weekSlots[slotId] || '' : '';
    const detail = weekDetails[slotId] || {};
    const lessonType = active ? (detail.lessonType || scheduleLessonTypeFromLabel(lesson, courseKind)) : '';
    const courseNo = active ? detail.courseNo || '' : '';
    table += `<td class="week-slot${active ? ' current-slot' : ''}${lesson || courseNo ? ' has-lesson' : ''}${lessonType === 'OFF' ? ' off-slot' : ''}${['MT', 'FT'].includes(lessonType) ? ' assessment-slot' : ''}${historical ? ' historical-slot' : ''}" data-slot="${slotId}" data-lesson="${escapeHtml(lesson)}" data-lesson-type="${escapeHtml(lessonType)}" data-course-no="${escapeHtml(courseNo)}" data-location="${escapeHtml(detail.location || '')}" data-note="${escapeHtml(detail.note || '')}" data-start-time="${escapeHtml(detail.startTime || '')}" data-teacher-name="${escapeHtml(detail.teacherName || '')}" title="${historical ? 'Tuần cũ chỉ xem' : 'Bấm để chọn nội dung buổi học'}"><span class="slot-lesson">${plannerSlotDisplayHtml(lesson, courseNo, courseKind)}</span>${active ? slotDetailHtml(detail) : ''}${historical ? '' : '<button class="slot-edit-btn" type="button" title="Giờ, giáo viên, địa điểm và ghi chú">✎</button>'}</td>`;
  }));
  table += '</tr></tbody></table></div>';

  target.innerHTML = `
    <div class="planner-topbar">
      <button id="planner-back" class="secondary" type="button">&larr; Các lớp</button>
      <div><h2>${escapeHtml(data.name)}</h2><p>${escapeHtml(title)} (${escapeHtml(weekRangeText(data.selectedWeekStart))})</p></div>
      <div class="planner-week-actions">
        <button id="planner-copy-url" class="planner-copy-url" type="button">Copy URL</button>
        <button id="planner-copy-excel" class="btn-export" type="button">Copy Excel</button>
        <button id="planner-download-excel" class="btn-export btn-download-excel" type="button">Tải Excel</button>
        <button id="planner-copy-image" class="btn-export btn-export-image" type="button">In Ảnh</button>
        <button id="planner-new-week" class="planner-new-week" type="button">+ Tuần mới</button>
        <label>Tuần trước
          <select id="planner-week-select">
            <option value="${escapeHtml(data.currentWeekStart)}"${data.selectedWeekStart === data.currentWeekStart ? ' selected' : ''}>Tuần hiện tại</option>
            ${(data.weeks || []).filter((item) => item.weekStart !== data.currentWeekStart).map((item) => `<option value="${escapeHtml(item.weekStart)}"${data.selectedWeekStart === item.weekStart ? ' selected' : ''}>${escapeHtml(item.title)} (${escapeHtml(weekRangeText(item.weekStart))})</option>`).join('')}
          </select>
        </label>
      </div>
    </div>
    <div class="planner-meta">
      <label>Tên tuần<input id="planner-week-title" value="${escapeHtml(title)}" ${historical ? 'disabled' : ''}/></label>
      <span class="planner-range">Thứ 2–Chủ nhật: <b>${escapeHtml(weekRangeText(data.selectedWeekStart))}</b></span>
    </div>
    ${historical ? '<p class="readonly-note">Tuần trước ở chế độ chỉ xem. Hãy quay về Tuần hiện tại hoặc tạo Tuần mới để chỉnh.</p>' : `<div class="lesson-builder lesson-setup">
      <div class="lesson-builder-head"><b>Thiết lập đánh số tự động</b><span>Chỉ nhập số bắt đầu một lần; sau đó bấm trực tiếp vào từng ô để chọn nội dung.</span></div>
      <div class="lesson-number-help">
        <b>“Buổi khoá bắt đầu từ” là số của buổi học kế tiếp, không phải số phải nhập cho từng ngày.</b>
        Lần đầu nâng cấp lịch, hãy nhập số kế tiếp đúng một lần. Ví dụ khoá đã học 17 buổi thì nhập <b>18</b>. Chọn MT cho hai ô liên tiếp sẽ tự tạo <b>18a/MT1</b> và <b>18b/MT2</b>; buổi thường sau đó là <b>19</b>. Off không tăng số.
      </div>
      <div id="lesson-start-fields" class="lesson-start-fields">
        <label>Loại lớp
          <select id="planner-course-kind">
            <option value="skills"${courseKind === 'skills' ? ' selected' : ''}>Lớp kỹ năng</option>
            <option value="grammar"${courseKind === 'grammar' ? ' selected' : ''}>Lớp ngữ pháp</option>
          </select>
        </label>
        <label>Buổi khoá bắt đầu từ <input id="lesson-start-course" type="number" min="1" value="${escapeHtml(starts.COURSE || 1)}" /></label>
        <div id="lesson-skill-starts" class="lesson-skill-starts${courseKind === 'grammar' ? ' hidden' : ''}">
        <label>S bắt đầu từ <input id="lesson-start-s" type="number" min="1" value="${escapeHtml(starts.S || 1)}" /></label>
        <label>W bắt đầu từ <input id="lesson-start-w" type="number" min="1" value="${escapeHtml(starts.W || 1)}" /></label>
        <label>LR bắt đầu từ <input id="lesson-start-lr" type="number" min="1" value="${escapeHtml(starts.LR || 1)}" /></label>
        <label>L bắt đầu từ <input id="lesson-start-l" type="number" min="1" value="${escapeHtml(starts.L || 1)}" /></label>
        <label>R bắt đầu từ <input id="lesson-start-r" type="number" min="1" value="${escapeHtml(starts.R || 1)}" /></label>
        </div>
        <button id="lesson-config-save" class="primary" type="button">Áp dụng đánh số</button>
        <span id="planner-sequence-summary" class="planner-sequence-summary"></span>
      </div>
    </div>`}
    <p class="planner-help">${historical ? 'Tuần cũ chỉ xem.' : 'Bấm một ô để chọn LR/L/R/W/S/MT/FT/Off. Với lớp ngữ pháp, hệ thống chỉ hiện số buổi khoá. Bấm bút ✎ để thêm giờ, giáo viên, địa điểm và ghi chú; dữ liệu tự đồng bộ sang Lớp học, Sổ chủ nhiệm và Bảng công.'}</p>
    ${table}
    <div class="planner-save-row">
      <span id="planner-save-msg" class="msg"></span>
      ${historical ? '' : '<button id="planner-save" class="primary" type="button">Lưu tuần</button>'}
    </div>`;
  wireScheduleEditor();
  if (!historical) resequenceScheduleWeek();
}

function closeLessonTypePicker() {
  document.querySelector('.lesson-type-picker')?.remove();
  if (lessonPickerOutsideHandler) document.removeEventListener('click', lessonPickerOutsideHandler);
  if (lessonPickerEscapeHandler) document.removeEventListener('keydown', lessonPickerEscapeHandler);
  lessonPickerOutsideHandler = null;
  lessonPickerEscapeHandler = null;
}

function clearPlannerCell(cell) {
  if (!cell) return;
  cell.classList.remove('current-slot', 'has-lesson', 'off-slot', 'assessment-slot');
  ['lesson', 'lessonType', 'courseNo', 'location', 'note', 'startTime', 'teacherName'].forEach((key) => {
    cell.dataset[key] = '';
  });
  refreshSlotDetails(cell);
  updatePlannerSlotDisplay(cell);
}

function openLessonTypePicker(cell) {
  if (!cell || cell.classList.contains('historical-slot')) return;
  closeLessonTypePicker();
  const picker = document.createElement('div');
  picker.className = 'lesson-type-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Chọn nội dung buổi học');
  picker.innerHTML = `
    <b>Chọn nội dung</b>
    <div class="lesson-type-options">
      ${plannerLessonTypes().map((item) => `<button type="button" data-lesson-type="${escapeHtml(item.type)}" class="lesson-type-${escapeHtml(item.type.toLowerCase())}">${escapeHtml(item.label)}</button>`).join('')}
    </div>
    <button type="button" class="lesson-type-clear">Xoá ô</button>`;
  document.body.appendChild(picker);
  const rect = cell.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 24);
  picker.style.width = `${width}px`;
  const preferredLeft = rect.left + rect.width / 2 - width / 2;
  picker.style.left = `${Math.max(12, Math.min(preferredLeft, window.innerWidth - width - 12))}px`;
  const pickerHeight = picker.offsetHeight;
  const below = rect.bottom + 8;
  picker.style.top = `${below + pickerHeight <= window.innerHeight - 12 ? below : Math.max(12, rect.top - pickerHeight - 8)}px`;
  picker.addEventListener('click', (event) => event.stopPropagation());
  picker.querySelectorAll('[data-lesson-type]').forEach((button) => {
    button.addEventListener('click', () => {
      cell.classList.add('current-slot');
      cell.dataset.lessonType = button.dataset.lessonType || '';
      scheduleDirty = true;
      resequenceScheduleWeek();
      closeLessonTypePicker();
    });
  });
  picker.querySelector('.lesson-type-clear')?.addEventListener('click', () => {
    clearPlannerCell(cell);
    scheduleDirty = true;
    resequenceScheduleWeek();
    closeLessonTypePicker();
  });
  setTimeout(() => {
    if (!document.body.contains(picker)) return;
    lessonPickerOutsideHandler = (event) => {
      if (!picker.contains(event.target)) closeLessonTypePicker();
    };
    lessonPickerEscapeHandler = (event) => {
      if (event.key === 'Escape') closeLessonTypePicker();
    };
    document.addEventListener('click', lessonPickerOutsideHandler);
    document.addEventListener('keydown', lessonPickerEscapeHandler);
  }, 0);
}

function refreshSlotDetails(cell) {
  cell.querySelector('.slot-meta')?.remove();
  const pencil = cell.querySelector('.slot-edit-btn');
  const html = slotDetailHtml({
    location: cell.dataset.location,
    note: cell.dataset.note,
    startTime: cell.dataset.startTime,
    teacherName: cell.dataset.teacherName
  });
  if (html) pencil?.insertAdjacentHTML('beforebegin', html);
}

function openSlotDetailsDialog(cell) {
  const currentLocation = String(cell.dataset.location || '');
  const presets = ['Tầng 1', 'Tầng 2', 'CS2'];
  const selectedPreset = !currentLocation ? 'Tầng 1' : presets.includes(currentLocation) ? currentLocation : 'custom';
  const currentTeacher = String(cell.dataset.teacherName || 'Thầy Tùng');
  const dialog = openMiniDialog('Thông tin buổi học', `
    <div class="slot-dialog-grid">
      <label>Giờ bắt đầu
        <input id="slot-start-time" type="time" value="${escapeHtml(cell.dataset.startTime || '')}" />
      </label>
      <label>Giáo viên
        <select id="slot-teacher">${teacherOptionsHtml(currentTeacher, isOwner())}</select>
      </label>
    </div>
    <input id="slot-teacher-custom" class="hidden" type="text" placeholder="Nhập tên hiển thị tuỳ chỉnh..." />
    <label>Địa điểm
      <select id="slot-location-preset">
        ${presets.map((value) => `<option value="${escapeHtml(value)}"${selectedPreset === value ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('')}
        <option value="custom"${selectedPreset === 'custom' ? ' selected' : ''}>Địa điểm khác...</option>
      </select>
    </label>
    <input id="slot-location-custom" type="text" value="${escapeHtml(selectedPreset === 'custom' ? currentLocation : '')}" placeholder="Nhập địa điểm tuỳ chỉnh..." />
    <label>Ghi chú
      <textarea id="slot-note" rows="3" placeholder="Ghi chú...">${escapeHtml(cell.dataset.note || '')}</textarea>
    </label>`, async (overlay) => {
      const preset = overlay.querySelector('#slot-location-preset')?.value || 'Tầng 1';
      const custom = overlay.querySelector('#slot-location-custom')?.value.trim() || '';
      const teacherSelect = overlay.querySelector('#slot-teacher');
      const teacherCustom = overlay.querySelector('#slot-teacher-custom')?.value.trim() || '';
      if (teacherSelect?.value === '__custom__' && !teacherCustom) throw new Error('Nhập tên giáo viên tuỳ chỉnh.');
      cell.dataset.location = preset === 'custom' ? custom : preset;
      cell.dataset.note = overlay.querySelector('#slot-note')?.value.trim() || '';
      cell.dataset.startTime = overlay.querySelector('#slot-start-time')?.value || '';
      cell.dataset.teacherName = teacherSelect?.value === '__custom__' ? teacherCustom : (teacherSelect?.value || '');
      if (!cell.classList.contains('current-slot')) cell.classList.add('current-slot');
      refreshSlotDetails(cell);
      scheduleDirty = true;
    });
  dialog.querySelector('#slot-location-custom')?.addEventListener('input', () => {
    const select = dialog.querySelector('#slot-location-preset');
    if (select) select.value = 'custom';
  });
  dialog.querySelector('#slot-teacher')?.addEventListener('change', (event) => {
    dialog.querySelector('#slot-teacher-custom')?.classList.toggle('hidden', event.target.value !== '__custom__');
    if (event.target.value === '__custom__') dialog.querySelector('#slot-teacher-custom')?.focus();
  });
}

function wireScheduleEditor() {
  const plannerRoot = $('#final-schedule-result');
  $('#planner-back')?.addEventListener('click', () => {
    scheduleClassId = null;
    scheduleEditorData = null;
    scheduleSelectedWeekStart = '';
    history.pushState({}, '', appBasePath());
    renderScheduleHome();
  });
  $('#planner-week-select')?.addEventListener('change', (event) => {
    scheduleSelectedWeekStart = event.target.value;
    openScheduleClass(scheduleClassId, { updateUrl: false, weekStart: scheduleSelectedWeekStart });
  });
  $('#planner-new-week')?.addEventListener('click', openNewWeekDialog);
  $('#planner-copy-url')?.addEventListener('click', async (event) => {
    try {
      await navigator.clipboard.writeText(publicScheduleUrl(scheduleClassId));
      showCopiedUrl(event.currentTarget);
    } catch (err) {
      setExportButtonStatus(event.currentTarget, 'Copy lỗi', true);
    }
  });
  $('#planner-copy-excel')?.addEventListener('click', (event) => openExportStyleDialog(plannerRoot, event.currentTarget, 'excel'));
  $('#planner-download-excel')?.addEventListener('click', (event) => openExportStyleDialog(plannerRoot, event.currentTarget, 'xlsx'));
  $('#planner-copy-image')?.addEventListener('click', (event) => openExportStyleDialog(plannerRoot, event.currentTarget, 'image'));
  $('#lesson-config-save')?.addEventListener('click', () => {
    scheduleEditorData.lessonStarts = lessonStartsFromEditor();
    resequenceScheduleWeek();
    const button = $('#lesson-config-save');
    setExportButtonStatus(button, 'Đã áp dụng');
    scheduleDirty = true;
  });
  document.querySelectorAll('#lesson-start-fields input').forEach((input) => {
    input.addEventListener('change', () => {
      scheduleEditorData.lessonStarts = lessonStartsFromEditor();
      resequenceScheduleWeek();
      scheduleDirty = true;
    });
  });
  $('#planner-course-kind')?.addEventListener('change', (event) => {
    const courseKind = event.target.value === 'grammar' ? 'grammar' : 'skills';
    scheduleEditorData.courseKind = courseKind;
    $('#lesson-skill-starts')?.classList.toggle('hidden', courseKind === 'grammar');
    document.querySelectorAll('.week-slot.current-slot').forEach((cell) => {
      const type = cell.dataset.lessonType || scheduleLessonTypeFromLabel(cell.dataset.lesson, courseKind);
      if (courseKind === 'grammar' && !['MT', 'FT', 'OFF'].includes(type)) {
        cell.dataset.lessonType = 'LESSON';
      } else if (courseKind === 'skills' && type === 'LESSON') {
        cell.dataset.lessonType = 'LR';
      }
    });
    resequenceScheduleWeek();
    scheduleDirty = true;
  });
  document.querySelectorAll('.week-slot').forEach((cell) => {
    cell.addEventListener('click', (event) => {
      if (cell.classList.contains('historical-slot')) return;
      if (event.target.closest('.slot-edit-btn')) return;
      openLessonTypePicker(cell);
    });
  });
  document.querySelectorAll('.slot-edit-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openSlotDetailsDialog(button.closest('.week-slot'));
    });
    button.addEventListener('dblclick', (event) => event.stopPropagation());
  });
  document.querySelectorAll('#planner-week-title').forEach((input) => {
    input.addEventListener('input', () => { scheduleDirty = true; });
  });
  $('#planner-save')?.addEventListener('click', saveScheduleWeek);
}

function openNewWeekDialog() {
  const weeks = scheduleEditorData?.weeks || [];
  const latest = weeks.length ? new Date(`${weeks[0].weekStart}T12:00:00`) : new Date(`${scheduleEditorData.currentWeekStart}T12:00:00`);
  const proposed = localIsoDate(addDays(latest, 7));
  const dialog = openMiniDialog('Tạo tuần mới', `
    <label>Tên tuần<input id="new-week-title" value="${escapeHtml(defaultWeekTitle(proposed))}" /></label>
    <label>Chọn một ngày trong tuần<input id="new-week-date" type="date" value="${escapeHtml(proposed)}" /></label>
    <p id="new-week-range" class="hint"></p>`, async (overlay) => {
      const selectedDate = overlay.querySelector('#new-week-date')?.value;
      if (!selectedDate) throw new Error('Hãy chọn ngày cho tuần mới.');
      const monday = localIsoDate(mondayOf(new Date(`${selectedDate}T12:00:00`)));
      const title = overlay.querySelector('#new-week-title')?.value.trim() || defaultWeekTitle(monday);
      scheduleSelectedWeekStart = monday;
      const fresh = await api(`/classes/${scheduleClassId}/schedule`, {
        method: 'GET',
        body: JSON.stringify({ weekStart: monday })
      });
      scheduleEditorData = {
        ...fresh,
        selectedWeekStart: monday,
        selectedWeek: {
          weekStart: monday,
          title,
          slots: {},
          details: {},
          activeSlots: fresh.currentSlots || scheduleEditorData.currentSlots || []
        }
      };
      scheduleDirty = true;
      setTimeout(renderScheduleEditor, 0);
    });
  const dateInput = dialog.querySelector('#new-week-date');
  const updateRange = () => {
    const monday = localIsoDate(mondayOf(new Date(`${dateInput.value}T12:00:00`)));
    dialog.querySelector('#new-week-range').textContent = `Thứ 2–Chủ nhật: ${weekRangeText(monday)}`;
  };
  dateInput.addEventListener('change', updateRange);
  updateRange();
}

async function saveScheduleWeek() {
  const button = $('#planner-save');
  const msg = $('#planner-save-msg');
  resequenceScheduleWeek();
  const sessions = getSessions(scheduleEditorData);
  const currentSlots = [...document.querySelectorAll('.week-slot.current-slot')].map((cell) => cell.dataset.slot);
  const courseKind = courseKindFromEditor();
  const body = {
    weekStart: scheduleEditorData.selectedWeekStart,
    title: $('#planner-week-title')?.value.trim() || defaultWeekTitle(scheduleEditorData.selectedWeekStart),
    slots: collectScheduleSlotValues(),
    details: collectScheduleDetails(),
    currentSlots,
    sessions,
    lessonStarts: lessonStartsFromEditor(),
    courseKind
  };
  button.disabled = true;
  showMsg(msg, 'Đang lưu...', '');
  try {
    await api(`/classes/${scheduleClassId}/schedule-settings`, {
      method: 'POST',
      body: JSON.stringify({ courseKind: body.courseKind, lessonStarts: body.lessonStarts })
    });
    await api(`/classes/${scheduleClassId}/schedule`, { method: 'POST', body: JSON.stringify(body) });
    await api(`/classes/${scheduleClassId}/schedule-meta`, {
      method: 'POST', body: JSON.stringify({ weekStart: body.weekStart, details: body.details })
    });
    showMsg(msg, 'Đã lưu và đồng bộ sang Lớp học, Sổ chủ nhiệm và Bảng công.', 'ok');
    scheduleDirty = false;
    scheduleSelectedWeekStart = body.weekStart;
    await loadClasses();
    await openScheduleClass(scheduleClassId, { updateUrl: false, weekStart: body.weekStart });
  } catch (err) {
    showMsg(msg, err.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function initPublicScheduleViewer() {
  const root = $('#public-schedule');
  if (!root) return;
  const copyButton = $('#public-copy-url');
  copyButton?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showCopiedUrl(copyButton);
    } catch (err) {
      setExportButtonStatus(copyButton, 'Copy lỗi', true);
    }
  });
  try {
    root.innerHTML = '<p class="placeholder">Đang tải lịch lớp...</p>';
    const route = new URLSearchParams(location.search).get('class') || '';
    const classes = await api('/classes');
    const targetClass = classes.find((cls) => cls.id === route || slugifyClassName(cls.name) === route);
    if (!targetClass) throw new Error('Không tìm thấy lớp trong liên kết này.');
    const data = await api('/public-schedule', {
      method: 'POST',
      body: JSON.stringify({ classId: targetClass.id })
    });
    document.title = `${data.name} - Lịch học`;
    renderPublicSchedule(data);
  } catch (err) {
    root.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderPublicSchedule(data) {
  const root = $('#public-schedule');
  if (!root) return;
  const sessions = getSessions(data);
  const activeSlots = new Set(data.activeSlots || []);
  const lessons = data.slots || {};
  const details = data.details || {};
  let table = '<div class="schedule-scroll"><table class="schedule week-planner public-week-planner"><thead><tr>';
  DAYS.forEach((day, dayIndex) => {
    table += `<th colspan="${sessions.length}">${escapeHtml(day)} (${dayDateLabel(data.weekStart, dayIndex)})</th>`;
  });
  table += '</tr><tr>';
  DAYS.forEach(() => sessions.forEach((session) => {
    table += `<th><span class="planner-session-label">${escapeHtml(session)}</span></th>`;
  }));
  table += '</tr></thead><tbody><tr>';
  DAYS.forEach((day, dayIndex) => sessions.forEach((session, sessionIndex) => {
    const slotId = `${dayIndex}-${sessionIndex}`;
    const active = activeSlots.has(slotId);
    const rawLesson = lessons[slotId] || '';
    const detail = details[slotId] || {};
    const lessonType = detail.lessonType || scheduleLessonTypeFromLabel(rawLesson, data.courseKind);
    table += `<td class="week-slot public-week-slot${active ? ' current-slot' : ''}${rawLesson || detail.courseNo ? ' has-lesson' : ''}${lessonType === 'OFF' ? ' off-slot' : ''}${['MT', 'FT'].includes(lessonType) ? ' assessment-slot' : ''}"><span class="slot-lesson">${plannerSlotDisplayHtml(rawLesson, detail.courseNo || '', data.courseKind)}</span>${active ? slotDetailHtml(detail) : ''}</td>`;
  }));
  table += '</tr></tbody></table></div>';
  root.innerHTML = `
    <div class="public-schedule-title">
      <div><h2>${escapeHtml(data.name)}</h2><p>${escapeHtml(data.title)} (${escapeHtml(weekRangeText(data.weekStart))})</p></div>
    </div>
    ${table}
    <p class="hint public-readonly-note">Lịch chỉ xem, được cập nhật từ giáo viên.</p>`;
}


function homeroomRecordTypes() {
  return [
    { key: 'LR', label: 'LR-rec' },
    { key: 'S', label: 'S-rec' },
    { key: 'W', label: 'W-rec' },
    { key: 'ALL', label: 'To\u00e0n b\u1ed9' }
  ];
}

function homeroomStorageKey(classId, type) {
  return `${HOMEROOM_DATA_PREFIX}${classId}:${type}`;
}

function homeroomMetaRows(type) {
  return type === 'LR' ? 2 : 6;
}

function defaultHomeroomColCount(type, lessonCount = 3) {
  return 3 + Math.max(1, Number(lessonCount) || 3) * 4;
}

function homeroomSkillName(type) {
  if (type === 'S') return 'S';
  if (type === 'W') return 'W';
  return 'LR';
}

function homeroomDefaultCells(cls, type, lessonCount = 3, scheduleLessons = []) {
  const cells = {};
  const metaRows = homeroomMetaRows(type);
  const students = sortSubmissions((cls.submissions || []).filter((item) => item.status === 'approved'));
  const skill = homeroomSkillName(type);
  const set = (r, c, value) => { if (value !== undefined && value !== null) cells[`${r}|${c}`] = String(value); };
  set(0, 1, cls.name || 'L\u1edbp');
  Array.from({ length: lessonCount }).forEach((lesson, index) => {
    const base = 3 + index * 4;
    const synced = scheduleLessons[index] || {};
    const dateText = [
      synced.dayName || '',
      synced.lessonDate ? formatDobInputValue(synced.lessonDate) : '',
      synced.startTime || synced.sessionName || ''
    ].filter(Boolean).join(' · ');
    set(0, base, `B${index + 1}`);
    set(0, base + 1, synced.lessonLabel || `${skill}${index + 1}`);
    set(0, base + 2, dateText || 'Ng\u00e0y');
    set(0, base + 3, synced.teacherName || 'GV');
  });
  if (type !== 'LR') {
    set(1, 1, 'N\u1ed9i dung h\u1ecdc');
    set(2, 1, 'Ghi ch\u00fa l\u1edbp h\u1ecdc');
    set(3, 1, 'BTVN');
    set(4, 1, 'Ghi ch\u00fa cho h\u1ecdc sinh');
  }
  const headerRow = metaRows - 1;
  set(headerRow, 0, '#');
  set(headerRow, 1, 'H\u1ecdc vi\u00ean');
  set(headerRow, 2, 'L\u01b0u \u00fd');
  Array.from({ length: lessonCount }).forEach((lesson, index) => {
    const base = 3 + index * 4;
    set(headerRow, base, '\u0110i\u1ec3m danh');
    set(headerRow, base + 1, 'M');
    set(headerRow, base + 2, type === 'S' ? 'Nh\u1eadn x\u00e9t BTVN' : 'T\u1eeb v\u1ef1ng');
    set(headerRow, base + 3, type === 'W' ? 'BTVN' : 'Ghi ch\u00fa');
  });
  const rows = metaRows + students.length;
  for (let index = 0; index < rows - metaRows; index++) {
    const row = metaRows + index;
    const student = students[index];
    set(row, 0, index + 1);
    set(row, 1, student ? displayName(student, countNames(students)) : '');
    set(row, 2, '');
  }
  return { cells, rowCount: rows, colCount: defaultHomeroomColCount(type, lessonCount), metaRows, lessonCount };
}

function inferHomeroomLessonCount(data = {}) {
  const keys = [...Object.keys(data.cells || {}), ...Object.keys(data.styles || {})];
  const maxCol = keys.reduce((max, key) => {
    const col = Number(String(key).split('|')[1]);
    return Number.isFinite(col) ? Math.max(max, col) : max;
  }, 14);
  return Math.max(3, Math.ceil(Math.max(0, maxCol - 2) / 4));
}

function sameStyleColor(a = {}, b = {}) {
  const left = normalizeOverviewStyle(a);
  const right = normalizeOverviewStyle(b);
  return (left.backgroundColor || '') === (right.backgroundColor || '') && (left.color || '') === (right.color || '');
}

function compactHomeroomStyles(styles = {}, type = '', lessonCount = 3, insertedRows = [], insertedCols = []) {
  if (!type) return styles;
  const metaRows = homeroomMetaRows(type);
  return Object.fromEntries(Object.entries(styles).filter(([key, style]) => {
    if (style?.width || style?.height) return true;
    const [row, col] = String(key).split('|').map(Number);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return false;
    if (insertedRows.includes(row) || insertedCols.includes(col)) return true;
    const mappedRow = mapHomeroomVisualIndex(row, insertedRows).base;
    const mappedCol = mapHomeroomVisualIndex(col, insertedCols).base;
    return !sameStyleColor(style, homeroomDefaultStyle(mappedRow, mappedCol, type, metaRows, lessonCount))
      && !sameStyleColor(style, legacyHomeroomDefaultStyle(mappedRow, mappedCol, type, metaRows));
  }));
}

function normalizeInsertedIndexes(value) {
  const source = (Array.isArray(value) ? value : String(value || '').split(','))
    .filter((item) => String(item).trim() !== '');
  return [...new Set(source.map(Number).filter((item) => Number.isInteger(item) && item >= 0))].sort((a, b) => a - b);
}

function mapHomeroomVisualIndex(index, insertedIndexes = []) {
  const inserted = insertedIndexes.includes(index);
  const offset = insertedIndexes.filter((item) => item < index).length;
  return { inserted, base: index - offset };
}

function homeroomVisualIndexForBase(baseIndex, insertedIndexes = []) {
  let visual = Math.max(0, Number(baseIndex) || 0);
  insertedIndexes.forEach((position) => {
    if (position <= visual) visual++;
  });
  return visual;
}

function excelColumnName(index) {
  let value = Math.max(0, Number(index) || 0) + 1;
  let name = '';
  while (value > 0) {
    value--;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function normalizeHomeroomData(data = {}, type = '') {
  const lessonCount = Math.max(3, Number(data.lessonCount || data.lesson_count) || inferHomeroomLessonCount(data));
  let insertedRows = normalizeInsertedIndexes(data.insertedRows || data.inserted_rows);
  let insertedCols = normalizeInsertedIndexes(data.insertedCols || data.inserted_cols);
  if (!Number(data.sheetVersion || data.sheet_version) && insertedRows.length === 1 && insertedRows[0] === 0 && insertedCols.length === 1 && insertedCols[0] === 0) {
    insertedRows = [];
    insertedCols = [];
  }
  const styles = Object.fromEntries(Object.entries(data.styles || {}).map(([key, style]) => [key, { ...normalizeOverviewStyle(style), width: style?.width || '', height: style?.height || '' }]));
  return {
    cells: Object.fromEntries(Object.entries(data.cells || {}).filter(([, value]) => String(value || '').trim())),
    styles: compactHomeroomStyles(styles, type, lessonCount, insertedRows, insertedCols),
    lessonCount,
    extraRows: Math.max(0, Number(data.extraRows || data.extra_rows) || 0),
    extraCols: Math.max(0, Number(data.extraCols || data.extra_cols) || 0),
    insertedRows,
    insertedCols,
    sheetVersion: 2
  };
}

function emptyHomeroomData(data = {}) {
  return !Object.keys(data.cells || {}).length
    && !Object.keys(data.styles || {}).length
    && Math.max(3, Number(data.lessonCount || data.lesson_count) || 3) <= 3
    && !Number(data.extraRows || data.extra_rows)
    && !Number(data.extraCols || data.extra_cols)
    && !normalizeInsertedIndexes(data.insertedRows || data.inserted_rows).length
    && !normalizeInsertedIndexes(data.insertedCols || data.inserted_cols).length;
}

function loadLocalHomeroomData(classId, type) {
  try {
    const raw = localStorage.getItem(homeroomStorageKey(classId, type));
    return normalizeHomeroomData(JSON.parse(raw || '{}'), type);
  } catch (err) {
    return { cells: {}, styles: {}, lessonCount: 3, extraRows: 0, extraCols: 0, insertedRows: [], insertedCols: [] };
  }
}

async function saveHomeroomPayload(classId, type, data) {
  const normalized = normalizeHomeroomData(data, type);
  localStorage.setItem(homeroomStorageKey(classId, type), JSON.stringify(normalized));
  if (SUPABASE_URL && SUPABASE_ANON_KEY && teacherToken()) {
    try {
      await api(`/classes/${classId}/homeroom-record/${encodeURIComponent(type)}`, {
        method: 'POST',
        body: JSON.stringify(normalized)
      });
    } catch (err) {
      console.warn('Không lưu được sổ chủ nhiệm lên Supabase, đã giữ bản local:', err);
    }
  }
}

async function loadHomeroomData(classId, type) {
  const local = loadLocalHomeroomData(classId, type);
  if (!(SUPABASE_URL && SUPABASE_ANON_KEY && teacherToken())) return local;
  try {
    const remote = normalizeHomeroomData(await api(`/classes/${classId}/homeroom-record/${encodeURIComponent(type)}`), type);
    if (emptyHomeroomData(remote) && !emptyHomeroomData(local)) {
      await saveHomeroomPayload(classId, type, local);
      return local;
    }
    localStorage.setItem(homeroomStorageKey(classId, type), JSON.stringify(remote));
    return remote;
  } catch (err) {
    console.warn('Không tải được sổ chủ nhiệm từ Supabase, dùng bản local:', err);
    return local;
  }
}

function styleChangedFromDefault(cell, type, metaRows, lessonCount) {
  const row = cell.dataset.baseRow === '' ? metaRows : Number(cell.dataset.baseRow || 0);
  const col = cell.dataset.baseCol === '' ? defaultHomeroomColCount(type, lessonCount) : Number(cell.dataset.baseCol || 0);
  const defaults = normalizeOverviewStyle(homeroomDefaultStyle(row, col, type, metaRows, lessonCount));
  const bg = cell.dataset.bg || '';
  const fg = cell.dataset.fg || '';
  const width = cell.dataset.width || '';
  const height = cell.dataset.height || '';
  return Boolean(width || height || bg !== (defaults.backgroundColor || '') || fg !== (defaults.color || ''));
}

function collectHomeroomDataFromDom() {
  const root = $('#homeroom-record');
  if (!root || !homeroomClassId || !homeroomRecordType || homeroomRecordType === 'ALL') return null;
  const cells = {};
  const styles = {};
  const metaRows = homeroomMetaRows(homeroomRecordType);
  const lessonCount = Number(root.dataset.lessonCount || 3);
  root.querySelectorAll('[data-homeroom-cell]').forEach((cell) => {
    const key = cell.dataset.homeroomCell;
    const value = cell.textContent.trim();
    const autoValue = cell.dataset.auto || '';
    if (value && value !== autoValue) cells[key] = value;
    const bg = cell.dataset.bg || '';
    const fg = cell.dataset.fg || '';
    const width = cell.dataset.width || '';
    const height = cell.dataset.height || '';
    if (styleChangedFromDefault(cell, homeroomRecordType, metaRows, lessonCount)) styles[key] = { backgroundColor: bg, color: fg, width, height };
  });
  return {
    cells,
    styles,
    lessonCount,
    extraRows: Number(root.dataset.extraRows || 0),
    extraCols: Number(root.dataset.extraCols || 0),
    insertedRows: normalizeInsertedIndexes(root.dataset.insertedRows),
    insertedCols: normalizeInsertedIndexes(root.dataset.insertedCols),
    sheetVersion: 2
  };
}

async function saveHomeroomFromDom() {
  const data = collectHomeroomDataFromDom();
  if (!data) return;
  await saveHomeroomPayload(homeroomClassId, homeroomRecordType, data);
}

function homeroomCellStyle(style = {}) {
  return overviewCellStyle(style);
}

function homeroomDefaultStyle(row, col, type, metaRows, lessonCount = 3) {
  const colors = {
    white: '#ffffff',
    pale: '#fff2cc',
    header: '#ffe599',
    meta: '#ffd966',
    cyan: '#00ffff',
    yellow: '#ffff00',
    blue: '#0000ff',
    red: '#ff0000',
    noteBlue: '#9cc2e5',
    homeworkRed: '#ea9999',
    studentNote: '#deeaf6',
    cream: '#fef2cb'
  };
  const firstExtraCol = 3 + Math.max(1, Number(lessonCount) || 3) * 4;
  if (col >= firstExtraCol) {
    if (row === metaRows - 1) return { backgroundColor: colors.header, color: '#111827' };
    return { backgroundColor: colors.white, color: '#111827' };
  }
  const lessonPos = col >= 3 ? (col - 3) % 4 : -1;
  if (row === 0) {
    if (col === 0) return { backgroundColor: colors.white, color: '#111827' };
    if (col === 1 && type === 'W') return { backgroundColor: colors.red, color: '#ffffff' };
    if (col < 3) return { backgroundColor: colors.pale, color: '#111827' };
    if (lessonPos === 0) return { backgroundColor: colors.cyan, color: '#111827' };
    if (lessonPos === 1) return { backgroundColor: colors.yellow, color: '#111827' };
    if (lessonPos === 2) return { backgroundColor: colors.blue, color: '#ffffff' };
    return { backgroundColor: colors.yellow, color: '#111827' };
  }
  if (type !== 'LR' && row > 0 && row < metaRows - 1) {
    if (col === 0) return { backgroundColor: colors.white, color: '#111827' };
    if (col === 1) return { backgroundColor: colors.meta, color: '#111827' };
    if (col === 2) {
      const rowColors = { 1: colors.cream, 2: colors.noteBlue, 3: colors.homeworkRed, 4: colors.studentNote };
      return { backgroundColor: rowColors[row] || colors.white, color: '#111827' };
    }
    if (row === 1 && lessonPos === 0) return { backgroundColor: colors.yellow, color: '#111827' };
    if (row === 2 && lessonPos === 0) return { backgroundColor: colors.white, color: '#111827' };
    return {};
  }
  if (row === metaRows - 1) return { backgroundColor: colors.header, color: '#111827' };
  if (col === 0) return { backgroundColor: colors.yellow, color: '#111827' };
  if (col === 1) return { backgroundColor: colors.cyan, color: '#111827' };
  if (col >= 3 && lessonPos === 0) return { backgroundColor: colors.pale, color: '#111827' };
  if (type === 'W' && col >= 3 && lessonPos === 1) return { backgroundColor: colors.pale, color: '#111827' };
  return {};
}

function legacyHomeroomDefaultStyle(row, col, type, metaRows) {
  if (row < metaRows) {
    if (row === metaRows - 1) return { backgroundColor: '#dbeafe', color: '#111827' };
    if (col < 3) return { backgroundColor: '#fde68a', color: '#111827' };
    return { backgroundColor: row === 0 ? '#fb923c' : '#fef3c7', color: '#111827' };
  }
  if (col === 0) return { backgroundColor: '#f8fafc', color: '#111827' };
  if (col === 1) return { backgroundColor: '#ffffff', color: '#111827' };
  return {};
}

function isLegacyHomeroomDefaultStyle(style, row, col, type, metaRows) {
  if (!style?.backgroundColor && !style?.color && !style?.width && !style?.height) return false;
  if (style?.width || style?.height) return false;
  const saved = normalizeOverviewStyle(style);
  const legacy = normalizeOverviewStyle(legacyHomeroomDefaultStyle(row, col, type, metaRows));
  return (saved.backgroundColor || '') === (legacy.backgroundColor || '') && (saved.color || '') === (legacy.color || '');
}

async function renderHomeroomTable(cls, type) {
  if (type === 'ALL') {
    return `<div class="placeholder">To\u00e0n b\u1ed9 s\u1ebd g\u1ed9p LR/S/W \u1edf b\u01b0\u1edbc sau. Hi\u1ec7n t\u1ea1i h\u00e3y ch\u1ecdn LR-rec, S-rec ho\u1eb7c W-rec.</div>`;
  }
  const [saved, scheduleLessons] = await Promise.all([
    loadHomeroomData(cls.id, type),
    api(`/classes/${cls.id}/homeroom-sync/${encodeURIComponent(type)}`).catch(() => [])
  ]);
  const lessonCount = Math.max(3, saved.lessonCount || 3, scheduleLessons.length || 0);
  const defaults = homeroomDefaultCells(cls, type, lessonCount, scheduleLessons);
  const extraRows = Math.max(0, Number(saved.extraRows) || 0);
  const extraCols = Math.max(0, Number(saved.extraCols) || 0);
  const insertedRows = normalizeInsertedIndexes(saved.insertedRows);
  const insertedCols = normalizeInsertedIndexes(saved.insertedCols);
  const rowCount = defaults.rowCount + extraRows + insertedRows.length;
  const colCount = defaults.colCount + extraCols + insertedCols.length;
  const palette = overviewPalette();
  let html = `<section id="homeroom-record" class="homeroom-record ${homeroomEditMode ? 'homeroom-editing' : ''}" data-lesson-count="${lessonCount}" data-extra-rows="${extraRows}" data-extra-cols="${extraCols}" data-inserted-rows="${insertedRows.join(',')}" data-inserted-cols="${insertedCols.join(',')}" data-base-rows="${defaults.rowCount}" data-base-cols="${defaults.colCount}">
    <div class="homeroom-record-head">
      <div><h3>${escapeHtml(cls.name)} - ${escapeHtml(type)}-rec</h3><p class="hint">Buổi, thứ/ngày, giờ và giáo viên tự đồng bộ từ tab Lịch. Chọn/kéo vùng như Excel; chuột phải để chèn/xoá; nhấp đúp hoặc F2 để sửa ô.</p></div>
      <div class="homeroom-record-actions">
        <button id="homeroom-copy-excel" class="btn-export" type="button">Copy Excel</button>
        <button id="homeroom-download-excel" class="btn-export btn-download-excel" type="button">T\u1ea3i Excel</button>
        <button id="homeroom-export-image" class="btn-export btn-export-image" type="button">Xu\u1ea5t \u1ea3nh</button>
        <button id="homeroom-add-lesson" type="button">+ Bu\u1ed5i m\u1edbi</button>
        ${homeroomEditMode ? `<button id="homeroom-remove-lesson" class="homeroom-danger-action" type="button">\u2212 Bu\u1ed5i cu\u1ed1i</button><button id="homeroom-add-row" type="button">+ Ch\u00e8n h\u00e0ng</button><button id="homeroom-remove-row" class="homeroom-danger-action" type="button">\u2212 H\u00e0ng</button><button id="homeroom-add-col" type="button">+ Ch\u00e8n c\u1ed9t</button><button id="homeroom-remove-col" class="homeroom-danger-action" type="button">\u2212 C\u1ed9t</button>` : ''}
        <button id="homeroom-edit" type="button">${homeroomEditMode ? 'L\u01b0u record' : 'Ch\u1ec9nh s\u1eeda'}</button>
      </div>
    </div>
    ${homeroomEditMode ? `<div id="homeroom-edit-panel" class="overview-edit-panel homeroom-edit-panel hidden">
      <div class="overview-edit-panel-head"><b>\u0110\u1ecbnh d\u1ea1ng \u00f4</b><small id="homeroom-edit-count">0 \u00f4</small></div>
      <label>N\u1ed9i dung<input id="homeroom-edit-content" placeholder="Nh\u1eadp n\u1ed9i dung..." /></label>
      <div class="overview-panel-row">
        <label>M\u00e0u \u00f4<input id="homeroom-edit-bg" type="color" value="#ffffff" /></label>
        <label>M\u00e0u ch\u1eef<input id="homeroom-edit-fg" type="color" value="#111827" /></label>
        <label>R\u1ed9ng<input id="homeroom-edit-width" type="text" placeholder="vd: 80px" /></label>
        <label>Cao<input id="homeroom-edit-height" type="text" placeholder="vd: 32px" /></label>
      </div>
      <div class="overview-palette">${palette.map((item) => `<button type="button" data-bg="${item.bg}" data-fg="${item.fg}" style="background:${item.bg};color:${item.fg};" title="${item.name}">${item.name}</button>`).join('')}</div>
      <div class="overview-panel-actions"><button id="homeroom-apply-cell" type="button">\u00c1p d\u1ee5ng</button><button id="homeroom-clear-cell" type="button">Xo\u00e1 m\u00e0u</button></div>
      <small>Panel lu\u00f4n n\u1eb1m ph\u00eda tr\u00ean cho d\u1ec5 thao t\u00e1c; gi\u1eef Ctrl \u0111\u1ec3 ch\u1ecdn nhi\u1ec1u \u00f4 v\u00e0 \u00e1p d\u1ee5ng h\u00e0ng lo\u1ea1t.</small>
    </div>` : ''}
    ${homeroomEditMode ? `<div class="homeroom-formula-bar"><output id="homeroom-name-box">A1</output><span class="homeroom-fx">fx</span><input id="homeroom-formula-input" type="text" placeholder="Ch\u1ecdn m\u1ed9t \u00f4 \u0111\u1ec3 xem ho\u1eb7c s\u1eeda n\u1ed9i dung" autocomplete="off" /></div>` : ''}
    <div class="schedule-scroll homeroom-sheet-scroll"><table class="schedule homeroom-grid"><thead><tr class="homeroom-axis-row"><th class="homeroom-corner" title="Ch\u1ecdn to\u00e0n b\u1ed9 b\u1ea3ng"></th>${Array.from({ length: colCount }, (_, col) => `<th class="homeroom-col-header" data-sheet-col="${col}">${excelColumnName(col)}</th>`).join('')}</tr></thead><tbody>`;
  for (let row = 0; row < rowCount; row++) {
    const rowMap = mapHomeroomVisualIndex(row, insertedRows);
    html += `<tr class="homeroom-data-row"><th class="homeroom-row-header" data-sheet-row="${row}">${row + 1}</th>`;
    for (let col = 0; col < colCount; col++) {
      const colMap = mapHomeroomVisualIndex(col, insertedCols);
      const key = `${row}|${col}`;
      const baseKey = `${rowMap.base}|${colMap.base}`;
      const autoValue = rowMap.inserted || colMap.inserted ? '' : (defaults.cells[baseKey] || '');
      const value = saved.cells[key] ?? autoValue;
      const savedStyle = saved.styles[key];
      const styleRow = rowMap.inserted ? defaults.metaRows : rowMap.base;
      const styleCol = colMap.inserted ? defaults.colCount : colMap.base;
      const style = savedStyle && !isLegacyHomeroomDefaultStyle(savedStyle, styleRow, styleCol, type, defaults.metaRows)
        ? savedStyle
        : homeroomDefaultStyle(styleRow, styleCol, type, defaults.metaRows, lessonCount);
      const normalized = normalizeOverviewStyle(style);
      const tag = !rowMap.inserted && rowMap.base < defaults.metaRows ? 'th' : 'td';
      const hasValue = String(value || '').trim() ? ' has-value' : '';
      html += `<${tag} class="homeroom-cell${hasValue}" data-homeroom-cell="${key}" data-base-row="${rowMap.inserted ? '' : rowMap.base}" data-base-col="${colMap.inserted ? '' : colMap.base}" data-auto="${escapeHtml(autoValue)}" data-bg="${escapeHtml(normalized.backgroundColor || '')}" data-fg="${escapeHtml(normalized.color || '')}" data-width="${escapeHtml(style.width || '')}" data-height="${escapeHtml(style.height || '')}" data-col="hr-${col}" data-row-id="hr-${row}"${homeroomCellStyle(style)}>${escapeHtml(value)}</${tag}>`;
    }
    html += '</tr>';
  }
  html += `</tbody></table></div>${homeroomEditMode ? `<div id="homeroom-context-menu" class="homeroom-context-menu hidden" role="menu">
    <button type="button" data-sheet-action="insert-row-above">Ch\u00e8n h\u00e0ng ph\u00eda tr\u00ean</button>
    <button type="button" data-sheet-action="insert-row-below">Ch\u00e8n h\u00e0ng ph\u00eda d\u01b0\u1edbi</button>
    <button type="button" data-sheet-action="insert-col-left">Ch\u00e8n c\u1ed9t b\u00ean tr\u00e1i</button>
    <button type="button" data-sheet-action="insert-col-right">Ch\u00e8n c\u1ed9t b\u00ean ph\u1ea3i</button>
    <span></span>
    <button type="button" data-sheet-action="delete-row">Xo\u00e1 h\u00e0ng t\u1ef1 th\u00eam</button>
    <button type="button" data-sheet-action="delete-col">Xo\u00e1 c\u1ed9t t\u1ef1 th\u00eam</button>
  </div>` : ''}</section>`;
  return html;
}

async function renderHomeroomHome() {
  const root = $('#homeroom-root');
  if (!root) return;
  if (!teacherSession) {
    root.innerHTML = '<p class="placeholder">Vui l\u00f2ng \u0111\u0103ng nh\u1eadp gi\u00e1o vi\u00ean.</p>';
    return;
  }
  if (!teacherClasses.length) {
    root.innerHTML = '<p class="placeholder">Ch\u01b0a c\u00f3 l\u1edbp \u0111\u1ec3 m\u1edf s\u1ed5.</p>';
    return;
  }
  homeroomClassId = localStorage.getItem(HOMEROOM_SELECTED_CLASS_KEY) || homeroomClassId || teacherClasses[0]?.id || '';
  if (!teacherClasses.some((cls) => cls.id === homeroomClassId)) homeroomClassId = teacherClasses[0]?.id || '';
  homeroomRecordType = localStorage.getItem(HOMEROOM_RECORD_TYPE_KEY) || homeroomRecordType || 'LR';
  const groups = buildSectorGroups(teacherClasses).filter((group) => group.classes.length);
  root.innerHTML = `<div class="homeroom-toolbar">
    <label>Ch\u1ecdn l\u1edbp<select id="homeroom-class-select">${groups.map((group) => `<optgroup label="${escapeHtml(group.name)}">${group.classes.map((cls) => `<option value="${escapeHtml(cls.id)}" ${cls.id === homeroomClassId ? 'selected' : ''}>${escapeHtml(cls.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
    <div class="homeroom-record-tabs">${homeroomRecordTypes().map((type) => `<button type="button" class="homeroom-record-tab${type.key === homeroomRecordType ? ' active' : ''}" data-type="${type.key}">${type.label}</button>`).join('')}</div>
  </div><div id="homeroom-detail"><p class="placeholder">\u0110ang t\u1ea3i s\u1ed5...</p></div>`;
  $('#homeroom-class-select')?.addEventListener('change', async (event) => {
    if (homeroomEditMode) await saveHomeroomFromDom();
    homeroomClassId = event.target.value;
    localStorage.setItem(HOMEROOM_SELECTED_CLASS_KEY, homeroomClassId);
    homeroomEditMode = false;
    renderHomeroomHome();
  });
  root.querySelectorAll('.homeroom-record-tab').forEach((button) => {
    button.addEventListener('click', async () => {
      if (homeroomEditMode) await saveHomeroomFromDom();
      homeroomRecordType = button.dataset.type || 'LR';
      localStorage.setItem(HOMEROOM_RECORD_TYPE_KEY, homeroomRecordType);
      homeroomEditMode = false;
      renderHomeroomHome();
    });
  });
  try {
    const cls = await api('/classes/' + homeroomClassId);
    $('#homeroom-detail').innerHTML = await renderHomeroomTable(cls, homeroomRecordType);
    wireHomeroomRecord();
  } catch (err) {
    $('#homeroom-detail').innerHTML = `<p class="placeholder">${escapeHtml(err.message)}</p>`;
  }
}

function addHomeroomResizeHandles(scope) {
  if (!homeroomEditMode) return;
  const cells = scope?.classList?.contains('homeroom-cell') ? [scope] : [...(scope || document).querySelectorAll('.homeroom-cell')];
  cells.forEach((cell) => {
    if (!cell.querySelector(':scope > .overview-col-resizer')) {
      const col = document.createElement('span');
      col.className = 'overview-col-resizer';
      col.contentEditable = 'false';
      col.title = 'K\u00e9o \u0111\u1ec3 \u0111\u1ed5i \u0111\u1ed9 r\u1ed9ng c\u1ed9t';
      cell.appendChild(col);
    }
    if (!cell.querySelector(':scope > .overview-row-resizer')) {
      const row = document.createElement('span');
      row.className = 'overview-row-resizer';
      row.contentEditable = 'false';
      row.title = 'K\u00e9o \u0111\u1ec3 \u0111\u1ed5i chi\u1ec1u cao h\u00e0ng';
      cell.appendChild(row);
    }
  });
}

function parseClipboardGrid(text) {
  return String(text || '').replace(/\r/g, '').split('\n').filter((row, index, rows) => row || index < rows.length - 1).map((row) => row.split('\t'));
}

function copyCellFormat(source, target, includeText = true) {
  if (!source || !target) return;
  if (includeText) {
    target.textContent = source.textContent;
    target.classList.toggle('has-value', Boolean(target.textContent.trim()));
  }
  ['bg', 'fg', 'width', 'height'].forEach((name) => { target.dataset[name] = source.dataset[name] || ''; });
  if (source.dataset.bg) target.style.setProperty('background', source.dataset.bg, 'important');
  else target.style.removeProperty('background');
  if (source.dataset.fg) target.style.setProperty('color', source.dataset.fg, 'important');
  else target.style.removeProperty('color');
  if (source.dataset.width) { target.style.width = source.dataset.width; target.style.minWidth = source.dataset.width; }
  if (source.dataset.height) target.style.height = source.dataset.height;
}

function tableCellMatrix(table) {
  const matrix = [];
  [...(table?.rows || [])].forEach((row, rowIndex) => {
    matrix[rowIndex] = matrix[rowIndex] || [];
    let colIndex = 0;
    [...row.cells].forEach((cell) => {
      while (matrix[rowIndex][colIndex]) colIndex++;
      const rowSpan = Number(cell.rowSpan || 1);
      const colSpan = Number(cell.colSpan || 1);
      for (let r = 0; r < rowSpan; r++) {
        matrix[rowIndex + r] = matrix[rowIndex + r] || [];
        for (let c = 0; c < colSpan; c++) matrix[rowIndex + r][colIndex + c] = cell;
      }
      colIndex += colSpan;
    });
  });
  return matrix;
}

function locateCell(matrix, cell) {
  for (let row = 0; row < matrix.length; row++) {
    const col = matrix[row]?.findIndex((item) => item === cell);
    if (col >= 0) return { row, col };
  }
  return null;
}

function pasteGridIntoTable(table, startCell, text, writeCell) {
  const values = parseClipboardGrid(text);
  if (!values.length || (values.length === 1 && values[0].length === 1)) return false;
  const matrix = tableCellMatrix(table);
  const start = locateCell(matrix, startCell);
  if (!start) return false;
  const touched = new Set();
  values.forEach((rowValues, rowOffset) => rowValues.forEach((value, colOffset) => {
    const cell = matrix[start.row + rowOffset]?.[start.col + colOffset];
    if (!cell || touched.has(cell)) return;
    touched.add(cell);
    writeCell(cell, value);
  }));
  return true;
}

function fillSelectedFromFirst(targets) {
  if (!targets || targets.length < 2) return false;
  const first = targets[0];
  targets.slice(1).forEach((target) => copyCellFormat(first, target, true));
  return true;
}

function remapHomeroomAxis(data, axis, start, delta, removeCount = 0) {
  const remap = (source = {}) => Object.fromEntries(Object.entries(source).flatMap(([key, value]) => {
    const parts = String(key).split('|').map(Number);
    const position = axis === 'row' ? parts[0] : parts[1];
    if (!Number.isFinite(position)) return [];
    if (removeCount && position >= start && position < start + removeCount) return [];
    if (position >= start + removeCount) {
      if (axis === 'row') parts[0] += delta;
      else parts[1] += delta;
    }
    return [[`${parts[0]}|${parts[1]}`, value]];
  }));
  data.cells = remap(data.cells);
  data.styles = remap(data.styles);
  return data;
}

function selectedHomeroomCoordinate(root = $('#homeroom-record')) {
  const cell = root?.querySelector('.homeroom-selected-cell');
  if (!cell) return null;
  const [row, col] = String(cell.dataset.homeroomCell || '').split('|').map(Number);
  return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null;
}

async function addHomeroomLesson() {
  if (!homeroomClassId || !homeroomRecordType || homeroomRecordType === 'ALL') return;
  await saveHomeroomFromDom();
  const data = await loadHomeroomData(homeroomClassId, homeroomRecordType);
  const oldLessonCount = Math.max(3, Number(data.lessonCount) || 3);
  const insertedCols = normalizeInsertedIndexes(data.insertedCols);
  const col = homeroomVisualIndexForBase(3 + oldLessonCount * 4, insertedCols);
  remapHomeroomAxis(data, 'col', col, 4);
  data.insertedCols = insertedCols.map((item) => item >= col ? item + 4 : item);
  data.lessonCount = oldLessonCount + 1;
  await saveHomeroomPayload(homeroomClassId, homeroomRecordType, data);
  homeroomEditMode = true;
  renderHomeroomHome();
}

async function removeHomeroomLesson() {
  if (!homeroomClassId || homeroomRecordType === 'ALL') return;
  await saveHomeroomFromDom();
  const data = await loadHomeroomData(homeroomClassId, homeroomRecordType);
  const count = Math.max(3, Number(data.lessonCount) || 3);
  if (count <= 3) return alert('C\u1ea7n gi\u1eef \u00edt nh\u1ea5t 3 bu\u1ed5i m\u1eb7c \u0111\u1ecbnh.');
  if (!confirm(`Xo\u00e1 Bu\u1ed5i ${count} v\u00e0 to\u00e0n b\u1ed9 n\u1ed9i dung trong bu\u1ed5i n\u00e0y?`)) return;
  let insertedCols = normalizeInsertedIndexes(data.insertedCols);
  const start = 3 + (count - 1) * 4;
  const lessonCols = Array.from({ length: 4 }, (_, offset) => homeroomVisualIndexForBase(start + offset, insertedCols)).sort((a, b) => b - a);
  lessonCols.forEach((col) => {
    remapHomeroomAxis(data, 'col', col, -1, 1);
    insertedCols = insertedCols.map((item) => item > col ? item - 1 : item);
  });
  data.insertedCols = insertedCols;
  data.lessonCount = count - 1;
  await saveHomeroomPayload(homeroomClassId, homeroomRecordType, data);
  renderHomeroomHome();
}

async function changeHomeroomExtraRows(delta, options = {}) {
  const root = $('#homeroom-record');
  if (!root) return;
  const selected = selectedHomeroomCoordinate(root);
  const baseRows = Number(root.dataset.baseRows || 0);
  await saveHomeroomFromDom();
  const data = await loadHomeroomData(homeroomClassId, homeroomRecordType);
  const extraRows = Math.max(0, Number(data.extraRows) || 0);
  const insertedRows = normalizeInsertedIndexes(data.insertedRows);
  if (delta > 0) {
    if (selected || Number.isInteger(options.insertAt)) {
      const row = Number.isInteger(options.insertAt) ? Math.max(0, options.insertAt) : selected.row + 1;
      remapHomeroomAxis(data, 'row', row, 1);
      data.insertedRows = [...insertedRows.map((item) => item >= row ? item + 1 : item), row].sort((a, b) => a - b);
    } else data.extraRows = extraRows + 1;
  } else {
    let row = Number.isInteger(options.removeAt) ? options.removeAt : selected?.row;
    const selectedMap = Number.isFinite(row) ? mapHomeroomVisualIndex(row, insertedRows) : null;
    const isInserted = Number.isFinite(row) && insertedRows.includes(row);
    const isTail = selectedMap && !selectedMap.inserted && selectedMap.base >= baseRows;
    if (!isInserted && !isTail) {
      if (options.strict) return alert('H\u00e0ng n\u00e0y thu\u1ed9c d\u1eef li\u1ec7u h\u1ecdc sinh n\u00ean kh\u00f4ng th\u1ec3 xo\u00e1. Ch\u1ec9 xo\u00e1 \u0111\u01b0\u1ee3c h\u00e0ng t\u1ef1 th\u00eam.');
      if (extraRows) {
        const rowCount = baseRows + extraRows + insertedRows.length;
        for (let index = rowCount - 1; index >= 0; index--) {
          const mapped = mapHomeroomVisualIndex(index, insertedRows);
          if (!mapped.inserted && mapped.base >= baseRows) { row = index; break; }
        }
      } else if (insertedRows.length) row = insertedRows[insertedRows.length - 1];
      else return alert('Ch\u01b0a c\u00f3 h\u00e0ng t\u1ef1 th\u00eam \u0111\u1ec3 xo\u00e1.');
    }
    const removingInserted = insertedRows.includes(row);
    remapHomeroomAxis(data, 'row', row, -1, 1);
    data.insertedRows = insertedRows.filter((item) => item !== row).map((item) => item > row ? item - 1 : item);
    if (!removingInserted) data.extraRows = Math.max(0, extraRows - 1);
  }
  await saveHomeroomPayload(homeroomClassId, homeroomRecordType, data);
  renderHomeroomHome();
}

async function changeHomeroomExtraCols(delta, options = {}) {
  const root = $('#homeroom-record');
  if (!root) return;
  const selected = selectedHomeroomCoordinate(root);
  const baseCols = Number(root.dataset.baseCols || 0);
  await saveHomeroomFromDom();
  const data = await loadHomeroomData(homeroomClassId, homeroomRecordType);
  const extraCols = Math.max(0, Number(data.extraCols) || 0);
  const insertedCols = normalizeInsertedIndexes(data.insertedCols);
  const insertedRows = normalizeInsertedIndexes(data.insertedRows);
  const headerRow = homeroomVisualIndexForBase(homeroomMetaRows(homeroomRecordType) - 1, insertedRows);
  if (delta > 0) {
    if (selected || Number.isInteger(options.insertAt)) {
      const col = Number.isInteger(options.insertAt) ? Math.max(0, options.insertAt) : selected.col + 1;
      remapHomeroomAxis(data, 'col', col, 1);
      data.insertedCols = [...insertedCols.map((item) => item >= col ? item + 1 : item), col].sort((a, b) => a - b);
      data.cells[`${headerRow}|${col}`] = `C\u1ed9t ${extraCols + insertedCols.length + 1}`;
    } else {
      const col = homeroomVisualIndexForBase(baseCols + extraCols, insertedCols);
      data.extraCols = extraCols + 1;
      data.cells[`${headerRow}|${col}`] = `C\u1ed9t ${extraCols + insertedCols.length + 1}`;
    }
  } else {
    let col = Number.isInteger(options.removeAt) ? options.removeAt : selected?.col;
    const selectedMap = Number.isFinite(col) ? mapHomeroomVisualIndex(col, insertedCols) : null;
    const isInserted = Number.isFinite(col) && insertedCols.includes(col);
    const isTail = selectedMap && !selectedMap.inserted && selectedMap.base >= baseCols;
    if (!isInserted && !isTail) {
      if (options.strict) return alert('C\u1ed9t n\u00e0y thu\u1ed9c c\u1ea5u tr\u00fac bu\u1ed5i h\u1ecdc n\u00ean kh\u00f4ng th\u1ec3 xo\u00e1. Ch\u1ec9 xo\u00e1 \u0111\u01b0\u1ee3c c\u1ed9t t\u1ef1 th\u00eam.');
      if (extraCols) {
        const colCount = baseCols + extraCols + insertedCols.length;
        for (let index = colCount - 1; index >= 0; index--) {
          const mapped = mapHomeroomVisualIndex(index, insertedCols);
          if (!mapped.inserted && mapped.base >= baseCols) { col = index; break; }
        }
      } else if (insertedCols.length) col = insertedCols[insertedCols.length - 1];
      else return alert('Ch\u01b0a c\u00f3 c\u1ed9t t\u1ef1 th\u00eam \u0111\u1ec3 xo\u00e1.');
    }
    const removingInserted = insertedCols.includes(col);
    remapHomeroomAxis(data, 'col', col, -1, 1);
    data.insertedCols = insertedCols.filter((item) => item !== col).map((item) => item > col ? item - 1 : item);
    if (!removingInserted) data.extraCols = Math.max(0, extraCols - 1);
  }
  await saveHomeroomPayload(homeroomClassId, homeroomRecordType, data);
  renderHomeroomHome();
}

function homeroomExportTitle() {
  const heading = $('#homeroom-record .homeroom-record-head h3')?.textContent.trim() || 'So-chu-nhiem';
  return heading.replace(/[\\/:*?"<>|]/g, '-').trim() || 'So-chu-nhiem';
}

function selectedHomeroomExportColumns(root, lessonIndexes) {
  const lessonCount = Number(root.dataset.lessonCount || 3);
  const baseCols = Number(root.dataset.baseCols || defaultHomeroomColCount(homeroomRecordType, lessonCount));
  const extraCols = Number(root.dataset.extraCols || 0);
  const insertedCols = normalizeInsertedIndexes(root.dataset.insertedCols);
  const included = new Set();
  const colCount = baseCols + extraCols + insertedCols.length;
  for (let col = 0; col < colCount; col++) {
    const mapped = mapHomeroomVisualIndex(col, insertedCols);
    if (mapped.inserted || mapped.base < 3 || mapped.base >= baseCols) included.add(col);
    else if (lessonIndexes.includes(Math.floor((mapped.base - 3) / 4))) included.add(col);
  }
  return included;
}

function buildHomeroomExportTable(source, lessonIndexes) {
  const root = $('#homeroom-record');
  const included = selectedHomeroomExportColumns(root, lessonIndexes);
  const table = buildOverviewExportTable(source);
  table.classList.remove('schedule', 'homeroom-grid');
  table.classList.add('homeroom-export-table');
  table.querySelector('.homeroom-axis-row')?.remove();
  table.querySelectorAll('.homeroom-row-header').forEach((cell) => cell.remove());
  table.querySelector('colgroup > col')?.remove();
  [...table.rows].forEach((row) => {
    [...row.cells].forEach((cell, index) => {
      if (!included.has(index)) cell.remove();
      else {
        cell.style.whiteSpace = 'normal';
        cell.style.overflowWrap = 'anywhere';
      }
    });
  });
  [...(table.querySelector('colgroup')?.children || [])].forEach((col, index) => {
    if (!included.has(index)) col.remove();
  });
  const width = [...(table.querySelector('colgroup')?.children || [])]
    .reduce((sum, col) => sum + (Number.parseFloat(col.style.width) || Number(col.getAttribute('width')) || 48), 0);
  table.style.width = `${Math.ceil(width)}px`;
  table.setAttribute('width', String(Math.ceil(width)));
  return table;
}

async function copyHomeroomToExcel(button, lessons) {
  if (homeroomEditMode) await saveHomeroomFromDom();
  const source = $('#homeroom-record table.homeroom-grid');
  if (!source) return;
  const table = buildHomeroomExportTable(source, lessons);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><style>table{border-collapse:collapse;table-layout:fixed}td,th{mso-width-source:userset;white-space:normal}</style></head><body>${table.outerHTML}</body></html>`;
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([exportTableText(table)], { type: 'text/plain' })
      })]);
    } else fallbackCopyHtml(table);
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 copy');
  } catch (err) {
    try { fallbackCopyHtml(table); setExportButtonStatus(button, '\u2713 \u0110\u00e3 copy'); }
    catch (fallbackError) { setExportButtonStatus(button, 'Copy l\u1ed7i', true); alert(fallbackError.message || err.message); }
  }
}

async function downloadHomeroomExcel(button, lessons) {
  if (homeroomEditMode) await saveHomeroomFromDom();
  const source = $('#homeroom-record table.homeroom-grid');
  if (!source) return;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.disabled = true;
  button.textContent = '\u0110ang t\u1ea1o file...';
  try {
    const ExcelJS = await loadExcelJs();
    const table = buildHomeroomExportTable(source, lessons);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Olympus English';
    const worksheet = workbook.addWorksheet(homeroomExportTitle().replace(/[\\/*?:[\]]/g, '-').slice(0, 31), {
      views: [{ state: 'frozen', xSplit: 2, ySplit: homeroomMetaRows(homeroomRecordType) }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    [...(table.querySelector('colgroup')?.children || [])].forEach((col, index) => {
      const pixels = Number.parseFloat(col.style.width) || Number(col.getAttribute('width')) || 48;
      worksheet.getColumn(index + 1).width = Math.max(3.5, pixels / 7);
    });
    [...table.rows].forEach((row, rowIndex) => {
      const excelRow = worksheet.getRow(rowIndex + 1);
      excelRow.height = Math.max(18, Number.parseFloat(row.cells[0]?.style.height) || 22);
      [...row.cells].forEach((htmlCell, colIndex) => {
        const excelCell = worksheet.getCell(rowIndex + 1, colIndex + 1);
        excelCell.value = htmlCell.textContent.trim().replace(/\s+/g, ' ');
        excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: excelArgb(htmlCell.style.backgroundColor, 'FFFFFFFF') } };
        excelCell.font = { name: 'Arial', size: Number.parseFloat(htmlCell.style.fontSize) || 12, bold: Number.parseInt(htmlCell.style.fontWeight, 10) >= 600, color: { argb: excelArgb(htmlCell.style.color, 'FF111827') } };
        excelCell.alignment = { horizontal: htmlCell.style.textAlign === 'left' ? 'left' : 'center', vertical: 'middle', wrapText: true };
        excelCell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${homeroomExportTitle()}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setExportButtonStatus(button, '\u2713 \u0110\u00e3 t\u1ea3i Excel');
  } catch (err) {
    setExportButtonStatus(button, 'T\u1ea1o Excel l\u1ed7i', true);
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

function canvasWrappedLines(context, value, maxWidth) {
  const lines = [];
  String(value || '').split(/\n/).forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); return; }
    let line = '';
    words.forEach((word) => {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    });
    if (line) lines.push(line);
  });
  return lines;
}

async function renderHomeroomImage(source, lessons) {
  const table = buildHomeroomExportTable(source, lessons);
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:max-content;background:#fff;z-index:-1;';
  stage.appendChild(table);
  document.body.appendChild(stage);
  await document.fonts?.ready;
  const rect = table.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const scale = Math.min(3, Math.sqrt(45000000 / Math.max(1, width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  const stageRect = stage.getBoundingClientRect();
  table.querySelectorAll('th,td').forEach((cell) => {
    const cellRect = cell.getBoundingClientRect();
    const style = getComputedStyle(cell);
    const x = cellRect.left - stageRect.left;
    const y = cellRect.top - stageRect.top;
    context.fillStyle = style.backgroundColor || '#fff';
    context.fillRect(x, y, cellRect.width, cellRect.height);
    context.strokeStyle = '#111827';
    context.lineWidth = 1;
    context.strokeRect(x + .5, y + .5, Math.max(0, cellRect.width - 1), Math.max(0, cellRect.height - 1));
    const value = cell.textContent.trim();
    if (!value) return;
    context.save();
    context.beginPath();
    context.rect(x + 3, y + 2, Math.max(0, cellRect.width - 6), Math.max(0, cellRect.height - 4));
    context.clip();
    context.fillStyle = style.color || '#111827';
    context.font = `${style.fontWeight || '600'} ${style.fontSize || '12px'} Arial, sans-serif`;
    context.textAlign = style.textAlign === 'left' ? 'left' : 'center';
    context.textBaseline = 'middle';
    const lines = canvasWrappedLines(context, value, Math.max(8, cellRect.width - 10));
    const lineHeight = Math.max(13, (Number.parseFloat(style.fontSize) || 12) * 1.2);
    const startY = y + cellRect.height / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => context.fillText(
      line,
      style.textAlign === 'left' ? x + 5 : x + cellRect.width / 2,
      startY + index * lineHeight,
      Math.max(0, cellRect.width - 10)
    ));
    context.restore();
  });
  stage.remove();
  return canvas;
}

async function exportHomeroomImage(button, lessons) {
  if (homeroomEditMode) await saveHomeroomFromDom();
  const source = $('#homeroom-record table.homeroom-grid');
  if (!source) return;
  button.dataset.originalText = button.dataset.originalText || button.textContent;
  button.disabled = true;
  button.textContent = '\u0110ang t\u1ea1o \u1ea3nh...';
  try {
    const canvas = await renderHomeroomImage(source, lessons);
    const png = await canvasBlob(canvas, 'image/png');
    let copied = false;
    if (navigator.clipboard?.write && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        copied = true;
      } catch (err) { /* File download still works. */ }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(png);
    link.download = `${homeroomExportTitle()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setExportButtonStatus(button, copied ? '\u2713 \u0110\u00e3 t\u1ea3i + copy \u1ea3nh' : '\u2713 \u0110\u00e3 t\u1ea3i \u1ea3nh');
  } catch (err) {
    setExportButtonStatus(button, 'Xu\u1ea5t \u1ea3nh l\u1ed7i', true);
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

function openHomeroomExportDialog(mode, button) {
  document.querySelector('.homeroom-export-overlay')?.remove();
  const root = $('#homeroom-record');
  if (!root) return;
  const lessonCount = Number(root.dataset.lessonCount || 3);
  const insertedCols = normalizeInsertedIndexes(root.dataset.insertedCols);
  const firstRow = root.querySelector('table.homeroom-grid tbody tr');
  const labels = Array.from({ length: lessonCount }, (_, index) => {
    const col = homeroomVisualIndexForBase(3 + index * 4, insertedCols);
    return firstRow?.cells[col + 1]?.textContent.trim() || `Bu\u1ed5i ${index + 1}`;
  });
  const overlay = document.createElement('div');
  overlay.className = 'image-export-overlay homeroom-export-overlay';
  overlay.innerHTML = `<div class="image-export-dialog homeroom-export-dialog">
    <h3>Ch\u1ecdn bu\u1ed5i c\u1ea7n xu\u1ea5t</h3>
    <p class="hint">C\u00e1c c\u1ed9t #, H\u1ecdc vi\u00ean, L\u01b0u \u00fd v\u00e0 c\u1ed9t t\u1ef1 th\u00eam lu\u00f4n \u0111\u01b0\u1ee3c gi\u1eef l\u1ea1i.</p>
    <div class="homeroom-export-select-actions"><button type="button" data-check="all">Ch\u1ecdn t\u1ea5t c\u1ea3</button><button type="button" data-check="none">B\u1ecf ch\u1ecdn</button></div>
    <div class="homeroom-export-lessons">${labels.map((label, index) => `<label><input class="homeroom-export-lesson" type="checkbox" value="${index}" checked /><span>${escapeHtml(label)}</span><small>4 c\u1ed9t</small></label>`).join('')}</div>
    <div class="image-export-actions"><button class="image-export-cancel" type="button">Hu\u1ef7</button><button class="homeroom-export-confirm primary" type="button">${mode === 'copy' ? 'Copy Excel' : mode === 'xlsx' ? 'T\u1ea3i Excel' : 'Xu\u1ea5t PNG'}</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.image-export-cancel')?.addEventListener('click', close);
  overlay.querySelectorAll('[data-check]').forEach((item) => item.addEventListener('click', () => {
    overlay.querySelectorAll('.homeroom-export-lesson').forEach((checkbox) => {
      checkbox.checked = item.dataset.check === 'all';
    });
  }));
  overlay.querySelector('.homeroom-export-confirm')?.addEventListener('click', async () => {
    const lessons = [...overlay.querySelectorAll('.homeroom-export-lesson:checked')].map((item) => Number(item.value));
    if (!lessons.length) return alert('H\u00e3y ch\u1ecdn \u00edt nh\u1ea5t 1 bu\u1ed5i.');
    close();
    if (mode === 'copy') await copyHomeroomToExcel(button, lessons);
    else if (mode === 'xlsx') await downloadHomeroomExcel(button, lessons);
    else await exportHomeroomImage(button, lessons);
  });
}

function wireHomeroomRecord() {
  const root = $('#homeroom-record');
  if (!root || homeroomRecordType === 'ALL') return;
  homeroomWireAbort?.abort();
  homeroomWireAbort = new AbortController();
  const wireSignal = homeroomWireAbort.signal;
  $('#homeroom-add-lesson')?.addEventListener('click', addHomeroomLesson);
  $('#homeroom-remove-lesson')?.addEventListener('click', removeHomeroomLesson);
  $('#homeroom-add-row')?.addEventListener('click', () => changeHomeroomExtraRows(1));
  $('#homeroom-remove-row')?.addEventListener('click', () => changeHomeroomExtraRows(-1));
  $('#homeroom-add-col')?.addEventListener('click', () => changeHomeroomExtraCols(1));
  $('#homeroom-remove-col')?.addEventListener('click', () => changeHomeroomExtraCols(-1));
  $('#homeroom-copy-excel')?.addEventListener('click', (event) => openHomeroomExportDialog('copy', event.currentTarget));
  $('#homeroom-download-excel')?.addEventListener('click', (event) => openHomeroomExportDialog('xlsx', event.currentTarget));
  $('#homeroom-export-image')?.addEventListener('click', (event) => openHomeroomExportDialog('image', event.currentTarget));
  $('#homeroom-edit')?.addEventListener('click', async () => {
    if (homeroomEditMode) {
      await saveHomeroomFromDom();
      homeroomEditMode = false;
    } else {
      homeroomEditMode = true;
    }
    renderHomeroomHome();
  });
  if (!homeroomEditMode) return;
  const panel = $('#homeroom-edit-panel');
  const contentInput = $('#homeroom-edit-content');
  const bgInput = $('#homeroom-edit-bg');
  const fgInput = $('#homeroom-edit-fg');
  const widthInput = $('#homeroom-edit-width');
  const heightInput = $('#homeroom-edit-height');
  const countLabel = $('#homeroom-edit-count');
  const nameBox = $('#homeroom-name-box');
  const formulaInput = $('#homeroom-formula-input');
  const contextMenu = $('#homeroom-context-menu');
  let selectionAnchor = null;
  let draggingSelection = false;
  let contextCoordinate = null;
  const selectedTargets = () => [...root.querySelectorAll('.homeroom-selected-cell')];
  const cellCoordinate = (cell) => {
    const [row, col] = String(cell?.dataset.homeroomCell || '').split('|').map(Number);
    return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null;
  };
  const cellAt = (row, col) => root.querySelector(`[data-homeroom-cell="${row}|${col}"]`);
  const updateAxisHighlights = (first) => {
    root.querySelectorAll('.homeroom-axis-active').forEach((item) => item.classList.remove('homeroom-axis-active'));
    const coordinate = cellCoordinate(first);
    if (!coordinate) return;
    root.querySelector(`[data-sheet-row="${coordinate.row}"]`)?.classList.add('homeroom-axis-active');
    root.querySelector(`[data-sheet-col="${coordinate.col}"]`)?.classList.add('homeroom-axis-active');
  };
  const syncPanel = () => {
    const targets = selectedTargets();
    const first = targets[0];
    updateAxisHighlights(first);
    const coordinate = cellCoordinate(first);
    if (nameBox) nameBox.textContent = coordinate ? `${excelColumnName(coordinate.col)}${coordinate.row + 1}` : '';
    if (formulaInput) {
      formulaInput.value = targets.length === 1 && first ? first.textContent.trim() : '';
      formulaInput.placeholder = targets.length > 1 ? `${targets.length} \u00f4 \u0111ang ch\u1ecdn` : 'Ch\u1ecdn m\u1ed9t \u00f4 \u0111\u1ec3 xem ho\u1eb7c s\u1eeda n\u1ed9i dung';
    }
    if (!panel) return;
    panel.classList.toggle('hidden', !targets.length);
    positionCellEditPanel(panel, targets, 'homeroom-panel-docked');
    if (countLabel) countLabel.textContent = `${targets.length} \u00f4`;
    if (!first) return;
    if (contentInput) {
      contentInput.value = targets.length === 1 ? first.textContent.trim() : '';
      contentInput.placeholder = targets.length === 1 ? 'Nh\u1eadp n\u1ed9i dung...' : 'B\u1ecf tr\u1ed1ng n\u1ebfu ch\u1ec9 \u0111\u1ed5i m\u00e0u';
    }
    if (bgInput) bgInput.value = first.dataset.bg || rgbToHex(getComputedStyle(first).backgroundColor) || '#ffffff';
    if (fgInput) fgInput.value = first.dataset.fg || rgbToHex(getComputedStyle(first).color) || '#111827';
    if (widthInput) widthInput.value = first.dataset.width || '';
    if (heightInput) heightInput.value = first.dataset.height || '';
  };
  const selectTarget = (target, additive = false) => {
    if (!additive) root.querySelectorAll('.homeroom-selected-cell').forEach((item) => item.classList.remove('homeroom-selected-cell'));
    target.classList.toggle('homeroom-selected-cell', additive ? !target.classList.contains('homeroom-selected-cell') : true);
    syncPanel();
  };
  const selectRange = (start, end) => {
    if (!start || !end) return;
    root.querySelectorAll('.homeroom-selected-cell').forEach((item) => item.classList.remove('homeroom-selected-cell'));
    const minRow = Math.min(start.row, end.row); const maxRow = Math.max(start.row, end.row);
    const minCol = Math.min(start.col, end.col); const maxCol = Math.max(start.col, end.col);
    root.querySelectorAll('.homeroom-cell').forEach((cell) => {
      const point = cellCoordinate(cell);
      cell.classList.toggle('homeroom-selected-cell', point.row >= minRow && point.row <= maxRow && point.col >= minCol && point.col <= maxCol);
    });
    syncPanel();
  };
  const applyToSelection = (bg, fg, options = {}) => {
    selectedTargets().forEach((target) => {
      if (bg !== undefined) {
        target.dataset.bg = bg || '';
        if (bg) target.style.setProperty('background', bg, 'important');
        else target.style.removeProperty('background');
      }
      if (fg !== undefined) {
        target.dataset.fg = fg || '';
        if (fg) target.style.setProperty('color', fg, 'important');
        else target.style.removeProperty('color');
      }
      if (options.width !== undefined) {
        target.dataset.width = options.width || '';
        if (options.width) { target.style.width = options.width; target.style.minWidth = options.width; }
        else { target.style.removeProperty('width'); target.style.removeProperty('min-width'); }
      }
      if (options.height !== undefined) {
        target.dataset.height = options.height || '';
        if (options.height) target.style.height = options.height;
        else target.style.removeProperty('height');
      }
      if (options.text !== undefined) {
        target.textContent = options.text;
        target.classList.toggle('has-value', Boolean(String(options.text || '').trim()));
        addHomeroomResizeHandles(target);
      }
    });
  };
  const placeCaretAtEnd = (cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const beginCellEdit = (cell, replace = false) => {
    if (!cell) return;
    root.querySelectorAll('.homeroom-cell-editing').forEach((item) => item.classList.remove('homeroom-cell-editing'));
    selectTarget(cell, false);
    if (replace) cell.textContent = '';
    cell.classList.add('homeroom-cell-editing');
    cell.focus();
    placeCaretAtEnd(cell);
  };
  const finishCellEdit = (cell) => {
    cell?.classList.remove('homeroom-cell-editing');
    if (cell) cell.classList.toggle('has-value', Boolean(cell.textContent.trim()));
    syncPanel();
  };
  const selectedGridText = () => {
    const targets = selectedTargets();
    if (!targets.length) return '';
    const points = targets.map((cell) => ({ cell, ...cellCoordinate(cell) }));
    const rows = points.map((item) => item.row); const cols = points.map((item) => item.col);
    const minRow = Math.min(...rows); const maxRow = Math.max(...rows);
    const minCol = Math.min(...cols); const maxCol = Math.max(...cols);
    return Array.from({ length: maxRow - minRow + 1 }, (_, rowOffset) =>
      Array.from({ length: maxCol - minCol + 1 }, (_, colOffset) => cellAt(minRow + rowOffset, minCol + colOffset)?.textContent.trim() || '').join('\t')
    ).join('\n');
  };
  const copySelectedGrid = async (cut = false) => {
    const textValue = selectedGridText();
    if (!textValue && !selectedTargets().length) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard');
      await navigator.clipboard.writeText(textValue);
    } catch (err) {
      const textarea = document.createElement('textarea');
      textarea.value = textValue;
      textarea.style.cssText = 'position:fixed;left:-10000px;top:0;';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    if (cut) applyToSelection(undefined, undefined, { text: '' });
    syncPanel();
  };
  const hideContextMenu = () => contextMenu?.classList.add('hidden');
  const showContextMenu = (event, coordinate) => {
    if (!contextMenu || !coordinate) return;
    event.preventDefault();
    contextCoordinate = coordinate;
    contextMenu.classList.remove('hidden');
    const width = 230; const height = 270;
    contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
    contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  };
  const sameColumnCells = (cell) => [...root.querySelectorAll('.homeroom-cell')].filter((item) => item.dataset.col === cell.dataset.col);
  const sameRowCells = (cell) => [...root.querySelectorAll('.homeroom-cell')].filter((item) => item.dataset.rowId === cell.dataset.rowId);
  const startResize = (event, cell, type) => {
    event.preventDefault(); event.stopPropagation();
    const targets = type === 'col' ? sameColumnCells(cell) : sameRowCells(cell);
    const startX = event.clientX; const startY = event.clientY;
    const startWidth = cell.getBoundingClientRect().width; const startHeight = cell.getBoundingClientRect().height;
    const onMove = (moveEvent) => {
      if (type === 'col') {
        const width = `${Math.max(28, Math.round(startWidth + moveEvent.clientX - startX))}px`;
        targets.forEach((target) => { target.dataset.width = width; target.style.width = width; target.style.minWidth = width; });
        if (widthInput && cell.classList.contains('homeroom-selected-cell')) widthInput.value = width;
      } else {
        const height = `${Math.max(20, Math.round(startHeight + moveEvent.clientY - startY))}px`;
        targets.forEach((target) => { target.dataset.height = height; target.style.height = height; });
        if (heightInput && cell.classList.contains('homeroom-selected-cell')) heightInput.value = height;
      }
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  };
  addHomeroomResizeHandles(root);
  const writeHomeroomCell = (cell, value) => {
    cell.textContent = value;
    cell.classList.toggle('has-value', Boolean(String(value || '').trim()));
    addHomeroomResizeHandles(cell);
  };
  root.querySelectorAll('.homeroom-cell').forEach((cell) => {
    cell.contentEditable = 'true';
    cell.tabIndex = -1;
    cell.spellcheck = false;
    cell.addEventListener('input', () => {
      cell.classList.toggle('has-value', Boolean(cell.textContent.trim()));
      if (cell.classList.contains('homeroom-selected-cell') && selectedTargets().length === 1 && contentInput) {
        contentInput.value = cell.textContent.trim();
      }
      if (cell.classList.contains('homeroom-selected-cell') && selectedTargets().length === 1 && formulaInput) formulaInput.value = cell.textContent.trim();
    });
    cell.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') || '';
      event.preventDefault();
      if (!pasteGridIntoTable(root.querySelector('table'), cell, text, writeHomeroomCell)) writeHomeroomCell(cell, text);
      syncPanel();
    });
    cell.addEventListener('keydown', (event) => {
      const shortcut = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const coordinate = cellCoordinate(cell);
      const editingCell = cell.classList.contains('homeroom-cell-editing');
      if (shortcut && key === 'a') {
        event.preventDefault();
        root.querySelectorAll('.homeroom-cell').forEach((item) => item.classList.add('homeroom-selected-cell'));
        selectionAnchor = { row: 0, col: 0 };
        syncPanel();
        return;
      }
      if (shortcut && (key === 'c' || key === 'x')) {
        event.preventDefault();
        copySelectedGrid(key === 'x');
        return;
      }
      if (shortcut && key === 'd') {
        if (fillSelectedFromFirst(selectedTargets())) {
          event.preventDefault();
          syncPanel();
        }
        return;
      }
      if (event.key === 'F2') {
        event.preventDefault();
        beginCellEdit(cell, false);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finishCellEdit(cell);
        hideContextMenu();
        cell.focus();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !editingCell) {
        event.preventDefault();
        applyToSelection(undefined, undefined, { text: '' });
        syncPanel();
        return;
      }
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      const direction = arrows[event.key];
      if (direction && !editingCell) {
        event.preventDefault();
        const next = cellAt(coordinate.row + direction[0], coordinate.col + direction[1]);
        if (next) {
          if (event.shiftKey) {
            selectionAnchor = selectionAnchor || coordinate;
            selectRange(selectionAnchor, cellCoordinate(next));
          } else {
            selectionAnchor = cellCoordinate(next);
            selectTarget(next, false);
          }
          next.focus();
        }
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.altKey)) {
        event.preventDefault();
        finishCellEdit(cell);
        const nextRow = event.key === 'Enter' ? coordinate.row + (event.shiftKey ? -1 : 1) : coordinate.row;
        const nextCol = event.key === 'Tab' ? coordinate.col + (event.shiftKey ? -1 : 1) : coordinate.col;
        const next = cellAt(nextRow, nextCol);
        if (next) {
          selectionAnchor = cellCoordinate(next);
          selectTarget(next, false);
          next.focus();
        }
        return;
      }
      if (!editingCell && !shortcut && !event.altKey && event.key.length === 1) beginCellEdit(cell, true);
    });
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('.overview-col-resizer, .overview-row-resizer') || cell.classList.contains('homeroom-cell-editing')) return;
      event.preventDefault();
      const coordinate = cellCoordinate(cell);
      if (event.shiftKey && selectionAnchor) selectRange(selectionAnchor, coordinate);
      else {
        selectionAnchor = coordinate;
        selectTarget(cell, event.ctrlKey || event.metaKey);
      }
      draggingSelection = !event.ctrlKey && !event.metaKey;
      cell.focus();
    });
    cell.addEventListener('mouseenter', () => {
      if (draggingSelection && selectionAnchor) selectRange(selectionAnchor, cellCoordinate(cell));
    });
    cell.addEventListener('dblclick', (event) => {
      event.preventDefault();
      draggingSelection = false;
      beginCellEdit(cell, false);
    });
    cell.addEventListener('blur', () => finishCellEdit(cell));
    cell.addEventListener('contextmenu', (event) => {
      const coordinate = cellCoordinate(cell);
      if (!cell.classList.contains('homeroom-selected-cell')) {
        selectionAnchor = coordinate;
        selectTarget(cell, false);
      }
      showContextMenu(event, coordinate);
    });
  });
  root.querySelectorAll('.homeroom-col-header').forEach((header) => {
    const col = Number(header.dataset.sheetCol);
    header.addEventListener('mousedown', (event) => {
      event.preventDefault();
      root.querySelectorAll('.homeroom-selected-cell').forEach((item) => item.classList.remove('homeroom-selected-cell'));
      const cells = [...root.querySelectorAll(`[data-col="hr-${col}"]`)];
      cells.forEach((item) => item.classList.add('homeroom-selected-cell'));
      selectionAnchor = cellCoordinate(cells[0]);
      cells[0]?.focus();
      syncPanel();
    });
    header.addEventListener('contextmenu', (event) => {
      root.querySelectorAll('.homeroom-selected-cell').forEach((item) => item.classList.remove('homeroom-selected-cell'));
      const cells = [...root.querySelectorAll(`[data-col="hr-${col}"]`)];
      cells.forEach((item) => item.classList.add('homeroom-selected-cell'));
      selectionAnchor = cellCoordinate(cells[0]);
      syncPanel();
      showContextMenu(event, { row: 0, col });
    });
  });
  root.querySelectorAll('.homeroom-row-header').forEach((header) => {
    const row = Number(header.dataset.sheetRow);
    header.addEventListener('mousedown', (event) => {
      event.preventDefault();
      root.querySelectorAll('.homeroom-selected-cell').forEach((item) => item.classList.remove('homeroom-selected-cell'));
      const cells = [...root.querySelectorAll(`[data-row-id="hr-${row}"]`)];
      cells.forEach((item) => item.classList.add('homeroom-selected-cell'));
      selectionAnchor = cellCoordinate(cells[0]);
      cells[0]?.focus();
      syncPanel();
    });
    header.addEventListener('contextmenu', (event) => {
      root.querySelectorAll('.homeroom-selected-cell').forEach((item) => item.classList.remove('homeroom-selected-cell'));
      const cells = [...root.querySelectorAll(`[data-row-id="hr-${row}"]`)];
      cells.forEach((item) => item.classList.add('homeroom-selected-cell'));
      selectionAnchor = cellCoordinate(cells[0]);
      syncPanel();
      showContextMenu(event, { row, col: 0 });
    });
  });
  root.querySelector('.homeroom-corner')?.addEventListener('mousedown', (event) => {
    event.preventDefault();
    root.querySelectorAll('.homeroom-cell').forEach((item) => item.classList.add('homeroom-selected-cell'));
    selectionAnchor = { row: 0, col: 0 };
    root.querySelector('.homeroom-cell')?.focus();
    syncPanel();
  });
  document.addEventListener('mouseup', () => { draggingSelection = false; }, { signal: wireSignal });
  document.addEventListener('mousedown', (event) => {
    if (!event.target.closest('#homeroom-context-menu')) hideContextMenu();
  }, { signal: wireSignal });
  root.querySelectorAll('.overview-col-resizer').forEach((handle) => handle.addEventListener('mousedown', (event) => startResize(event, handle.closest('.homeroom-cell'), 'col')));
  root.querySelectorAll('.overview-row-resizer').forEach((handle) => handle.addEventListener('mousedown', (event) => startResize(event, handle.closest('.homeroom-cell'), 'row')));
  contentInput?.addEventListener('input', () => {
    if (selectedTargets().length === 1) {
      applyToSelection(undefined, undefined, { text: contentInput.value });
      if (formulaInput) formulaInput.value = contentInput.value;
    }
  });
  formulaInput?.addEventListener('input', () => {
    if (selectedTargets().length !== 1) return;
    applyToSelection(undefined, undefined, { text: formulaInput.value });
    if (contentInput) contentInput.value = formulaInput.value;
  });
  formulaInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      selectedTargets()[0]?.focus();
    }
  });
  $('#homeroom-apply-cell')?.addEventListener('click', () => {
    const text = contentInput?.value ?? '';
    const applyText = selectedTargets().length === 1 || text.trim();
    applyToSelection(bgInput?.value || '', fgInput?.value || '', { ...(applyText ? { text } : {}), width: widthInput?.value.trim() || '', height: heightInput?.value.trim() || '' });
  });
  bgInput?.addEventListener('input', () => applyToSelection(bgInput.value, undefined));
  fgInput?.addEventListener('input', () => applyToSelection(undefined, fgInput.value));
  widthInput?.addEventListener('change', () => applyToSelection(undefined, undefined, { width: widthInput.value.trim() }));
  heightInput?.addEventListener('change', () => applyToSelection(undefined, undefined, { height: heightInput.value.trim() }));
  $('#homeroom-clear-cell')?.addEventListener('click', () => { applyToSelection('', ''); syncPanel(); });
  root.querySelectorAll('.overview-palette button').forEach((button) => button.addEventListener('click', () => {
    if (bgInput) bgInput.value = button.dataset.bg || '#ffffff';
    if (fgInput) fgInput.value = button.dataset.fg || '#111827';
    applyToSelection(button.dataset.bg || '', button.dataset.fg || '');
  }));
  contextMenu?.querySelectorAll('[data-sheet-action]').forEach((button) => button.addEventListener('click', async () => {
    const point = contextCoordinate || cellCoordinate(selectedTargets()[0]);
    if (!point) return;
    hideContextMenu();
    const action = button.dataset.sheetAction;
    if (action === 'insert-row-above') await changeHomeroomExtraRows(1, { insertAt: point.row });
    else if (action === 'insert-row-below') await changeHomeroomExtraRows(1, { insertAt: point.row + 1 });
    else if (action === 'insert-col-left') await changeHomeroomExtraCols(1, { insertAt: point.col });
    else if (action === 'insert-col-right') await changeHomeroomExtraCols(1, { insertAt: point.col + 1 });
    else if (action === 'delete-row') await changeHomeroomExtraRows(-1, { removeAt: point.row, strict: true });
    else if (action === 'delete-col') await changeHomeroomExtraCols(-1, { removeAt: point.col, strict: true });
  }));
  const initialCell = cellAt(0, 0);
  if (initialCell) {
    selectionAnchor = { row: 0, col: 0 };
    selectTarget(initialCell, false);
  }
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
  const studentName = normalizeStudentNameInput($('#s-name'));
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
  const studentName = normalizeStudentNameInput($('#s-name'));
  const dob = normalizeDob($('#s-dob')?.value);
  const msg = $('#lookup-msg');
  const result = $('#lookup-result');
  if (result) result.innerHTML = '';
  if (classes.length === 0) return showMsg(msg, 'H\u00e3y ch\u1ecdn \u00edt nh\u1ea5t m\u1ed9t l\u1edbp', 'err');
  if (!studentName || !dob) return showMsg(msg, 'Nh\u1eadp h\u1ecd t\u00ean v\u00e0 ng\u00e0y sinh \u0111\u1ec3 g\u1eedi l\u1ea1i l\u1ecbch', 'err');
  try {
    showMsg(msg, '\u0110ang t\u1ea3i l\u1ecbch hi\u1ec7n t\u1ea1i c\u1ee7a b\u1ea1n...', '');
    const results = await Promise.all(classes.map((cls) =>
      api(`/classes/${cls.id}/student-class`, { method: 'POST', body: JSON.stringify({ studentName, dob }) })
    ));
    lookupStates = results.filter((item) => item.canRequestChange);
    const editableCount = lookupStates.length;
    showMsg(
      msg,
      editableCount ? `\u0110\u00e3 t\u00ecm th\u1ea5y ${editableCount} l\u1edbp. Tick/detick l\u1ea1i l\u1ecbch b\u1eadn r\u1ed3i b\u1ea5m "G\u1eedi l\u1ecbch m\u1edbi" \u1edf t\u1eebng l\u1edbp.` : 'Kh\u00f4ng t\u00ecm th\u1ea5y h\u1ecdc sinh kh\u1edbp h\u1ecd t\u00ean v\u00e0 ng\u00e0y sinh trong c\u00e1c l\u1edbp \u0111\u00e3 ch\u1ecdn.',
      editableCount ? 'ok' : 'err'
    );
    renderLookupResults();
  } catch (err) {
    showMsg(msg, err.message, 'err');
  }
}

function renderLookupResults() {
  const result = $('#lookup-result');
  if (!result || !lookupStates.length) return;
  let html = '';
  const codeState = lookupStates.find((state) => state.studentCode);
  if (codeState) {
    html += `<div class="student-code-banner">Mã học sinh của bạn: <b class="student-code-chip">${escapeHtml(codeState.studentCode)}</b> — phụ huynh dùng mã này để tra cứu tại <a href="${escapeHtml(parentPortalUrl(codeState.studentCode))}" target="_blank" rel="noopener">Olympus Portal</a>.</div>`;
  }
  lookupStates.forEach((state) => {
    const sessions = getSessions(state);
    const slots = buildSlots(sessions);
    const submissions = sortSubmissions(state.submissions);
    const nameCounts = countNames(submissions);
    html += `<div class="lookup-block" data-lookup-class="${escapeHtml(state.id)}">`;
    html += `<div class="lookup-head"><div><h3>${escapeHtml(state.name)}</h3><p class="hint">Tick/detick c\u00e1c bu\u1ed5i b\u1eadn c\u1ee7a b\u1ea1n r\u1ed3i g\u1eedi l\u1ea1i \u0111\u1ec3 gi\u00e1o vi\u00ean duy\u1ec7t.</p></div>`;
    html += '</div>';
    html += renderScheduleTable({ slots, sessions, submissions, editable: true, showDelete: false, nameCounts, studentLookup: true, currentSlots: state.currentSlots || [], finalSubjects: state.finalSubjects || {} });
    html += `<div class="lookup-actions"><button class="btn-edit active btn-send-change" data-id="${escapeHtml(state.id)}">G\u1eedi l\u1ecbch m\u1edbi</button></div>`;
    html += '</div>';
  });
  result.innerHTML = html;
  result.querySelectorAll('.busy-chk').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      checkbox.closest('td')?.classList.toggle('busy', checkbox.checked);
    });
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
      body: JSON.stringify({ studentName: normalizeStudentNameInput($('#s-name')), dob: normalizeDob($('#s-dob')?.value), busySlots }),
    });
    showMsg(msg, `\u0110\u00e3 g\u1eedi l\u1ea1i l\u1ecbch cho l\u1edbp ${state.name}. Gi\u00e1o vi\u00ean s\u1ebd th\u1ea5y trong m\u1ee5c Ch\u1edd duy\u1ec7t.`, 'ok');
    lookupClassSchedule();
  } catch (err) {
    showMsg(msg, err.message, 'err');
  }
}

/* ---- Hồ sơ học sinh (teacher console) ---- */
let profileFields = [];
let profileSearchResults = [];
let profileSelectedStudentId = null;
let profileSearchTimer = null;

function parentPortalUrl(code) {
  const base = `${location.origin}${appBasePath()}parent.html`;
  return code ? `${base}?code=${encodeURIComponent(code)}` : base;
}

function profileEventLabel(event) {
  return ({
    enrolled: 'Đăng ký',
    started: 'Bắt đầu học',
    completed: 'Hoàn thành',
    transferred: 'Chuyển lớp',
    removed: 'Rời lớp',
  })[event] || event;
}

function initProfiles() {
  if (!$('#tab-profiles')) return;
  $('#btn-profiles-search')?.addEventListener('click', searchProfiles);
  $('#profiles-search')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchProfiles();
  });
  $('#profiles-search')?.addEventListener('input', () => {
    clearTimeout(profileSearchTimer);
    profileSearchTimer = setTimeout(searchProfiles, 400);
  });
  $('#btn-manage-profile-fields')?.addEventListener('click', openProfileFieldsDialog);
}

function renderProfilesHome() {
  const results = $('#profiles-results');
  const detail = $('#profile-detail');
  if (!results) return;
  if (!teacherSession) {
    results.innerHTML = '';
    showMsg($('#profiles-msg'), '', '');
    if (detail) detail.innerHTML = '<p class="placeholder">Đăng nhập giáo viên ở tab Lớp học để dùng Hồ sơ học sinh.</p>';
    return;
  }
  loadProfileFields();
  searchProfiles();
}

async function loadProfileFields() {
  try {
    profileFields = await api('/profile-fields');
  } catch (err) {
    profileFields = [];
  }
}

async function searchProfiles() {
  const results = $('#profiles-results');
  const msg = $('#profiles-msg');
  if (!results || !teacherSession) return;
  const query = $('#profiles-search')?.value?.trim() || '';
  try {
    showMsg(msg, 'Đang tìm...', '');
    profileSearchResults = await api('/students/search', { method: 'POST', body: JSON.stringify({ query }) });
    showMsg(msg, profileSearchResults.length ? '' : 'Không tìm thấy học sinh nào.', profileSearchResults.length ? '' : 'err');
    renderProfileSearchResults();
  } catch (err) {
    showMsg(msg, err.message, 'err');
  }
}

function renderProfileSearchResults() {
  const results = $('#profiles-results');
  if (!results) return;
  results.innerHTML = profileSearchResults.map((student) => {
    const activeClasses = (student.classes || [])
      .filter((cls) => !cls.archived && cls.status === 'approved')
      .map((cls) => cls.name);
    return `<li class="profile-result${student.id === profileSelectedStudentId ? ' active' : ''}" data-student="${escapeHtml(student.id)}">
      <span class="profile-result-name">${escapeHtml(student.name)}</span>
      <span class="profile-result-meta"><span class="student-code-chip">${escapeHtml(student.code || '—')}</span><span>${escapeHtml(formatDobInputValue(student.dob) || '')}</span></span>
      ${activeClasses.length ? `<span class="profile-result-classes">${escapeHtml(activeClasses.join(', '))}</span>` : ''}
    </li>`;
  }).join('');
  results.querySelectorAll('.profile-result').forEach((item) => {
    item.addEventListener('click', () => openStudentProfile(item.dataset.student));
  });
}

async function openStudentProfile(studentId) {
  const detail = $('#profile-detail');
  if (!detail) return;
  profileSelectedStudentId = studentId;
  renderProfileSearchResults();
  detail.innerHTML = '<p class="placeholder">Đang tải hồ sơ...</p>';
  try {
    const data = await api(`/students/${studentId}/profile`);
    profileFields = data.fields || [];
    renderProfileDetail(data);
  } catch (err) {
    detail.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function profileFieldInputHtml(field, value) {
  if (field.fieldType === 'select') {
    const options = (field.options || [])
      .map((opt) => `<option value="${escapeHtml(opt)}" ${opt === value ? 'selected' : ''}>${escapeHtml(opt)}</option>`)
      .join('');
    return `<select class="profile-field-input" data-field="${escapeHtml(field.id)}"><option value="">—</option>${options}</select>`;
  }
  const type = field.fieldType === 'number' ? 'number' : field.fieldType === 'date' ? 'date' : 'text';
  return `<input class="profile-field-input" data-field="${escapeHtml(field.id)}" type="${type}" value="${escapeHtml(value ?? '')}" ${type === 'number' ? 'step="any"' : ''} />`;
}

function renderProfileDetail(data) {
  const detail = $('#profile-detail');
  if (!detail) return;
  const student = data.student || {};
  const values = data.data || {};
  const classes = data.classes || [];
  const history = data.history || [];
  const activeClasses = classes.filter((cls) => !cls.archived && cls.status === 'approved');
  const fieldRows = (data.fields || []).map((field) => `
    <label class="profile-field-row">
      <span class="profile-field-label">${escapeHtml(field.label)}${field.visibleToParent ? ' <small class="profile-parent-flag" title="Phụ huynh xem được ở Olympus Portal">PH xem</small>' : ''}</span>
      ${profileFieldInputHtml(field, values[field.id] ?? '')}
    </label>`).join('');
  const historyHtml = history.length
    ? `<ol class="profile-timeline">${history.map((item) => `
        <li class="profile-timeline-item event-${escapeHtml(item.event)}">
          <span class="profile-timeline-date">${escapeHtml(formatDateOnly(item.happenedAt) || '')}</span>
          <span class="profile-timeline-label">${escapeHtml(profileEventLabel(item.event))} — <b>${escapeHtml(item.className)}</b>${item.note ? ` <small>${escapeHtml(item.note)}</small>` : ''}</span>
        </li>`).join('')}</ol>`
    : '<p class="placeholder">Chưa có lịch sử khóa học.</p>';

  detail.innerHTML = `
    <div class="profile-student-head">
      <div>
        <h3>${escapeHtml(student.name || '')}</h3>
        <p class="hint">Ngày sinh: ${escapeHtml(formatDobInputValue(student.dob) || '')}</p>
      </div>
      <div class="profile-code-box">
        <span class="profile-code-label">Mã học sinh</span>
        <span class="student-code-chip profile-code-value">${escapeHtml(student.code || '—')}</span>
        <button id="btn-copy-student-code" class="btn-export" type="button">Copy mã</button>
        <button id="btn-copy-parent-link" class="btn-export" type="button">Copy link phụ huynh</button>
        ${isOwner() ? '<button id="btn-regenerate-code" class="btn-export" type="button">Cấp lại mã</button>' : ''}
      </div>
    </div>
    <div class="profile-identity-editor">
      <label>Họ và tên
        <input id="profile-student-name" type="text" value="${escapeHtml(student.name || '')}" autocomplete="off" />
      </label>
      <label>Ngày sinh
        <input id="profile-student-dob" type="text" inputmode="numeric" placeholder="dd/mm/yyyy" maxlength="10" value="${escapeHtml(formatDobInputValue(student.dob) || '')}" />
      </label>
      <button id="btn-save-student-identity" class="btn-export" type="button">Lưu thông tin</button>
      <span id="profile-identity-msg" class="msg"></span>
    </div>
    <div class="profile-classes-line">${activeClasses.length
      ? `Đang học: ${activeClasses.map((cls) => `<span class="profile-class-chip">${escapeHtml(cls.name)}</span>`).join(' ')}`
      : 'Chưa ở lớp nào đang hoạt động.'}</div>
    <div class="profile-section">
      <h4>Thông tin hồ sơ</h4>
      ${fieldRows || '<p class="placeholder">Chưa có trường thông tin. Owner bấm "Trường thông tin" để tạo (vd: Điểm đầu vào).</p>'}
      ${(data.fields || []).length ? '<div class="profile-save-row"><button id="btn-save-profile" class="primary" type="button">Lưu hồ sơ</button><span id="profile-save-msg" class="msg"></span></div>' : ''}
    </div>
    <div class="profile-section">
      <h4>Lộ trình khóa học</h4>
      ${historyHtml}
    </div>`;

  $('#btn-copy-student-code')?.addEventListener('click', async (event) => {
    try {
      await navigator.clipboard.writeText(student.code || '');
      setExportButtonStatus(event.currentTarget, 'Đã copy!');
    } catch (err) {
      setExportButtonStatus(event.currentTarget, 'Copy lỗi', true);
    }
  });
  $('#btn-copy-parent-link')?.addEventListener('click', async (event) => {
    try {
      await navigator.clipboard.writeText(parentPortalUrl(student.code || ''));
      setExportButtonStatus(event.currentTarget, 'Đã copy!');
    } catch (err) {
      setExportButtonStatus(event.currentTarget, 'Copy lỗi', true);
    }
  });
  $('#btn-regenerate-code')?.addEventListener('click', async () => {
    if (!confirm('Cấp lại mã mới cho học sinh này? Mã cũ sẽ không tra cứu được nữa.')) return;
    try {
      await api(`/students/${student.id}/regenerate-code`, { method: 'POST' });
      await openStudentProfile(student.id);
      searchProfiles();
    } catch (err) {
      alert(err.message);
    }
  });
  setupDobInput($('#profile-student-dob'));
  $('#btn-save-student-identity')?.addEventListener('click', async () => {
    const msg = $('#profile-identity-msg');
    const name = $('#profile-student-name')?.value?.trim() || '';
    const dob = normalizeDob($('#profile-student-dob')?.value || '');
    if (!name || !dob) {
      showMsg(msg, 'Nhập đủ họ tên và ngày sinh hợp lệ.', 'err');
      return;
    }
    try {
      showMsg(msg, 'Đang lưu...', '');
      await api(`/students/${student.id}/identity`, { method: 'POST', body: JSON.stringify({ name, dob }) });
      showMsg(msg, 'Đã cập nhật.', 'ok');
      await openStudentProfile(student.id);
      searchProfiles();
    } catch (err) {
      showMsg(msg, err.message, 'err');
    }
  });
  $('#btn-save-profile')?.addEventListener('click', async () => {
    const msg = $('#profile-save-msg');
    const dataOut = {};
    detail.querySelectorAll('.profile-field-input').forEach((input) => {
      dataOut[input.dataset.field] = input.value || '';
    });
    try {
      showMsg(msg, 'Đang lưu...', '');
      await api(`/students/${student.id}/profile`, { method: 'POST', body: JSON.stringify({ data: dataOut }) });
      showMsg(msg, 'Đã lưu hồ sơ.', 'ok');
    } catch (err) {
      showMsg(msg, err.message, 'err');
    }
  });
}

function profileFieldRowHtml(field = {}) {
  const types = [['text', 'Chữ'], ['number', 'Số'], ['date', 'Ngày'], ['select', 'Lựa chọn']];
  return `<div class="field-manage-row" data-id="${escapeHtml(field.id || '')}">
    <input class="fm-label" type="text" placeholder="Tên trường (vd: Điểm đầu vào)" value="${escapeHtml(field.label || '')}" />
    <select class="fm-type">${types.map(([value, label]) => `<option value="${value}" ${field.fieldType === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <input class="fm-options" type="text" placeholder="Các lựa chọn, cách nhau dấu phẩy" value="${escapeHtml((field.options || []).join(', '))}" ${field.fieldType === 'select' ? '' : 'style="display:none"'} />
    <label class="fm-visible"><input type="checkbox" ${field.visibleToParent ? 'checked' : ''} /> PH xem</label>
    <button type="button" class="fm-delete" title="Xoá trường">&times;</button>
  </div>`;
}

function openProfileFieldsDialog() {
  if (!isOwner()) return;
  const body = `<p class="hint">Các trường áp dụng cho mọi học sinh. Tick "PH xem" nếu muốn phụ huynh thấy trường đó ở Olympus Portal.</p>
    <div id="field-manage-list">${profileFields.map((field) => profileFieldRowHtml(field)).join('')}</div>
    <button type="button" id="btn-add-profile-field" class="btn-export">+ Thêm trường</button>`;
  const overlay = openMiniDialog('Trường thông tin hồ sơ', body, async (dialog) => {
    const rows = [...dialog.querySelectorAll('.field-manage-row')];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const label = row.querySelector('.fm-label')?.value?.trim() || '';
      if (!label) continue;
      const field = {
        id: row.dataset.id || '',
        label,
        fieldType: row.querySelector('.fm-type')?.value || 'text',
        options: (row.querySelector('.fm-options')?.value || '').split(',').map((item) => item.trim()).filter(Boolean),
        visibleToParent: row.querySelector('.fm-visible input')?.checked || false,
        sortOrder: i,
      };
      await api('/profile-fields', { method: 'POST', body: JSON.stringify({ field }) });
    }
    await loadProfileFields();
    if (profileSelectedStudentId) openStudentProfile(profileSelectedStudentId);
  });
  const wireRow = (row) => {
    row.querySelector('.fm-type')?.addEventListener('change', (event) => {
      const options = row.querySelector('.fm-options');
      if (options) options.style.display = event.target.value === 'select' ? '' : 'none';
    });
    row.querySelector('.fm-delete')?.addEventListener('click', async () => {
      const id = row.dataset.id;
      if (id) {
        if (!confirm('Xoá trường này? Dữ liệu đã nhập của trường sẽ bị xoá khỏi mọi hồ sơ.')) return;
        try {
          await api(`/profile-fields/${id}`, { method: 'DELETE' });
        } catch (err) {
          alert(err.message);
          return;
        }
        await loadProfileFields();
      }
      row.remove();
    });
  };
  overlay.querySelectorAll('.field-manage-row').forEach(wireRow);
  overlay.querySelector('#btn-add-profile-field')?.addEventListener('click', () => {
    const list = overlay.querySelector('#field-manage-list');
    const holder = document.createElement('div');
    holder.innerHTML = profileFieldRowHtml();
    const row = holder.firstElementChild;
    list.appendChild(row);
    wireRow(row);
    row.querySelector('.fm-label')?.focus();
  });
}

/* ---- Trò chơi từ vựng (dữ liệu tĩnh, không gọi Supabase) ---- */
function vocabBooks() {
  return Array.isArray(window.OLYMPUS_VOCAB?.books) ? window.OLYMPUS_VOCAB.books : [];
}

function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function selectedVocabBook() {
  const books = vocabBooks();
  return books.find((book) => book.id === $('#vocab-book')?.value) || books[0] || null;
}

function selectedVocabUnit() {
  const book = selectedVocabBook();
  const number = Number($('#vocab-unit')?.value);
  return book?.units?.find((unit) => Number(unit.unit) === number) || book?.units?.[0] || null;
}

async function loadTeacherDirectory() {
  if (!teacherSession) {
    teacherDirectory = [];
    return [];
  }
  try {
    const rows = await api('/teacher-directory');
    teacherDirectory = [...new Set((rows || []).map((item) => String(item.name || item).trim()).filter(Boolean))];
  } catch (err) {
    teacherDirectory = ['Thầy Tùng'];
  }
  if (!teacherDirectory.includes('Thầy Tùng')) teacherDirectory.unshift('Thầy Tùng');
  return teacherDirectory;
}

function teacherOptionsHtml(selected = '', allowCustom = isOwner()) {
  const names = [...new Set(['Thầy Tùng', ...teacherDirectory, selected].map((name) => String(name || '').trim()).filter(Boolean))];
  return `${names.map((name) => `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
    ${allowCustom ? '<option value="__custom__">Tên khác...</option>' : ''}`;
}

async function loadVocabCustomizations() {
  if (!teacherSession) {
    vocabCustomizations = [];
    return [];
  }
  try {
    vocabCustomizations = await api('/vocabulary-customizations');
    if ($('#tab-games')?.classList.contains('active')) rebuildVocabDeck();
  } catch (err) {
    vocabCustomizations = [];
  }
  return vocabCustomizations;
}

function vocabWordsForUnit(book, unit) {
  if (!book || !unit) return [];
  const rows = vocabCustomizations.filter((item) => item.bookId === book.id && Number(item.unitNo) === Number(unit.unit));
  const removed = new Set(rows.filter((item) => item.action === 'remove').map((item) => String(item.wordKey || '').toLocaleLowerCase()));
  const base = (unit.words || [])
    .filter((word) => !removed.has(String(word.w || '').trim().toLocaleLowerCase()))
    .map((word) => ({ ...word, _source: 'base', _bookId: book.id, _unitNo: unit.unit }));
  const custom = rows.filter((item) => item.action === 'add' && item.data?.w).map((item) => ({
    ...item.data, _source: 'custom', _customId: item.id, _bookId: book.id, _unitNo: unit.unit
  }));
  return [...base, ...custom];
}

function rebuildVocabDeck(reset = true) {
  const book = selectedVocabBook();
  const unit = selectedVocabUnit();
  vocabDeck = shuffled(vocabWordsForUnit(book, unit));
  if (reset) {
    vocabIndex = 0;
    vocabKnown = new Set();
  } else {
    vocabIndex = Math.min(vocabIndex, Math.max(0, vocabDeck.length - 1));
  }
  vocabRevealed = false;
  renderVocabCard();
}

function renderVocabGame() {
  const bookSelect = $('#vocab-book');
  const unitSelect = $('#vocab-unit');
  if (!bookSelect || !unitSelect) return;
  const books = vocabBooks();
  const savedBook = localStorage.getItem('olympus-vocab-book') || '';
  const previousBook = bookSelect.value || savedBook;
  bookSelect.innerHTML = books.map((book) =>
    `<option value="${escapeHtml(book.id)}" ${book.id === previousBook ? 'selected' : ''}>${escapeHtml(book.name)} · ${book.units?.length || 0} Unit</option>`
  ).join('');
  const book = selectedVocabBook();
  const savedUnit = localStorage.getItem(`olympus-vocab-unit:${book?.id || ''}`) || '';
  const previousUnit = unitSelect.value || savedUnit;
  unitSelect.innerHTML = (book?.units || []).map((unit) =>
    `<option value="${Number(unit.unit)}" ${String(unit.unit) === String(previousUnit) ? 'selected' : ''}>Unit ${Number(unit.unit)} — ${escapeHtml(unit.title)}</option>`
  ).join('');
  if (!unitSelect.value && unitSelect.options.length) unitSelect.selectedIndex = 0;
  const mode = localStorage.getItem('olympus-vocab-mode');
  if (mode && $('#vocab-mode')) $('#vocab-mode').value = mode;
  if (!vocabDeck.length) rebuildVocabDeck();
  else renderVocabCard();
}

function vocabFaceMode() {
  const mode = $('#vocab-mode')?.value || 'word';
  return mode === 'mixed' ? (vocabIndex % 2 ? 'meaning' : 'word') : mode;
}

function renderVocabCard() {
  const stage = $('#vocab-stage');
  const empty = $('#vocab-empty');
  const card = $('#vocab-flashcard');
  const word = vocabDeck[vocabIndex];
  if (!stage || !card) return;
  const hasData = Boolean(word);
  stage.classList.toggle('hidden', !hasData);
  empty?.classList.toggle('hidden', hasData);
  if (!word) {
    if ($('#vocab-progress')) $('#vocab-progress').textContent = '0/0';
    return;
  }
  const face = vocabFaceMode();
  const prompt = face === 'meaning' ? word.vn : word.w;
  const answer = face === 'meaning' ? word.w : word.vn;
  $('#vocab-card-label').textContent = face === 'meaning' ? 'Nghĩa tiếng Việt' : `${word.t || 'Từ vựng'} · Unit ${selectedVocabUnit()?.unit || ''}`;
  $('#vocab-prompt').textContent = prompt || '';
  $('#vocab-ipa').textContent = face === 'word' ? (word.ipa || '') : '';
  $('#vocab-answer').textContent = answer || '';
  $('#vocab-example').textContent = word.ex || '';
  $('#vocab-progress').textContent = `${vocabIndex + 1}/${vocabDeck.length}`;
  card.classList.toggle('revealed', vocabRevealed);
  const known = $('#btn-vocab-known');
  known?.classList.toggle('active', vocabKnown.has(vocabIndex));
  if (known) known.textContent = vocabKnown.has(vocabIndex) ? '✓ Đã nhớ' : '✓ Đánh dấu đã nhớ';
}

function moveVocab(step) {
  if (!vocabDeck.length) return;
  vocabIndex = (vocabIndex + step + vocabDeck.length) % vocabDeck.length;
  vocabRevealed = false;
  renderVocabCard();
}

function initVocabGame() {
  if (!$('#tab-games')) return;
  $('#vocab-book')?.addEventListener('change', () => {
    localStorage.setItem('olympus-vocab-book', $('#vocab-book').value);
    vocabDeck = [];
    renderVocabGame();
    rebuildVocabDeck();
  });
  $('#vocab-unit')?.addEventListener('change', () => {
    const book = selectedVocabBook();
    localStorage.setItem(`olympus-vocab-unit:${book?.id || ''}`, $('#vocab-unit').value);
    rebuildVocabDeck();
  });
  $('#vocab-mode')?.addEventListener('change', () => {
    localStorage.setItem('olympus-vocab-mode', $('#vocab-mode').value);
    vocabRevealed = false;
    renderVocabCard();
  });
  $('#vocab-flashcard')?.addEventListener('click', () => {
    vocabRevealed = !vocabRevealed;
    renderVocabCard();
  });
  $('#btn-vocab-prev')?.addEventListener('click', () => moveVocab(-1));
  $('#btn-vocab-next')?.addEventListener('click', () => moveVocab(1));
  $('#btn-vocab-reset')?.addEventListener('click', () => rebuildVocabDeck());
  $('#btn-vocab-known')?.addEventListener('click', () => {
    if (vocabKnown.has(vocabIndex)) vocabKnown.delete(vocabIndex);
    else vocabKnown.add(vocabIndex);
    renderVocabCard();
  });
  $('#btn-vocab-speak')?.addEventListener('click', () => {
    const word = vocabDeck[vocabIndex]?.w;
    if (!word || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-GB';
    utterance.rate = .86;
    window.speechSynthesis.speak(utterance);
  });
  $('#btn-vocab-add')?.addEventListener('click', openAddVocabDialog);
  $('#btn-vocab-remove')?.addEventListener('click', removeCurrentVocabWord);
  renderVocabGame();
}

function openAddVocabDialog() {
  if (!isOwner()) return;
  const body = `<p class="hint">Từ mới được thêm vào đúng giáo trình và Unit đang chọn, lưu bền trên Supabase.</p>
    <div class="vocab-manage-form">
      <label>Từ / cụm từ<input id="vocab-new-word" type="text" placeholder="vd: make progress" /></label>
      <label>Loại từ<input id="vocab-new-type" type="text" placeholder="n, v, adj, phr..." /></label>
      <label>IPA<input id="vocab-new-ipa" type="text" placeholder="/.../" /></label>
      <label>Nghĩa tiếng Việt<input id="vocab-new-vn" type="text" /></label>
      <label class="vocab-manage-wide">Ví dụ<input id="vocab-new-example" type="text" placeholder="Example sentence..." /></label>
    </div>`;
  const dialog = openMiniDialog('Thêm từ vựng', body, async (overlay) => {
    const word = {
      w: overlay.querySelector('#vocab-new-word')?.value.trim() || '',
      t: overlay.querySelector('#vocab-new-type')?.value.trim() || '',
      ipa: overlay.querySelector('#vocab-new-ipa')?.value.trim() || '',
      vn: overlay.querySelector('#vocab-new-vn')?.value.trim() || '',
      ex: overlay.querySelector('#vocab-new-example')?.value.trim() || ''
    };
    if (!word.w || !word.vn) throw new Error('Cần nhập từ và nghĩa tiếng Việt.');
    if (vocabDeck.some((item) => String(item.w || '').toLocaleLowerCase() === word.w.toLocaleLowerCase())) {
      throw new Error('Từ này đã có trong Unit.');
    }
    const book = selectedVocabBook();
    const unit = selectedVocabUnit();
    await api('/vocabulary-customizations', {
      method: 'POST', body: JSON.stringify({ bookId: book.id, unitNo: unit.unit, word })
    });
    await loadVocabCustomizations();
    rebuildVocabDeck();
  });
  dialog.querySelector('#vocab-new-word')?.focus();
}

async function removeCurrentVocabWord() {
  if (!isOwner()) return;
  const word = vocabDeck[vocabIndex];
  if (!word || !confirm(`Bỏ từ “${word.w}” khỏi Unit này?`)) return;
  try {
    await api('/vocabulary-customizations', {
      method: 'DELETE',
      body: JSON.stringify({
        bookId: word._bookId || selectedVocabBook()?.id,
        unitNo: word._unitNo || selectedVocabUnit()?.unit,
        wordKey: word.w,
        customId: word._customId || null
      })
    });
    await loadVocabCustomizations();
    rebuildVocabDeck();
  } catch (err) {
    alert(err.message);
  }
}

/* ---- Bảng công: phần nhập tay nhỏ, số liệu điểm danh đọc trực tiếp từ Sổ chủ nhiệm ---- */
function attendanceRowKey(row) {
  return `${row.classId}|${row.recordType}|${row.lessonIndex}`;
}

function attendanceFilteredRows() {
  const classId = $('#attendance-class-filter')?.value || '';
  const skill = $('#attendance-skill-filter')?.value || '';
  const status = $('#attendance-status-filter')?.value || '';
  return attendanceRows.filter((row) =>
    (!classId || row.classId === classId)
    && (!skill || row.recordType === skill)
    && (!status || (row.entry?.status || 'Chưa chốt') === status)
  );
}

function attendanceField(row, field, fallback = '') {
  return row.entry?.[field] ?? fallback;
}

function renderAttendance() {
  const root = $('#attendance-root');
  if (!root) return;
  const rows = attendanceFilteredRows();
  if (!rows.length) {
    root.innerHTML = '<div class="attendance-empty">Chưa có buổi nào. Hãy tạo/lưu các buổi trong Sổ chủ nhiệm rồi bấm Đồng bộ.</div>';
    return;
  }
  root.innerHTML = `<table class="attendance-table">
    <thead><tr>
      <th class="attendance-class">Lớp</th><th>Kỹ năng</th><th>Buổi</th><th>Ngày</th><th>Giáo viên</th>
      <th>Giờ vào</th><th>Giờ ra</th><th>Số tiết</th><th>Sĩ số</th><th>Có mặt</th><th>Vắng</th>
      <th>Trạng thái</th><th>Nội dung / ghi chú</th>
    </tr></thead>
    <tbody>${rows.map((row) => {
      const status = attendanceField(row, 'status', 'Chưa chốt');
      return `<tr data-attendance-key="${escapeHtml(attendanceRowKey(row))}">
        <td class="attendance-class">${escapeHtml(row.className)}</td>
        <td><b>${escapeHtml(row.recordType)}</b></td>
        <td>${escapeHtml(row.lessonLabel || `${row.recordType}${Number(row.lessonIndex) + 1}`)}</td>
        <td><input class="attendance-date-input" data-field="lessonDate" type="date" value="${escapeHtml(attendanceField(row, 'lessonDate') || row.recordDate || '')}" /></td>
        <td><select class="attendance-teacher-select" data-field="teacherName">${teacherOptionsHtml(attendanceField(row, 'teacherName') || row.recordTeacher || 'Thầy Tùng', isOwner())}</select></td>
        <td><input class="attendance-time-input" data-field="startTime" type="time" value="${escapeHtml(attendanceField(row, 'startTime') || row.recordStartTime || '')}" /></td>
        <td><input data-field="endTime" type="time" value="${escapeHtml(attendanceField(row, 'endTime'))}" /></td>
        <td><input class="attendance-period-input" data-field="periods" type="number" min="0" max="20" step=".5" value="${escapeHtml(attendanceField(row, 'periods', ''))}" /></td>
        <td class="attendance-sync">${Number(row.studentCount) || 0}</td>
        <td class="attendance-sync">${Number(row.presentCount) || 0}</td>
        <td class="attendance-sync attendance-absent ${Number(row.absentCount) ? 'has-absence' : ''}">${Number(row.absentCount) || 0}</td>
        <td><select data-field="status">${['Chưa chốt', 'Đã dạy', 'Dạy bù', 'Nghỉ'].map((item) => `<option ${item === status ? 'selected' : ''}>${item}</option>`).join('')}</select></td>
        <td><input data-field="note" type="text" value="${escapeHtml(attendanceField(row, 'note'))}" placeholder="Nội dung, lý do hoặc ghi chú..." /></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
  root.querySelectorAll('input, select').forEach((input) => {
    input.addEventListener('focus', () => { input.dataset.previousValue = input.value; });
    input.addEventListener('change', () => {
      if (input.dataset.field === 'teacherName' && input.value === '__custom__' && isOwner()) {
        const previous = input.dataset.previousValue || 'Thầy Tùng';
        input.value = previous;
        openAttendanceCustomTeacher(input, input.closest('tr'));
        return;
      }
      scheduleAttendanceSave(input.closest('tr'));
    });
    if (input.tagName === 'INPUT' && !['date', 'time', 'number'].includes(input.type)) {
      input.addEventListener('input', () => scheduleAttendanceSave(input.closest('tr')));
    }
  });
}

function openAttendanceCustomTeacher(select, tr) {
  openMiniDialog('Tên giáo viên tuỳ chỉnh',
    '<label>Tên hiển thị<input id="attendance-custom-teacher" type="text" placeholder="vd: Cô Lan (Speaking)" /></label>',
    async (overlay) => {
      const name = overlay.querySelector('#attendance-custom-teacher')?.value.trim() || '';
      if (!name) throw new Error('Nhập tên giáo viên.');
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.insertBefore(option, select.querySelector('option[value="__custom__"]'));
      select.value = name;
      scheduleAttendanceSave(tr);
    }
  ).querySelector('#attendance-custom-teacher')?.focus();
}

function collectAttendanceEntry(tr) {
  const entry = {};
  tr?.querySelectorAll('[data-field]').forEach((input) => {
    entry[input.dataset.field] = input.value || '';
  });
  return entry;
}

function scheduleAttendanceSave(tr) {
  if (!tr) return;
  const key = tr.dataset.attendanceKey;
  clearTimeout(attendanceSaveTimers.get(key));
  attendanceSaveTimers.set(key, setTimeout(() => saveAttendanceRow(tr), 650));
  showMsg($('#attendance-save-state'), 'Đang chờ lưu...', '');
}

async function saveAttendanceRow(tr) {
  const key = tr?.dataset.attendanceKey;
  const row = attendanceRows.find((item) => attendanceRowKey(item) === key);
  if (!row) return;
  try {
    showMsg($('#attendance-save-state'), 'Đang lưu...', '');
    const entry = collectAttendanceEntry(tr);
    await api('/attendance', {
      method: 'POST',
      body: JSON.stringify({ classId: row.classId, recordType: row.recordType, lessonIndex: row.lessonIndex, entry })
    });
    row.entry = entry;
    showMsg($('#attendance-save-state'), 'Đã lưu.', 'ok');
  } catch (err) {
    showMsg($('#attendance-save-state'), err.message, 'err');
  }
}

async function loadAttendance() {
  const root = $('#attendance-root');
  if (!root) return;
  if (!teacherSession) {
    root.innerHTML = '<div class="attendance-empty">Đăng nhập ở tab Lớp học để dùng Bảng công.</div>';
    return;
  }
  root.innerHTML = '<div class="attendance-empty">Đang đồng bộ Sổ chủ nhiệm...</div>';
  try {
    if (!teacherDirectory.length) await loadTeacherDirectory();
    attendanceRows = await api('/attendance');
    const select = $('#attendance-class-filter');
    const current = select?.value || '';
    const classes = [...new Map(attendanceRows.map((row) => [row.classId, row.className])).entries()]
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'vi', { numeric: true }));
    if (select) {
      select.innerHTML = `<option value="">Tất cả lớp</option>${classes.map(([id, name]) => `<option value="${escapeHtml(id)}" ${id === current ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}`;
    }
    renderAttendance();
    showMsg($('#attendance-save-state'), `Đã đồng bộ ${attendanceRows.length} buổi.`, 'ok');
  } catch (err) {
    root.innerHTML = `<div class="attendance-empty error">${escapeHtml(err.message)}</div>`;
  }
}

async function copyAttendanceToExcel(button) {
  const rows = attendanceFilteredRows();
  const headers = ['Lớp', 'Kỹ năng', 'Buổi', 'Ngày', 'Giáo viên', 'Giờ vào', 'Giờ ra', 'Số tiết', 'Sĩ số', 'Có mặt', 'Vắng', 'Trạng thái', 'Nội dung / ghi chú'];
  const values = rows.map((row) => {
    const e = row.entry || {};
    return [row.className, row.recordType, row.lessonLabel, e.lessonDate || row.recordDate || '', e.teacherName || row.recordTeacher || '', e.startTime || row.recordStartTime || '', e.endTime || '', e.periods || '', row.studentCount || 0, row.presentCount || 0, row.absentCount || 0, e.status || 'Chưa chốt', e.note || ''];
  });
  const clean = (value) => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  const tsv = [headers, ...values].map((row) => row.map(clean).join('\t')).join('\n');
  const html = `<table><thead><tr>${headers.map((item) => `<th style="background:#dbeafe;border:1px solid #94a3b8">${escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${values.map((row) => `<tr>${row.map((item, index) => `<td style="border:1px solid #cbd5e1;${index >= 8 && index <= 10 ? 'text-align:center;background:#dcfce7;' : ''}">${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([tsv], { type: 'text/plain' })
      })]);
    } else {
      await navigator.clipboard.writeText(tsv);
    }
    setExportButtonStatus(button, 'Đã copy!');
  } catch (err) {
    setExportButtonStatus(button, 'Copy lỗi', true);
  }
}

function initAttendance() {
  if (!$('#tab-attendance')) return;
  $('#btn-attendance-refresh')?.addEventListener('click', loadAttendance);
  $('#btn-attendance-copy')?.addEventListener('click', (event) => copyAttendanceToExcel(event.currentTarget));
  ['#attendance-class-filter', '#attendance-skill-filter', '#attendance-status-filter'].forEach((selector) => {
    $(selector)?.addEventListener('change', renderAttendance);
  });
}

/* ---- Olympus Portal (parent page) ---- */
function parentDemoData() {
  const weekStart = localIsoDate(mondayOf());
  return {
    student: { name: 'Lê Minh An', code: 'LMA0903', dob: '2012-03-09' },
    profile: [
      { label: 'Điểm đầu vào', fieldType: 'number', value: '8.5' },
      { label: 'Mục tiêu', fieldType: 'text', value: 'Flyers 15 khiên' },
    ],
    classes: [{
      id: 'demo-f13',
      name: 'F13',
      sessions: ['S1', 'S2', 'C', '57', 'T'],
      currentSlots: ['1-0', '4-2'],
      finalSubjects: {},
      weekStart,
      weekTitle: 'Tuần học',
      activeSlots: ['1-0', '4-2'],
      weekSlots: { '1-0': 'S12', '4-2': 'W8' },
      weekDetails: { '1-0': { location: 'CS1 - A2', note: '' }, '4-2': { location: 'CS1 - A1', note: 'Mang vở Writing' } },
    }],
    history: [
      { classId: 'demo-f12', className: 'F12', event: 'started', note: '', happenedAt: '2026-01-05T10:00:00Z' },
      { classId: 'demo-f12', className: 'F12', event: 'completed', note: '', happenedAt: '2026-05-20T10:00:00Z' },
      { classId: 'demo-f13', className: 'F13', event: 'started', note: '', happenedAt: '2026-05-25T10:00:00Z' },
    ],
  };
}

function initParentPortal() {
  const root = $('#parent-lookup');
  if (!root) return;
  const input = $('#parent-code');
  input?.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/\s/g, '');
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') lookupParent();
  });
  $('#btn-parent-lookup')?.addEventListener('click', lookupParent);
  const params = new URLSearchParams(location.search);
  if (params.get('demo') === '1') {
    renderParentResult(parentDemoData());
    return;
  }
  const preset = (params.get('code') || '').trim();
  if (preset && input) {
    input.value = preset.toUpperCase().replace(/\s/g, '');
    lookupParent();
  }
}

async function lookupParent() {
  const msg = $('#portal-msg');
  const result = $('#parent-result');
  const button = $('#btn-parent-lookup');
  const code = ($('#parent-code')?.value || '').trim().toUpperCase();
  if (!code) {
    if (msg) { msg.textContent = 'Nhập mã học sinh để tra cứu.'; msg.className = 'portal-msg err'; }
    return;
  }
  if (code === 'DEMO') {
    renderParentResult(parentDemoData());
    return;
  }
  try {
    if (button) { button.disabled = true; button.textContent = 'Đang tra cứu...'; }
    if (msg) { msg.textContent = ''; msg.className = 'portal-msg'; }
    result?.classList.add('hidden');
    const data = await api('/parent-lookup', { method: 'POST', body: JSON.stringify({ code }) });
    // Mã sai / bị chặn trả về {ok:false} chứ không raise, để RPC còn ghi được lần thử.
    if (data && data.ok === false) throw new Error(data.error || 'Không tra cứu được mã học sinh.');
    renderParentResult(data);
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.className = 'portal-msg err'; }
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Tra cứu'; }
  }
}

function parentTimelineEntries(data) {
  const history = data.history || [];
  const activeIds = new Set((data.classes || []).map((cls) => cls.id));
  const byClass = new Map();
  history.forEach((item) => {
    const key = item.classId || item.className;
    if (!byClass.has(key)) byClass.set(key, { className: item.className, events: [] });
    byClass.get(key).events.push(item);
  });
  const entries = [];
  byClass.forEach((info, key) => {
    const find = (type) => info.events.find((event) => event.event === type);
    const started = find('started') || find('enrolled');
    const completed = find('completed');
    const transferred = find('transferred');
    const removed = find('removed');
    let status = 'pending';
    let label = 'Đã đăng ký';
    if (activeIds.has(key)) { status = 'now'; label = 'Đang học'; }
    if (transferred && !activeIds.has(key)) { status = 'moved'; label = transferred.note ? `Chuyển lớp ${transferred.note}` : 'Chuyển lớp'; }
    if (completed) { status = 'done'; label = 'Hoàn thành'; }
    if (!completed && !transferred && removed && !activeIds.has(key)) { status = 'left'; label = 'Đã rời lớp'; }
    entries.push({
      className: info.className,
      status,
      label,
      from: started?.happenedAt || info.events[0]?.happenedAt || '',
      to: completed?.happenedAt || transferred?.happenedAt || '',
    });
  });
  entries.sort((a, b) => String(a.from).localeCompare(String(b.from)));
  return entries;
}

function parentSlotList(cls) {
  const sessions = cls.sessions || [];
  const lessons = cls.weekSlots || {};
  const details = cls.weekDetails || {};
  const entries = [...(cls.activeSlots || [])]
    .map((slotId) => {
      const [dayIdx, sessionIdx] = String(slotId).split('-').map(Number);
      return { slotId, dayIdx, sessionIdx };
    })
    .filter((item) => Number.isFinite(item.dayIdx) && Number.isFinite(item.sessionIdx))
    .sort((a, b) => a.dayIdx - b.dayIdx || a.sessionIdx - b.sessionIdx);
  if (!entries.length) return '<p class="portal-empty">Tuần này lớp chưa có lịch.</p>';
  return `<ul class="parent-slot-list">${entries.map((item) => {
    const rawLesson = lessons[item.slotId] || '';
    const lesson = rawLesson === 'REVIEW' ? 'Ôn tập' : rawLesson;
    const detail = details[item.slotId] || {};
    const dayLabel = cls.weekStart
      ? `${DAYS_SHORT[item.dayIdx] || '?'} ${dayDateLabel(cls.weekStart, item.dayIdx)}`
      : (DAYS_SHORT[item.dayIdx] || '?');
    return `<li>
      <span class="parent-slot-day">${escapeHtml(dayLabel)}</span>
      <span class="parent-slot-session">${escapeHtml(sessions[item.sessionIdx] || '?')}</span>
      ${lesson ? `<span class="parent-slot-lesson">${escapeHtml(displayLessonLabel(lesson))}</span>` : ''}
      ${detail.location ? `<span class="parent-slot-location">${escapeHtml(detail.location)}</span>` : ''}
      ${detail.note ? `<span class="parent-slot-note">${escapeHtml(detail.note)}</span>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

function renderParentResult(data) {
  const result = $('#parent-result');
  if (!result) return;
  const student = data.student || {};
  const profile = data.profile || [];
  const classes = data.classes || [];
  const timeline = parentTimelineEntries(data);
  result.innerHTML = `
    <section class="portal-card parent-student-card">
      <div class="parent-student-main">
        <h2>${escapeHtml(student.name || '')}</h2>
        <p class="parent-student-dob">Ngày sinh: ${escapeHtml(formatDobInputValue(student.dob) || '')}</p>
      </div>
      <div class="parent-student-code"><span>Mã học sinh</span><b>${escapeHtml(student.code || '')}</b></div>
    </section>
    ${profile.length ? `<section class="portal-card">
      <h3 class="portal-section-title">Thông tin học tập</h3>
      <dl class="parent-profile-grid">${profile.map((item) => `
        <div class="parent-profile-item"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value ?? '')}</dd></div>`).join('')}</dl>
    </section>` : ''}
    <section class="portal-card">
      <h3 class="portal-section-title">Lịch học tuần này</h3>
      ${classes.length ? classes.map((cls) => `
        <div class="parent-class-block">
          <div class="parent-class-head"><h4>${escapeHtml(cls.name)}</h4><span>${escapeHtml(cls.weekTitle || '')}${cls.weekStart ? ` · ${escapeHtml(weekRangeText(cls.weekStart))}` : ''}</span></div>
          ${parentSlotList(cls)}
        </div>`).join('') : '<p class="portal-empty">Hiện chưa có lớp đang học.</p>'}
    </section>
    <section class="portal-card">
      <h3 class="portal-section-title">Lộ trình Olympus</h3>
      ${timeline.length ? `<ol class="parent-timeline">${timeline.map((entry) => `
        <li class="parent-timeline-item status-${escapeHtml(entry.status)}">
          <span class="parent-timeline-dot"></span>
          <div class="parent-timeline-body">
            <div class="parent-timeline-head"><b>${escapeHtml(entry.className)}</b><span class="parent-status-badge">${escapeHtml(entry.label)}</span></div>
            <div class="parent-timeline-dates">${escapeHtml(formatDateOnly(entry.from) || '')}${entry.to ? ` → ${escapeHtml(formatDateOnly(entry.to) || '')}` : ''}</div>
          </div>
        </li>`).join('')}</ol>` : '<p class="portal-empty">Lộ trình sẽ hiện khi con bắt đầu khóa học đầu tiên.</p>'}
    </section>`;
  result.classList.remove('hidden');
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

(async function init() {
  initTheme();
  initTabs();
  initTeacher();
  initArchived();
  initTeacherAccounts();
  initProfiles();
  initVocabGame();
  initAttendance();
  const cfg = await api('/config');
  DAYS = cfg.days;
  DAYS_SHORT = cfg.daysShort || cfg.days;
  DEFAULT_SESSIONS = cfg.sessions || ['S1', 'S2', 'C', '57', 'T'];
  initStudent();
  initPublicScheduleViewer();
  initParentPortal();
})();
