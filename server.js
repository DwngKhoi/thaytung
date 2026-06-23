require('dotenv').config();

// Ép Node dùng DNS công cộng để tra cứu SRV của mongodb+srv://
// (tránh lỗi "querySrv ECONNREFUSED" do c-ares chọn nhầm DNS của card mạng ảo)
const dns = require('dns');
try {
  dns.setServers((process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1').split(','));
} catch (e) {
  console.warn('⚠️ Không đặt được DNS tuỳ chỉnh:', e.message);
}

const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'lichlop';
const TEACHER_USERNAME = process.env.TEACHER_USERNAME || 'gv';
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '123456';
const TEACHER_NAME = process.env.TEACHER_NAME || 'Thay/Co';

if (!MONGODB_URI) {
  console.error('❌ Thiếu MONGODB_URI. Hãy tạo file .env (xem .env.example).');
  process.exit(1);
}

app.use(express.json());

// ---- CORS: cho phép trang Học sinh ở host khác gọi API ----
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Tài khoản giáo viên cố định (demo) ----
const TEACHERS = [
  { username: 'gv', password: '123456', name: 'Thầy/Cô A' },
  { username: 'teacher', password: 'teacher', name: 'Thầy/Cô B' },
];

// ---- Cấu hình khung giờ: 7 ngày x 4 buổi ----
const DAYS = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
const DAYS_SHORT = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const SESSIONS = ['S', 'C', '57', 'T'];
const SESSIONS_FULL = ['Sáng', 'Chiều', '57', 'Tối'];

// ---- MongoDB ----
let classes; // collection

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  classes = db.collection('classes');
  // Seed lớp mặc định nếu DB trống
  if ((await classes.countDocuments()) === 0) {
    await classes.insertMany([
      { id: 'c1', name: 'F12', archived: false, submissions: [] },
      { id: 'c2', name: 'F13', archived: false, submissions: [] },
      { id: 'c3', name: 'F14', archived: false, submissions: [] },
    ]);
    console.log('🌱 Đã seed 3 lớp mặc định F12/F13/F14');
  }
  console.log('✅ Kết nối MongoDB thành công');
}

// So khớp tên không phân biệt hoa/thường và khoảng trắng thừa
function sameName(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Số liệu tóm tắt cho 1 lớp
function summarize(c) {
  return {
    id: c.id,
    name: c.name,
    approvedCount: c.submissions.filter((s) => s.status === 'approved').length,
    pendingCount: c.submissions.filter((s) => s.status === 'pending').length,
  };
}

// Bọc handler async để bắt lỗi gọn
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  });

// ---------------- API ----------------

// Cấu hình khung giờ cho frontend
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({ days: DAYS, daysShort: DAYS_SHORT, sessions: SESSIONS, sessionsFull: SESSIONS_FULL });
});

// Đăng nhập giáo viên
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const t = [{ username: TEACHER_USERNAME, password: TEACHER_PASSWORD, name: TEACHER_NAME }]
    .find((x) => x.username === username && x.password === password);
  if (!t) return res.status(401).json({ ok: false, error: 'Sai tài khoản hoặc mật khẩu' });
  res.json({ ok: true, name: t.name });
});

// Danh sách lớp đang hoạt động (chưa bị xoá)
app.get('/api/classes', wrap(async (req, res) => {
  const list = await classes.find({ archived: { $ne: true } }).toArray();
  res.json(list.map(summarize));
}));

// Danh sách lớp đã xoá (lưu trữ)
app.get('/api/archived-classes', wrap(async (req, res) => {
  const list = await classes.find({ archived: true }).toArray();
  res.json(list.map(summarize));
}));

// Xoá vĩnh viễn toàn bộ lớp đã lưu trữ
app.delete('/api/archived-classes', wrap(async (req, res) => {
  await classes.deleteMany({ archived: true });
  res.json({ ok: true });
}));

// Tạo lớp mới (giáo viên)
app.post('/api/classes', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Thiếu tên lớp' });
  const id = 'c' + Date.now();
  await classes.insertOne({ id, name: name.trim(), archived: false, submissions: [] });
  res.json({ ok: true, id });
}));

// Xoá mềm: chuyển lớp vào mục "Lớp Cũ"
app.post('/api/classes/:id/archive', wrap(async (req, res) => {
  const r = await classes.updateOne({ id: req.params.id }, { $set: { archived: true } });
  if (!r.matchedCount) return res.status(404).json({ error: 'Không tìm thấy lớp' });
  res.json({ ok: true });
}));

// Khôi phục lớp từ "Lớp Cũ"
app.post('/api/classes/:id/restore', wrap(async (req, res) => {
  const r = await classes.updateOne({ id: req.params.id }, { $set: { archived: false } });
  if (!r.matchedCount) return res.status(404).json({ error: 'Không tìm thấy lớp' });
  res.json({ ok: true });
}));

