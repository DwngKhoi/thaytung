const DAYS = ['Thu 2', 'Thu 3', 'Thu 4', 'Thu 5', 'Thu 6', 'Thu 7', 'Chu nhat'];
const DAYS_SHORT = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const SESSIONS = ['S', 'C', '57', 'T'];
const SESSIONS_FULL = ['Sang', 'Chieu', '57', 'Toi'];

const SHEET_CLASSES = 'Classes';
const SHEET_SUBMISSIONS = 'Submissions';

function doGet(e) {
  try {
    const params = e.parameter || {};
    ensureSheets_();
    const data = route_(params);
    return respond_(data, params.callback);
  } catch (err) {
    return respond_({ error: err.message || 'Loi may chu' }, (e.parameter || {}).callback);
  }
}

function route_(params) {
  const action = params.action || 'config';

  if (action === 'config') {
    return { days: DAYS, daysShort: DAYS_SHORT, sessions: SESSIONS, sessionsFull: SESSIONS_FULL };
  }

  if (action === 'login') {
    return login_(params);
  }

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
    return getClassDetail_(params.classId);
  }

  return withLock_(() => {
    if (action === 'submit') {
      requireStudent_(params);
      return submit_(params);
    }

    requireTeacher_(params);

    if (action === 'addClass') return addClass_(params.name);
    if (action === 'archiveClass') return setArchived_(params.classId, true);
    if (action === 'restoreClass') return setArchived_(params.classId, false);
    if (action === 'deleteClass') return deleteClass_(params.classId);
    if (action === 'clearArchived') return clearArchived_();
    if (action === 'approve') return setSubmissionStatus_(params.classId, params.studentName, 'approved');
    if (action === 'reject') return deleteSubmission_(params.classId, params.studentName);
    if (action === 'updateBusy') return updateBusy_(params.classId, params.studentName, parseBusySlots_(params.busySlots));
    if (action === 'bulkUpdateBusy') return bulkUpdateBusy_(params.classId, parseUpdates_(params.updates));

    throw new Error('Action khong hop le');
  });
}

function login_(params) {
  const props = PropertiesService.getScriptProperties();
  const username = props.getProperty('TEACHER_USERNAME') || 'gv';
  const password = props.getProperty('TEACHER_PASSWORD') || '123456';
  const name = props.getProperty('TEACHER_NAME') || 'Thay/Co';
  if (params.username !== username || params.password !== password) {
    throw new Error('Sai tai khoan hoac mat khau');
  }
  return { ok: true, name };
}

function requireStudent_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('STUDENT_KEY');
  if (expected && params.key !== expected) throw new Error('Khong co quyen');
}

function requireTeacher_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty('TEACHER_KEY');
  if (expected && params.key !== expected) throw new Error('Khong co quyen');
}

function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let classes = ss.getSheetByName(SHEET_CLASSES);
  if (!classes) {
    classes = ss.insertSheet(SHEET_CLASSES);
    classes.appendRow(['id', 'name', 'archived', 'createdAt']);
  }

  let submissions = ss.getSheetByName(SHEET_SUBMISSIONS);
  if (!submissions) {
    submissions = ss.insertSheet(SHEET_SUBMISSIONS);
    submissions.appendRow(['classId', 'studentName', 'busySlots', 'status', 'updatedAt']);
  }

  if (classes.getLastRow() === 1) {
    const now = new Date().toISOString();
    classes.appendRow(['c1', 'F12', false, now]);
    classes.appendRow(['c2', 'F13', false, now]);
    classes.appendRow(['c3', 'F14', false, now]);
  }
}

function listClasses_(archived) {
  const classes = readRows_(SHEET_CLASSES).filter((row) => toBool_(row.archived) === archived);
  const submissions = readRows_(SHEET_SUBMISSIONS);
  return classes.map((cls) => summarize_(cls, submissions));
}

function getClassDetail_(classId) {
  const cls = readRows_(SHEET_CLASSES).find((row) => row.id === classId);
  if (!cls) throw new Error('Khong tim thay lop');
  const submissions = readRows_(SHEET_SUBMISSIONS)
    .filter((row) => row.classId === classId)
    .map((row) => ({
      studentName: row.studentName,
      busySlots: parseBusySlots_(row.busySlots),
      status: row.status,
    }));
  return { id: cls.id, name: cls.name, archived: toBool_(cls.archived), submissions };
}

