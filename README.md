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

Lưu ý migration: bản có ngày sinh sẽ tự đổi cấu trúc sheet `Submissions`. Dữ liệu học sinh cũ không có ngày sinh sẽ bị xoá, nhưng sheet `Classes` và các lớp đã thêm được giữ lại.

Lưu ý: `public/config.js` chứa key cơ bản và có thể commit nếu publish bằng GitHub Pages public repo. Key này chỉ dùng để chặn truy cập vô tình, không phải bảo mật tuyệt đối.

## Chuyển sang Supabase

Supabase nhanh hơn Apps Script/Google Sheets vì dữ liệu nằm trong Postgres và frontend gọi RPC trực tiếp.

1. Tạo project mới trên Supabase.
2. Vào **SQL Editor**.
3. Dán toàn bộ file `supabase/OLYMPUS_ALL_IN_ONE.sql` và bấm **Run**.
4. Vào **Project Settings → API**, copy:
   - Project URL
   - anon public key
5. Sửa `public/config.js`:
   ```js
   window.SUPABASE_URL = 'https://PROJECT_REF.supabase.co';
   window.SUPABASE_ANON_KEY = 'anon public key';
   window.STUDENT_KEY = 'CHANGE_STUDENT_KEY';
   window.TEACHER_KEY = 'CHANGE_TEACHER_KEY';
   ```
6. Push lại nhánh `main`; GitHub Actions sẽ tự deploy thư mục `public/`.

Khi `SUPABASE_URL` và `SUPABASE_ANON_KEY` có giá trị, frontend sẽ ưu tiên Supabase và không gọi Apps Script nữa.

Khi nâng cấp database Supabase đã có, cũng chạy lại đúng file `supabase/OLYMPUS_ALL_IN_ONE.sql`.

### Một file SQL duy nhất

Project chỉ còn một file database: `supabase/OLYMPUS_ALL_IN_ONE.sql`. File này chứa cả schema nền, RPC API và toàn bộ tính năng hồ sơ học sinh, Sổ chủ nhiệm, Bảng công, đồng bộ lịch, Lịch chia, cá nhân hoá và mẫu tuần.

- **Project mới hoàn toàn:** chạy `OLYMPUS_ALL_IN_ONE.sql`.
- **Project đang sử dụng:** cũng chạy `OLYMPUS_ALL_IN_ONE.sql`.
- Có thể chạy lại file này; dữ liệu lớp, học sinh, lịch, sổ chủ nhiệm và cấu hình hiện có được giữ nguyên.
- Các tab `Untitled query` cũ trong Supabase chỉ là bản nháp phía trình duyệt; sau khi file tổng chạy thành công có thể đóng và chọn **Discard**.

### Mã học sinh, hồ sơ và cổng phụ huynh (Olympus Portal)

Tính năng này đã nằm trong file SQL tổng. Chạy `supabase/OLYMPUS_ALL_IN_ONE.sql` để kích hoạt hoặc cập nhật.

- **Mã học sinh:** mỗi học sinh được cấp mã duy nhất trộn từ tên + ngày sinh, ví dụ `Lê Đăng Khôi` sinh 09/03 → `LDK0903` (chữ cái đầu các từ trong tên đã bỏ dấu + ngày-tháng sinh; nếu trùng sẽ tự thêm 1 ký tự hậu tố). Mã cấp một lần và giữ nguyên kể cả khi đổi tên; owner có thể "Cấp lại mã" trong tab Hồ sơ. Học sinh cũ được tự cấp mã ngay khi chạy SQL.
- **Tab Hồ sơ HS (console giáo viên):** tìm học sinh theo tên/mã, xem và nhập các trường thông tin (điểm đầu vào...), xem lộ trình khóa học, copy mã hoặc link tra cứu cho phụ huynh. Owner bấm **Trường thông tin** để tự định nghĩa trường (kiểu chữ/số/ngày/lựa chọn) và tick **PH xem** cho những trường phụ huynh được thấy.
- **Cổng phụ huynh `parent.html`:** phụ huynh nhập mã học sinh là thấy thông tin con, lịch học tuần này của các lớp đang học và timeline lộ trình (F12 hoàn thành → F13 đang học...). Có chống dò mã: quá 30 lần nhập sai trong 15 phút mỗi IP sẽ bị chặn tạm. Mở `parent.html?demo=1` để xem giao diện với dữ liệu mẫu.
- **Lịch sử khóa học:** hệ thống tự ghi sự kiện đăng ký / bắt đầu / chuyển lớp / hoàn thành (lớp đưa vào lưu trữ = hoàn thành khóa) vào bảng `student_class_history`, nên chuyển lớp không còn làm mất dấu vết học sinh đã học lớp nào.
- Giáo viên có quyền với học sinh có thể sửa trực tiếp họ tên/ngày sinh và thông tin hồ sơ; thay đổi danh tính được đồng bộ tới mọi lớp của học sinh đó.