// Xoá vĩnh viễn 1 lớp
app.delete('/api/classes/:id', wrap(async (req, res) => {
  const r = await classes.deleteOne({ id: req.params.id });
  if (!r.deletedCount) return res.status(404).json({ error: 'Không tìm thấy lớp' });
  res.json({ ok: true });
}));

// Chi tiết 1 lớp
app.get('/api/classes/:id', wrap(async (req, res) => {
  const cls = await classes.findOne({ id: req.params.id }, { projection: { _id: 0 } });
  if (!cls) return res.status(404).json({ error: 'Không tìm thấy lớp' });
  res.json(cls);
}));

// Học sinh gửi lịch bận (upsert theo tên)
app.post('/api/classes/:id/submit', wrap(async (req, res) => {
  const { studentName, busySlots } = req.body || {};
  if (!studentName || !studentName.trim())
    return res.status(400).json({ error: 'Thiếu tên học sinh' });
  const cls = await classes.findOne({ id: req.params.id });
  if (!cls) return res.status(404).json({ error: 'Không tìm thấy lớp' });

  const slots = Array.isArray(busySlots) ? busySlots : [];
  const subs = cls.submissions || [];
  const existing = subs.find((s) => sameName(s.studentName, studentName));
  if (existing) {
    // Đã gửi trước đó -> sửa lại, cần duyệt lại
    existing.busySlots = slots;
    existing.status = 'pending';
    existing.studentName = studentName.trim();
  } else {
    subs.push({ studentName: studentName.trim(), busySlots: slots, status: 'pending' });
  }
  await classes.updateOne({ id: req.params.id }, { $set: { submissions: subs } });
  res.json({ ok: true });
}));

// Giáo viên duyệt 1 đăng ký
app.post('/api/classes/:id/approve', wrap(async (req, res) => {
  const { studentName } = req.body || {};
  const cls = await classes.findOne({ id: req.params.id });
  if (!cls) return res.status(404).json({ error: 'Không tìm thấy lớp' });
  const sub = (cls.submissions || []).find((s) => sameName(s.studentName, studentName || ''));
  if (!sub) return res.status(404).json({ error: 'Không tìm thấy đăng ký' });
  sub.status = 'approved';
  await classes.updateOne({ id: req.params.id }, { $set: { submissions: cls.submissions } });
  res.json({ ok: true });
}));

// Giáo viên từ chối / xoá 1 đăng ký
app.post('/api/classes/:id/reject', wrap(async (req, res) => {
  const { studentName } = req.body || {};
  const cls = await classes.findOne({ id: req.params.id });
  if (!cls) return res.status(404).json({ error: 'Không tìm thấy lớp' });
  const subs = (cls.submissions || []).filter((s) => !sameName(s.studentName, studentName || ''));
  await classes.updateOne({ id: req.params.id }, { $set: { submissions: subs } });
  res.json({ ok: true });
}));

// Giáo viên chỉnh lịch bận của 1 học sinh (edit mode)
app.post('/api/classes/:id/bulk-update-busy', wrap(async (req, res) => {
  const { updates } = req.body || {};
  const cls = await classes.findOne({ id: req.params.id });
  if (!cls) return res.status(404).json({ error: 'KhÃ´ng tÃ¬m tháº¥y lá»›p' });
  const list = Array.isArray(updates) ? updates : [];
  let count = 0;
  list.forEach((item) => {
    const sub = (cls.submissions || []).find((s) => sameName(s.studentName, item.studentName || ''));
    if (!sub) return;
    sub.busySlots = Array.isArray(item.busySlots) ? item.busySlots : [];
    count++;
  });
  await classes.updateOne({ id: req.params.id }, { $set: { submissions: cls.submissions } });
  res.json({ ok: true, count });
}));

app.post('/api/classes/:id/update-busy', wrap(async (req, res) => {
  const { studentName, busySlots } = req.body || {};
  const cls = await classes.findOne({ id: req.params.id });
  if (!cls) return res.status(404).json({ error: 'Không tìm thấy lớp' });
  const sub = (cls.submissions || []).find((s) => sameName(s.studentName, studentName || ''));
  if (!sub) return res.status(404).json({ error: 'Không tìm thấy học sinh' });
  sub.busySlots = Array.isArray(busySlots) ? busySlots : [];
  await classes.updateOne({ id: req.params.id }, { $set: { submissions: cls.submissions } });
  res.json({ ok: true });
}));

// ---- Khởi động ----
connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ Server chạy tại http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('❌ Không kết nối được MongoDB:', e.message);
    process.exit(1);
  });