function addClass_(name) {
  if (!name || !String(name).trim()) throw new Error('Thieu ten lop');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CLASSES);
  const id = 'c' + Date.now();
  sheet.appendRow([id, String(name).trim(), false, new Date().toISOString()]);
  return { ok: true, id };
}

function setArchived_(classId, archived) {
  const updated = updateClass_(classId, (row) => {
    row.archived = archived;
    return row;
  });
  if (!updated) throw new Error('Khong tim thay lop');
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

function submit_(params) {
  if (!params.studentName || !String(params.studentName).trim()) throw new Error('Thieu ten hoc sinh');
  const classId = params.classId;
  if (!readRows_(SHEET_CLASSES).some((row) => row.id === classId && !toBool_(row.archived))) {
    throw new Error('Khong tim thay lop');
  }

  const studentName = String(params.studentName).trim();
  const busySlots = JSON.stringify(parseBusySlots_(params.busySlots));
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBMISSIONS);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxClass = headers.indexOf('classId');
  const idxName = headers.indexOf('studentName');
  const idxBusy = headers.indexOf('busySlots');
  const idxStatus = headers.indexOf('status');
  const idxUpdated = headers.indexOf('updatedAt');

  for (let i = 1; i < values.length; i++) {
    if (values[i][idxClass] === classId && sameName_(values[i][idxName], studentName)) {
      sheet.getRange(i + 1, idxName + 1).setValue(studentName);
      sheet.getRange(i + 1, idxBusy + 1).setValue(busySlots);
      sheet.getRange(i + 1, idxStatus + 1).setValue('pending');
      sheet.getRange(i + 1, idxUpdated + 1).setValue(new Date().toISOString());
      return { ok: true };
    }
  }

  sheet.appendRow([classId, studentName, busySlots, 'pending', new Date().toISOString()]);
  return { ok: true };
}

function setSubmissionStatus_(classId, studentName, status) {
  const updated = updateSubmission_(classId, studentName, (row) => {
    row.status = status;
    row.updatedAt = new Date().toISOString();
    return row;
  });
  if (!updated) throw new Error('Khong tim thay dang ky');
  return { ok: true };
}

function updateBusy_(classId, studentName, busySlots) {
  const updated = updateSubmission_(classId, studentName, (row) => {
    row.busySlots = JSON.stringify(busySlots);
    row.updatedAt = new Date().toISOString();
    return row;
  });
  if (!updated) throw new Error('Khong tim thay hoc sinh');
  return { ok: true };
}

function bulkUpdateBusy_(classId, updates) {
  let count = 0;
  updates.forEach((item) => {
    const updated = updateSubmission_(classId, item.studentName, (row) => {
      row.busySlots = JSON.stringify(item.busySlots || []);
      row.updatedAt = new Date().toISOString();
      return row;
    });
    if (updated) count++;
  });
  return { ok: true, count };
}

function deleteSubmission_(classId, studentName) {
  deleteMatchingRows_(SHEET_SUBMISSIONS, (row) => row.classId === classId && sameName_(row.studentName, studentName));
  return { ok: true };
}

function summarize_(cls, submissions) {
  const mine = submissions.filter((row) => row.classId === cls.id);
  return {
    id: cls.id,
    name: cls.name,
    approvedCount: mine.filter((row) => row.status === 'approved').length,
    pendingCount: mine.filter((row) => row.status === 'pending').length,
  };
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

function updateSubmission_(classId, studentName, updater) {
  return updateRow_(SHEET_SUBMISSIONS, (row) => row.classId === classId && sameName_(row.studentName, studentName), updater);
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
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (err) {
    return String(value).split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function parseUpdates_(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      studentName: String(item.studentName || ''),
      busySlots: parseBusySlots_(item.busySlots),
    })).filter((item) => item.studentName.trim());
  } catch (err) {
    return [];
  }
}

function sameName_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
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
