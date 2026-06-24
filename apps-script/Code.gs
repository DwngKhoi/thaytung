const DAYS = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
const DAYS_SHORT = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const DEFAULT_SESSIONS = ['S1', 'S2', 'C', '57', 'T'];

const SHEET_CLASSES = 'Classes';
const SHEET_SUBMISSIONS = 'Submissions';

function doGet(e) {
  try {
    const params = e.parameter || {};
    ensureSheets_();
    const data = route_(params);
    return respond_(data, params.callback);
  } catch (err) {
    return respond_({ error: err.message || 'Lỗi máy chủ' }, (e.parameter || {}).callback);
  }
}

function route_(params) {
  const action = params.action || 'config';

  if (action === 'config') {
    return { days: DAYS, daysShort: DAYS_SHORT, sessions: DEFAULT_SESSIONS, sessionsFull: DEFAULT_SESSIONS };
  }

  if (action === 'login') return login_(params);

  if (action === 'classes') {
    requireStudent_(params);
    return listClasses_(false);
  }

  if (action === 'archivedClasses') {
    requireTeacher_(params);
    return listClasses_(true);
  }

  if (action === 'class') {
    requireTeacher_(params);
    return getClassDetail_(params.classId, true);
  }

  if (action === 'studentClass') {
    requireStudent_(params);
    return getStudentClass_(params);
  }

  return withLock_(() => {
    if (action === 'submit') {
      requireStudent_(params);
      return submit_(params, false);
    }
    if (action === 'requestChange') {
      requireStudent_(params);
      return submit_(params, true);
    }

    requireTeacher_(params);

    if (action === 'addClass') return addClass_(params.name);
    if (action === 'archiveClass') return setArchived_(params.classId, true);
    if (action === 'restoreClass') return setArchived_(params.classId, false);
    if (action === 'deleteClass') return deleteClass_(params.classId);
    if (action === 'clearArchived') return clearArchived_();
    if (action === 'setClassSessions') return setClassSessions_(params.classId, parseSessions_(params.sessions));
    if (action === 'addStudent') return addStudent_(params);
    if (action === 'approve') return setSubmissionStatus_(params.classId, params.studentName, params.dob, 'approved');
    if (action === 'reject') return deleteSubmission_(params.classId, params.studentName, params.dob);
    if (action === 'updateBusy') return updateBusy_(params.classId, params.studentName, params.dob, parseBusySlots_(params.busySlots));
    if (action === 'bulkUpdateBusy') return bulkUpdateBusy_(params.classId, parseUpdates_(params.updates));

    throw new Error('Action không hợp lệ');
  });
}

function login_(params) {
  const props = PropertiesService.getScriptProperties();
  const username = props.getProperty('TEACHER_USERNAME') || 'gv';
  const password = props.getProperty('TEACHER_PASSWORD') || '123456';
  const name = props.getProperty('TEACHER_NAME') || 'Thầy/Cô';
  if (params.username !== username || params.password !== password) {
    throw new Error('Sai tài khoản hoặc mật khẩu');
  }
  return { ok: true, name };
}

function requireStudent_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('STUDENT_KEY');
  if (expected && params.key !== expected) throw new Error('Không có quyền');
}

function requireTeacher_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('TEACHER_KEY');
  if (expected && params.key !== expected) throw new Error('Không có quyền');
}

function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let classes = ss.getSheetByName(SHEET_CLASSES);
  if (!classes) {
    classes = ss.insertSheet(SHEET_CLASSES);
    classes.appendRow(['id', 'name', 'archived', 'createdAt', 'sessions']);
  }
  ensureClassColumns_(classes);

  let submissions = ss.getSheetByName(SHEET_SUBMISSIONS);
  if (!submissions) {
    submissions = ss.insertSheet(SHEET_SUBMISSIONS);
    submissions.appendRow(['classId', 'studentName', 'dob', 'busySlots', 'status', 'updatedAt']);
  }
  ensureSubmissionColumns_(submissions);

  if (classes.getLastRow() === 1) {
    const now = new Date().toISOString();
    const sessions = JSON.stringify(DEFAULT_SESSIONS);
    classes.appendRow(['c1', 'F12', false, now, sessions]);
    classes.appendRow(['c2', 'F13', false, now, sessions]);
    classes.appendRow(['c3', 'F14', false, now, sessions]);
  }
}

