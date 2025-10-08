// middleware/auth.middleware.js
import jwt from 'jsonwebtoken';
import { AUTH_SECRET } from '../config/environment.js';

// Middleware này sẽ chạy mỗi khi có một client mới kết nối đến Socket.IO server.
// Nhiệm vụ của nó là xác thực token JWT được gửi từ client.
export const authMiddleware = (socket, next) => {
    try {
        // Lấy token từ object `auth` trong handshake
        const token = socket.handshake.auth?.token;
        if (!token) {
            return next(new Error('Authentication error: No token provided.'));
        }

        // Giải mã token bằng AUTH_SECRET
        const payload = jwt.verify(token, AUTH_SECRET);
        const uid = String(payload?.uid || '');

        if (!uid) {
            return next(new Error('Authentication error: Invalid token payload.'));
        }

        // Gán thông tin user vào `socket.data` để sử dụng ở các sự kiện sau này
        socket.data.uid = uid;
        socket.data.roleId = payload?.roleId ? String(payload.roleId) : null;

        // Cho user tham gia vào phòng riêng của họ.
        // Điều này cực kỳ hữu ích để gửi thông báo chỉ định cho một người dùng.
        socket.join(`user:${uid}`);

        // Nếu có vai trò, cho user tham gia vào phòng của vai trò đó.
        // Hữu ích để gửi thông báo cho cả một nhóm người dùng (ví dụ: tất cả admin).
        if (socket.data.roleId) {
            socket.join(`role:${socket.data.roleId}`);
        }
        next();
    } catch (e) {
        return next(new Error('Authentication error: Invalid token.'));
    }
};