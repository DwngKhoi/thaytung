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
```

## Lưu ý deploy

- `.env` chứa mật khẩu DB, không commit file này.
- Nếu trang học sinh deploy ở host khác backend, đặt `CORS_ORIGIN` thành đúng domain trang học sinh.
- Đây vẫn là bản đơn giản: mật khẩu giáo viên đang để demo trong code và chưa có phiên đăng nhập thật. Nên bổ sung bảo mật trước khi mở rộng.