function ensureClassColumns_(sheet) {
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(String);
  if (!headers.includes('sessions')) {
    sheet.getRange(1, headers.length + 1).setValue('sessions');
  }
  const nextHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const idxSessions = nextHeaders.indexOf('sessions') + 1;
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    if (!sheet.getRange(row, idxSessions).getValue()) {
      sheet.getRange(row, idxSessions).setValue(JSON.stringify(DEFAULT_SESSIONS));
    }
  }
}

function ensureSubmissionColumns_(sheet) {
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(String);
  const expected = ['classId', 'studentName', 'dob', 'busySlots', 'status', 'updatedAt'];
  if (expected.every((header, index) => headers[index] === header)) return;

  sheet.clear();
  sheet.appendRow(expected);
}

function listClasses_(archived) {
  const classes = readRows_(SHEET_CLASSES).filter((row) => toBool_(row.archived) === archived);
  const submissions = readRows_(SHEET_SUBMISSIONS);
  return classes.map((cls) => summarize_(cls, submissions)).sort(compareClasses_);
}

function getClassDetail_(classId, includeDob) {
  const cls = readRows_(SHEET_CLASSES).find((row) => row.id === classId);
  if (!cls) throw new Error('Không tìm thấy lớp');
  const submissions = readRows_(SHEET_SUBMISSIONS)
    .filter((row) => row.classId === classId)
    .map((row) => submissionDto_(row, includeDob))
    .sort(compareSubmissions_);
  return {
    id: cls.id,
    name: cls.name,
    archived: toBool_(cls.archived),
    sessions: parseSessions_(cls.sessions),
    submissions,
  };
}

function getStudentClass_(params) {
  const name = cleanName_(params.studentName);
  const dob = normalizeDob_(params.dob);
  if (!name || !dob) throw new Error('Nhập họ tên và ngày sinh để tra cứu');

  const detail = getClassDetail_(params.classId, true);
  const approved = detail.submissions.filter((item) => item.status === 'approved');
  const duplicateNames = countNames_(approved);
  detail.submissions = approved.map((item) => ({
    studentName: item.studentName,
    displayName: displayName_(item.studentName, item.dob, duplicateNames),
    busySlots: item.busySlots,
    status: item.status,
    canEdit: sameName_(item.studentName, name) && normalizeDob_(item.dob) === dob,
  })).sort(compareSubmissions_);
  detail.canRequestChange = detail.submissions.some((item) => item.canEdit);
  return detail;
}

function addClass_(name) {
  if (!name || !String(name).trim()) throw new Error('Thiếu tên lớp');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CLASSES);
  const id = 'c' + Date.now();
  sheet.appendRow([id, String(name).trim(), false, new Date().toISOString(), JSON.stringify(DEFAULT_SESSIONS)]);
  return { ok: true, id };
}

function setClassSessions_(classId, sessions) {
  if (sessions.length === 0) throw new Error('Cần ít nhất 1 buổi');
  const updated = updateClass_(classId, (row) => {
    row.sessions = JSON.stringify(sessions);
    return row;
  });
  if (!updated) throw new Error('Không tìm thấy lớp');
  return { ok: true, sessions };
}

function setArchived_(classId, archived) {
  const updated = updateClass_(classId, (row) => {
    row.archived = archived;
    return row;
  });
  if (!updated) throw new Error('Không tìm thấy lớp');
  return { ok: true };
}

function deleteClass_(classId) {
  deleteMatchingRows_(SHEET_CLASSES, (row) => row.id === classId);
  deleteMatchingRows_(SHEET_SUBMISSIONS, (row) => row.classId === classId);
  return { ok: true };
}

function clearArchived_() {
  const archivedIds = readRows_(SHEET_CLASSES)
    .filter((row) => toBool_(row.archived))
    .map((row) => row.id);
  deleteMatchingRows_(SHEET_CLASSES, (row) => archivedIds.includes(row.id));
  deleteMatchingRows_(SHEET_SUBMISSIONS, (row) => archivedIds.includes(row.classId));
  return { ok: true };
}

