# Tối Nay Lọ Gì? 🎰

**Tiếng Việt** · [English](README.en.md)

Ứng dụng local mở hòm để chọn một nữ diễn viên. Pool được server trên máy crawl từ xếp hạng lượt xem tháng của XXX.Guru, bổ sung best-effort hồ sơ từ AvBase và Minnano-AV, rồi làm mới mỗi tuần.

<video src="assets/promo.mp4" controls="controls" muted="muted" width="100%"></video>

## Chạy trên máy

Cần Node.js 22.12+ và pnpm theo `package.json`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
redis-server
pnpm dev
```

Mở [127.0.0.1:3000](http://127.0.0.1:3000). Lần đầu server crawl nền; UI sẽ chờ snapshot cục bộ. Dùng `pnpm data:refresh` để buộc làm mới/dò lỗi. Crawl chỉ publish snapshot mới khi toàn bộ list, phim, hồ sơ và ảnh hợp lệ; cache hiện tại vẫn được giữ khi lỗi.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm preview
# Smoke test bản build trong thư mục tạm, không crawl nguồn thật:
pnpm test:production
```

Dùng `pnpm start` hoặc `pnpm preview` cho bản build, không chạy trực tiếp `next start`. Entry `scripts/serve.mjs` phục vụ các URL `/actress-cache/` hiện có bằng cách đọc file trên đĩa ở mỗi request; Next.js xử lý phần còn lại. Nhờ vậy snapshot/ảnh mới xuất hiện sau khi server đã khởi động vẫn tải được, không cần restart mỗi lần refresh. Lớp serve file chỉ cho phép manifest, trạng thái, snapshot và ảnh hợp lệ; không mở API mới hoặc cho đọc lock/staging. Manifest/trạng thái không cache; snapshot/ảnh dùng ETag và revalidate để nhận cả thay đổi cùng snapshot ID.

Server mặc định chỉ lắng nghe loopback. Khi enrich, server dùng `impit` với Chrome TLS fingerprint chỉ cho request AvBase. Sau khi snapshot đã có, browser chỉ tải JSON và ảnh local; XXX.Guru/AvBase/Wikipedia/X/Instagram/TikTok chỉ mở qua liên kết bạn bấm.

## Dữ liệu cục bộ

- Snapshot v4 và ảnh crawler nằm trong `public/actress-cache/` (gitignored); snapshot v3 cũ vẫn đọc được trong lúc refresh.
- XXX.Guru quyết định ranking/tier; XXBase chỉ bổ sung best-effort tên Nhật/ruby, ngày sinh, số đo, cup, nhóm máu, quê quán, sở thích, social, Wikipedia và ảnh DMM được tải lại vào cache local.
- Minnano-AV bổ sung rating, tag, năm debut và liên kết nguồn. Mỗi chu kỳ refresh lấy lại dữ liệu, nhưng tái sử dụng cache giữa các hồ sơ trong cùng chu kỳ; lỗi mạng/chặn nguồn không bị ghi nhớ thành kết quả “không tìm thấy”.
- Lock nằm trong `.cache/jav-crawler/refresh.lock/` (gitignored), chứa owner token/PID/hostname. Không lấy lại lock chỉ vì chạy quá một giờ; chỉ tự phục hồi khi PID cùng máy chắc chắn đã chết. Lock định dạng cũ, hỏng hoặc không rõ chủ sở hữu cần kiểm tra và dừng đúng tiến trình trước khi dọn thủ công. File staging và file tạm để publish được đặt cùng filesystem với cache đích để rename nguyên tử.
- Client tải tuần tự, có timeout và tự thử lại. Khi không tải được bản mới, danh sách đang dùng được giữ lại kèm cảnh báo thay vì hiển thị “Ready” như thể đã cập nhật thành công.
- Lọc tier, loại trừ diễn viên, ngôn ngữ, lựa chọn gần nhất và số lượt mở local nằm trong cookie host-only, versioned, có giới hạn. Số local này chỉ thuộc browser hiện tại.
- Bộ đếm `LƯỢT MỞ TOÀN SERVER` là số lượt mở hòm đã hoàn tất, được dùng chung bởi các client kết nối cùng Next.js server local và lưu tại Redis bằng key `toinaylogi:opens`. Chuỗi kết nối nằm trong `REDIS_URL` ở `.env` (mặc định local tại `redis://localhost:6379` trong `.env.example`); nó không phải metric deployment/cộng đồng.
- Redis không chạy thì vẫn mở hòm được và số local vẫn tăng; bộ đếm server sẽ hiện là không khả dụng và tự thử lại khi tải lại trang hoặc mở hòm lần sau.

## GitHub Pages, đóng góp và nguồn gốc

GitHub Pages chỉ redirect đến https://truanayangi.com/; chỉ `pages-redirect/` được publish lên `gh-pages`, còn app này chạy local từ `main`. Chào đón issue/fork PR vào `main` bằng Việt hoặc Anh, kể cả draft PR.

Dự án lấy cảm hứng từ [nagisanzenin/truanayangi](https://github.com/nagisanzenin/truanayangi). Repo giữ lịch sử từ `nagisanzenin/truanayangi`. Xem nguồn asset tại [ATTRIBUTION.md](ATTRIBUTION.md).