Lưu ý: mã học sinh suy ra được từ tên + ngày sinh, nên chỉ bật **PH xem** cho các trường không nhạy cảm.

### Bảng công và trò chơi từ vựng

Các bảng và RPC của Bảng công, từ vựng và luồng đồng bộ đều đã nằm trong file SQL tổng.

- **Bảng công:** mỗi dòng lấy từ một buổi LR/S/W trong Sổ chủ nhiệm. Sĩ số, có mặt và vắng được tính trực tiếp từ record nên không lưu lặp dữ liệu. Owner và giáo viên được phân công lớp có thể nhập ngày, giáo viên, giờ vào/ra, số tiết, trạng thái và ghi chú.
- **Đồng bộ lịch:** trong tab Lịch, mỗi ô học có thể chọn giờ bắt đầu và giáo viên từ dropdown hệ thống. Khi lưu, Sổ chủ nhiệm tự điền mã buổi, thứ/ngày, giờ và giáo viên; Bảng công tiếp tục lấy các thông tin đó cùng dữ liệu điểm danh.
- **Trò chơi:** dữ liệu gốc 520 từ của ba mức Complete IELTS nằm trong `public/vocab-data.js`; owner có thể thêm/bỏ từ theo từng Unit. Supabase chỉ lưu phần thay đổi nên không nhân đôi toàn bộ bộ từ.
- `attendance_entries` chỉ lưu phần giáo viên nhập tay dưới dạng một JSON nhỏ cho mỗi buổi. Sổ chủ nhiệm tiếp tục lưu một JSON đã rút gọn cho mỗi `lớp × kỹ năng`; màu/nội dung mặc định không ghi xuống database.

### Lịch chia v2

- **Tối giản** là chế độ mặc định, trình bày theo thói quen của file xếp lịch Olympus: mỗi ngày gồm cột **Buổi khoá** và **Nội dung**; lớp được nhóm theo sector.
- **Thêm ca** giữ bảng chi tiết theo giờ, phòng, lớp, kỹ năng, giáo viên và ghi chú để xử lý các buổi trùng địa điểm.
- Trong lịch từng lớp, bấm trực tiếp vào ô rồi chọn `LR / L / R / W / S / MT / FT / Off`; không còn kéo-thả.
- Số buổi toàn khoá và số buổi từng kỹ năng được tính tự động. Hai ô MT/FT liên tiếp dùng chung một số buổi theo dạng `18a`, `18b`; buổi tiếp theo là `19`. Off không tăng số.
- Với dữ liệu lịch cũ chưa từng lưu số buổi toàn khoá, owner mở từng lớp và nhập **Buổi khoá bắt đầu từ** đúng một lần (ví dụ đã học 17 buổi thì nhập 18).
- Lớp ngữ pháp chỉ hiển thị số buổi toàn khoá. Hệ thống tự nhận diện ban đầu từ mã lớp `G...` hoặc sector có tên “Ngữ pháp”, sau đó owner vẫn đổi được loại lớp.
- Lịch ở tab **Lớp học**, trang lịch công khai, Sổ chủ nhiệm và Bảng công đều đọc cùng dữ liệu tuần đã chốt.

### Lịch chia v3: lọc lớp và bốn ca dự phòng

- Bảng **Tối giản** có nút **Chỉnh sửa** để đổi nội dung, màu chữ, màu nền, chiều rộng và chiều cao của toàn bộ ô.
- Nút **Chọn lớp** cho phép ẩn các lớp phụ/backup khỏi cả hai chế độ. Danh sách ẩn chỉ là tuỳ chọn hiển thị của trình duyệt, không xoá dữ liệu lớp.
- Các hàng Tối giản có chiều cao đồng đều; ô đã chọn nhưng chưa xếp kỹ năng vẫn hiện tên ca để không bị hiểu nhầm là trống.
- Mỗi ô trong lịch từng lớp lưu tối đa **4 ca**. Chế độ **Tối giản** chỉ còn 7 cột **Thứ 2–Chủ nhật** và lấy nội dung từ ca chính; chế độ **Thêm ca** mới hiện các buổi cùng cả bốn ca và dùng `☆` để đổi ca chính.
- Chỉ ca chính đồng bộ sang tab Lớp học, trang học sinh, Sổ chủ nhiệm và Bảng công. Ba ca còn lại là dữ liệu dự phòng, được lưu gọn trong cùng JSON của tuần.