function submit_(params, isChangeRequest) {
  const classId = params.classId;
  const studentName = cleanName_(params.studentName);
  const dob = normalizeDob_(params.dob);
  if (!studentName) throw new Error('Thiếu họ tên học sinh');
  if (!dob) throw new Error('Thiếu ngày sinh');
  if (!readRows_(SHEET_CLASSES).some((row) => row.id === classId && !toBool_(row.archived))) {
    throw new Error('Không tìm thấy lớp');
  }

  const busySlots = JSON.stringify(parseBusySlots_(params.busySlots));
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBMISSIONS);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxClass = headers.indexOf('classId');
  const idxName = headers.indexOf('studentName');
  const idxDob = headers.indexOf('dob');
  const idxBusy = headers.indexOf('busySlots');
  const idxStatus = headers.indexOf('status');
  const idxUpdated = headers.indexOf('updatedAt');

  for (let i = 1; i < values.length; i++) {
    if (values[i][idxClass] === classId && sameName_(values[i][idxName], studentName) && normalizeDob_(values[i][idxDob]) === dob) {
      if (!isChangeRequest) throw new Error('Học sinh này đã có trong lớp. Hãy dùng Tra cứu lịch lớp để yêu cầu đổi.');
      sheet.getRange(i + 1, idxName + 1).setValue(studentName);
      sheet.getRange(i + 1, idxBusy + 1).setValue(busySlots);
      sheet.getRange(i + 1, idxStatus + 1).setValue('pending');
      sheet.getRange(i + 1, idxUpdated + 1).setValue(new Date().toISOString());
      return { ok: true, updated: true };
    }
  }

  if (isChangeRequest) throw new Error('Không tìm thấy học sinh khớp họ tên và ngày sinh');
  sheet.appendRow([classId, studentName, dob, busySlots, 'pending', new Date().toISOString()]);
  return { ok: true, created: true };
}

function addStudent_(params) {
  const studentName = cleanName_(params.studentName);
  const dob = normalizeDob_(params.dob);
  if (!studentName) throw new Error('Thiếu họ tên học sinh');
  if (!dob) throw new Error('Thiếu ngày sinh');

  const classId = params.classId;
  if (!readRows_(SHEET_CLASSES).some((row) => row.id === classId && !toBool_(row.archived))) {
    throw new Error('Không tìm thấy lớp');
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBMISSIONS);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxClass = headers.indexOf('classId');
  const idxName = headers.indexOf('studentName');
  const idxDob = headers.indexOf('dob');
  const idxStatus = headers.indexOf('status');
  const idxUpdated = headers.indexOf('updatedAt');

  for (let i = 1; i < values.length; i++) {
    if (values[i][idxClass] === classId && sameName_(values[i][idxName], studentName) && normalizeDob_(values[i][idxDob]) === dob) {
      sheet.getRange(i + 1, idxName + 1).setValue(studentName);
      sheet.getRange(i + 1, idxStatus + 1).setValue('approved');
      sheet.getRange(i + 1, idxUpdated + 1).setValue(new Date().toISOString());
      return { ok: true, updated: true };
    }
  }

  sheet.appendRow([classId, studentName, dob, JSON.stringify([]), 'approved', new Date().toISOString()]);
  return { ok: true, created: true };
}

function setSubmissionStatus_(classId, studentName, dob, status) {
  const updated = updateSubmission_(classId, studentName, dob, (row) => {
    row.status = status;
    row.updatedAt = new Date().toISOString();
    return row;
  });
  if (!updated) throw new Error('Không tìm thấy đăng ký');
  return { ok: true };
}

function updateBusy_(classId, studentName, dob, busySlots) {
  const updated = updateSubmission_(classId, studentName, dob, (row) => {
    row.busySlots = JSON.stringify(busySlots);
    row.updatedAt = new Date().toISOString();
    return row;
  });
  if (!updated) throw new Error('Không tìm thấy học sinh');
  return { ok: true };
}

function bulkUpdateBusy_(classId, updates) {
  let count = 0;
  updates.forEach((item) => {
    const updated = updateSubmission_(classId, item.studentName, item.dob, (row) => {
      row.busySlots = JSON.stringify(item.busySlots || []);
      row.updatedAt = new Date().toISOString();
      return row;
    });
    if (updated) count++;
  });
  return { ok: true, count };
}

