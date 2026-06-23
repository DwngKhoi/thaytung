# 📅 Xếp lịch học cho lớp

Web giúp **giáo viên** chọn buổi học phù hợp nhất với cả lớp, dựa trên **lịch bận** mà **học sinh** gửi lên.

## Tính năng

- **Trang giáo viên:** đăng nhập, tạo lớp, xem bảng lịch cả lớp, duyệt/xoá đăng ký, chỉnh lịch bận của học sinh, lưu trữ/khôi phục lớp cũ.
- **Trang học sinh:** chọn lớp, nhập tên, tích các buổi mình **bận**, gửi cho giáo viên duyệt. Gửi lại cùng tên sẽ sửa lịch cũ thay vì tạo trùng.
- Bảng thống kê tự đếm số người bận từng buổi, tô xanh buổi ít người bận nhất và gợi ý lịch học tối ưu.
- Dữ liệu lưu trên MongoDB Atlas nên học sinh vẫn gửi được khi giáo viên tắt máy.

## Cách chạy local

1. Cài thư viện:
   ```bash
   npm install
   ```

2. Tạo file `.env` từ `.env.example` và điền chuỗi kết nối MongoDB Atlas:
   ```env
   MONGODB_URI=mongodb+srv://lichlop:<mat_khau>@cluster0.xxxxx.mongodb.net/lichlop?retryWrites=true&w=majority
   DB_NAME=lichlop
   PORT=3000
   CORS_ORIGIN=*
   TEACHER_USERNAME=gv
   TEACHER_PASSWORD=mat_khau_manh
   TEACHER_NAME=Thay/Co
   ```

   Lấy chuỗi ở Atlas: **Connect → Drivers → Node.js**. Nhớ thay `<mat_khau>` và thêm `/lichlop` trước dấu `?`.

3. Chạy server:
   ```bash
   npm start
   ```

4. Mở trình duyệt:
   - Giáo viên: http://localhost:3000
   - Học sinh: http://localhost:3000/student.html

Lần chạy đầu, nếu database trống, server sẽ tự seed 3 lớp **F12 / F13 / F14**.

## Publish miễn phí bằng Google Sheets + Apps Script

Cách này không cần Render chạy 24/7. Dữ liệu nằm trong một Google Sheet private, học sinh gửi qua Apps Script.

1. Tạo Google Sheet mới, đặt tên ví dụ `Lich Lop Data`.
2. Trong Sheet: **Extensions → Apps Script**.
3. Xoá code mặc định, dán toàn bộ nội dung file `apps-script/Code.gs`.
4. Vào **Project Settings → Script Properties**, thêm:
   ```text
   STUDENT_KEY = doi-key-hoc-sinh
   TEACHER_KEY = doi-key-giao-vien
   TEACHER_USERNAME = gv
   TEACHER_PASSWORD = mat_khau_manh
   TEACHER_NAME = Thay/Co
   ```
5. Bấm **Deploy → New deployment → Web app**:
   - Execute as: `Me`
   - Who has access: `Anyone`
6. Copy Web App URL dạng:
   ```text
   https://script.google.com/macros/s/.../exec
   ```
7. Copy `public/config.example.js` thành `public/config.js`, rồi sửa:
   ```js
   window.GAS_API_URL = 'URL Apps Script vua copy';
   window.STUDENT_KEY = 'doi-key-hoc-sinh';
   window.TEACHER_KEY = 'doi-key-giao-vien';
   ```
8. Publish thư mục `public/` bằng GitHub Pages hoặc host tĩnh bất kỳ.

Link dùng sau khi publish:

- Giáo viên: `/index.html`
- Học sinh: `/student.html`

Khi sửa code Apps Script sau này: **Deploy → Manage deployments → Edit → Version: New version → Deploy**. Nếu không tạo version mới, web vẫn chạy code Apps Script cũ.

Lưu ý: `public/config.js` chứa key cơ bản và có thể commit nếu publish bằng GitHub Pages public repo. Key này chỉ dùng để chặn truy cập vô tình, không phải bảo mật tuyệt đối.

## Tài khoản giáo viên demo

| Tài khoản | Mật khẩu |
| --- | --- |
| `gv` | `123456` |
| `teacher` | `teacher` |

Sửa danh sách trong `server.js` (mảng `TEACHERS`).

## Cấu trúc

```text
server.js             Backend Express + API, lưu vào MongoDB
.env                  Cấu hình bí mật (KHÔNG commit) - xem .env.example
.env.example          Mẫu cấu hình
public/
  index.html          Trang giáo viên
  student.html        Trang học sinh
  style.css           CSS dùng chung
  app.js              Logic frontend dùng chung
render.yaml           Cấu hình deploy Render
apps-script/Code.gs   Backend Google Sheets + Apps Script
```

## Lưu ý deploy

- `.env` chứa mật khẩu DB, không commit file này.
- Nếu trang học sinh deploy ở host khác backend, đặt `CORS_ORIGIN` thành đúng domain trang học sinh.
- Đây vẫn là bản đơn giản: mật khẩu giáo viên đang để demo trong code và chưa có phiên đăng nhập thật. Nên bổ sung bảo mật trước khi mở rộng.