### Cá nhân hoá Olympus v4

- Tab **Cấu hình Olympus** cho owner đặt tên trung tâm, tên owner mặc định và chế độ lịch mặc định.
- **Preset góc nhìn** lưu đồng thời chế độ Tối giản/Thêm ca, lớp đang ẩn, trạng thái thu gọn và sector đang mở. Owner lưu dùng chung; giáo viên có thể áp dụng các preset được cấp.
- **Thư viện ký hiệu** cho phép đổi màu nền/màu chữ của `LR`, `L`, `R`, `W`, `S`, `MT`, `FT`, `Off`; màu được áp dụng vào Toàn cảnh, lịch từng lớp và lịch công khai.
- **Địa điểm và cơ sở** thay thế danh sách Tầng 1/Tầng 2/CS2 cố định. Mã, tên và màu địa điểm được dùng lại khi chỉnh thông tin buổi học.
- Toàn bộ cấu hình chỉ là một JSON nhỏ trong `app_settings`, có bản cache local để giao diện vẫn dùng được khi mạng chập chờn.

### Mẫu tuần và cảnh báo lịch v5

- Nút **Lưu mẫu** trong lịch từng lớp lưu một mẫu khung giờ hoặc toàn bộ lịch của tuần đang mở.
- **+ Tuần mới** có thể tạo tuần trống, sao chép giờ/phòng/giáo viên, sao chép toàn bộ tuần hoặc dùng một mẫu đã lưu.
- Mẫu thuộc đúng lớp và dùng chung cho owner cùng giáo viên được phân công lớp đó.
- **Trung tâm cảnh báo** trên Lịch chia phát hiện giáo viên, địa điểm hoặc chính một lớp bị xếp trùng theo thứ và giờ bắt đầu; nếu chưa nhập giờ thì hệ thống dùng tên ca.

### Dung lượng Supabase

Với vài trăm học sinh và vài nghìn buổi, dữ liệu dự kiến chỉ ở mức vài đến vài chục MB. Thiết kế hiện tại tránh lưu ảnh/file trong Postgres, không nhân bản danh sách điểm danh vào Bảng công và chỉ giữ các ô Sổ chủ nhiệm khác mặc định, nên còn cách rất xa quota database 500 MB của Free Plan.

Có thể kiểm tra dung lượng trong SQL Editor:

```sql
select pg_size_pretty(pg_database_size(current_database())) as database_size;

select
  relname as table_name,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size
from pg_catalog.pg_statio_user_tables
order by pg_total_relation_size(relid) desc;
```

### Quyền giáo viên trên Supabase

- Tài khoản owner lấy từ `TEACHER_USERNAME`, `TEACHER_PASSWORD`, `TEACHER_NAME` trong bảng `app_settings`.
- Owner tạo tài khoản giáo viên bộ môn và phân công lớp trong tab **Tài khoản giáo viên**.
- Giáo viên bộ môn có đầy đủ quyền quản lý trên đúng các lớp owner đã phân công, đồng thời có thể tự điền Bảng công của các lớp đó.
- Phiên đăng nhập có hạn 30 ngày. Mật khẩu giáo viên bộ môn được băm bằng `pgcrypto`, token phiên chỉ được lưu dạng hash trong database.
- **Lịch hiện tại** được lưu riêng theo từng lớp. Ô này có màu vàng và bị khoá trên phiếu học sinh.

## Tài khoản giáo viên demo (backend Express cũ)

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
  index.html          Trang giáo viên (có tab Hồ sơ HS)
  student.html        Trang học sinh
  parent.html         Cổng phụ huynh (Olympus Portal, tra cứu bằng mã học sinh)
  schedule.html       Trang lịch học chỉ xem
  vocab-data.js       Dữ liệu tĩnh trò chơi từ vựng Complete IELTS
  style.css           CSS dùng chung
  app.js              Logic frontend dùng chung
render.yaml           Cấu hình deploy Render
apps-script/Code.gs   Backend Google Sheets + Apps Script
supabase/OLYMPUS_ALL_IN_ONE.sql  Toàn bộ schema + RPC, dùng cho cả cài mới và nâng cấp
```

## Lưu ý deploy

- `.env` chứa mật khẩu DB, không commit file này.
- Nếu trang học sinh deploy ở host khác backend, đặt `CORS_ORIGIN` thành đúng domain trang học sinh.
- Backend Supabase dùng phiên đăng nhập và kiểm tra quyền trong RPC; backend Express/Apps Script cũ chỉ còn là phương án dự phòng và không có mô hình giáo viên bộ môn mới.