function deleteSubmission_(classId, studentName, dob) {
  deleteMatchingRows_(SHEET_SUBMISSIONS, (row) =>
    row.classId === classId && sameName_(row.studentName, studentName) && normalizeDob_(row.dob) === normalizeDob_(dob)
  );
  return { ok: true };
}

function summarize_(cls, submissions) {
  const mine = submissions.filter((row) => row.classId === cls.id);
  return {
    id: cls.id,
    name: cls.name,
    sessions: parseSessions_(cls.sessions),
    approvedCount: mine.filter((row) => row.status === 'approved').length,
    pendingCount: mine.filter((row) => row.status === 'pending').length,
  };
}

function submissionDto_(row, includeDob) {
  const dto = {
    studentName: row.studentName,
    busySlots: parseBusySlots_(row.busySlots),
    status: row.status,
  };
  if (includeDob) dto.dob = normalizeDob_(row.dob);
  return dto;
}

function readRows_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = row[i];
    });
    return obj;
  });
}

function updateClass_(classId, updater) {
  return updateRow_(SHEET_CLASSES, (row) => row.id === classId, updater);
}

function updateSubmission_(classId, studentName, dob, updater) {
  return updateRow_(SHEET_SUBMISSIONS, (row) =>
    row.classId === classId && sameName_(row.studentName, studentName) && normalizeDob_(row.dob) === normalizeDob_(dob),
    updater
  );
}

function updateRow_(sheetName, predicate, updater) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);

  for (let i = 1; i < values.length; i++) {
    const row = {};
    headers.forEach((header, col) => {
      row[header] = values[i][col];
    });
    if (predicate(row)) {
      const next = updater(row);
      headers.forEach((header, col) => {
        sheet.getRange(i + 1, col + 1).setValue(next[header]);
      });
      return true;
    }
  }
  return false;
}

function deleteMatchingRows_(sheetName, predicate) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const rows = readRows_(sheetName);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) sheet.deleteRow(i + 2);
  }
}

function parseBusySlots_(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (err) {
    return String(value).split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function parseSessions_(value) {
  if (!value) return DEFAULT_SESSIONS.slice();
  if (Array.isArray(value)) return cleanSessions_(value);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return cleanSessions_(parsed);
  } catch (err) {}
  return cleanSessions_(String(value).split(','));
}

function cleanSessions_(items) {
  const seen = {};
  const sessions = items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  return sessions.length ? sessions : DEFAULT_SESSIONS.slice();
}

function parseUpdates_(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      studentName: cleanName_(item.studentName),
      dob: normalizeDob_(item.dob),
      busySlots: parseBusySlots_(item.busySlots),
    })).filter((item) => item.studentName && item.dob);
  } catch (err) {
    return [];
  }
}

function cleanName_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeDob_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${pad2_(iso[2])}-${pad2_(iso[3])}`;
  const vn = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (vn) return `${vn[3]}-${pad2_(vn[2])}-${pad2_(vn[1])}`;
  return raw;
}

function dobNote_(dob) {
  const norm = normalizeDob_(dob);
  const match = norm.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}` : norm;
}

function pad2_(value) {
  return String(value).padStart(2, '0');
}

function sameName_(a, b) {
  return cleanName_(a).toLowerCase() === cleanName_(b).toLowerCase();
}

function countNames_(submissions) {
  const counts = {};
  submissions.forEach((item) => {
    const key = cleanName_(item.studentName).toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function displayName_(name, dob, duplicateNames) {
  const key = cleanName_(name).toLowerCase();
  return duplicateNames[key] >= 2 ? `${name} (${dobNote_(dob)})` : name;
}

function compareText_(a, b) {
  return cleanName_(a).localeCompare(cleanName_(b), 'vi', { numeric: true, sensitivity: 'base' });
}

function compareClasses_(a, b) {
  return compareText_(a.name, b.name) || compareText_(a.id, b.id);
}

function compareSubmissions_(a, b) {
  return compareText_(a.studentName || a.displayName, b.studentName || b.displayName) || compareText_(a.dob, b.dob);
}

function toBool_(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function respond_(data, callback) {
  const json = JSON.stringify(data);
  if (callback) {
    return ContentService
      .createTextOutput(`${callback}(${json});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
