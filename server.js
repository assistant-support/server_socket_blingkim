// server.js
// ------------------------------------------------------------
// Khởi tạo Express + Socket.IO, cấu hình CORS, healthcheck,
// (tuỳ chọn) route broadcast /api/emit, đăng ký event handlers, và logging.
// Ghi chú: để thấy log tick poll trong handlers, đặt LOG_LEVEL=debug
// ------------------------------------------------------------

import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import cors from 'cors';

import { PORT, CORS_ORIGINS, POLL_INTERVAL_MS } from './config/environment.js';
import { registerEventHandlers } from './events/index.js';
import { emitRouter } from './routes/emit.route.js';
import { log } from './utils/logger.js';

const app = express();

// Nếu chạy sau proxy (Nginx/Ingress), bật trust proxy để log IP chính xác
app.set('trust proxy', true);

// ===== Các tuỳ chọn runtime qua ENV =====
const FORCE_WS_ONLY = (process.env.FORCE_WS_ONLY || 'false') === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// ===== Middlewares (HTTP) =====
app.use(cors({
    origin: CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
}));
app.use(express.json());

// ===== Healthcheck + Stats =====
app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        time: new Date().toISOString(),
        pollMs: POLL_INTERVAL_MS,
        origins: CORS_ORIGINS,
        logLevel: LOG_LEVEL,
        wsOnly: FORCE_WS_ONLY,
    });
});

// Tạo HTTP server trước khi khởi tạo Socket.IO
const server = http.createServer(app);

// ===== Khởi tạo Socket.IO =====
const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: CORS_ORIGINS, credentials: true },
    transports: FORCE_WS_ONLY ? ['websocket'] : ['websocket', 'polling'],
    pingInterval: 25_000,
    pingTimeout: 60_000,
    allowEIO3: true,
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
    },
});

// (Tuỳ chọn) API broadcast sự kiện tới tất cả client
// LƯU Ý: phải gọi SAU khi đã có biến io
app.use('/api/emit', emitRouter(io));

// Bắt lỗi kết nối engine (debug CORS/proxy)
io.engine.on('connection_error', (err) => {
    log.warn('io', null, 'engine connection_error code=%s msg=%s', err?.code, err?.message);
});

// (Tuỳ chọn) Bảo vệ socket bằng middleware auth nếu cần
// io.use(authMiddleware)

io.on('connection', (socket) => {
    const ip =
        socket.handshake.headers['x-forwarded-for'] ||
        socket.handshake.address ||
        socket.conn?.remoteAddress ||
        'unknown';
    const ua = socket.handshake.headers['user-agent'];

    log.info('io', socket.id, 'connected ip=%s ua=%s', ip, ua);

    registerEventHandlers(io, socket);

    socket.on('disconnect', (reason) => {
        log.info('io', socket.id, 'disconnected reason=%s', reason);
    });
});

// Lắng nghe
server.listen(PORT, () => {
    log.info(
        'boot',
        null,
        'Socket.IO running on %d (poll=%dms) origins=%o wsOnly=%s logLevel=%s',
        PORT,
        POLL_INTERVAL_MS,
        CORS_ORIGINS,
        FORCE_WS_ONLY,
        LOG_LEVEL
    );
});

// Bắt lỗi tổng quát để không crash âm thầm
process.on('unhandledRejection', (e) =>
    log.error('process', null, 'unhandledRejection %s', e?.stack || e)
);
process.on('uncaughtException', (e) =>
    log.error('process', null, 'uncaughtException %s', e?.stack || e)
);

// Graceful shutdown
const shutdown = (signal) => {
    log.info('boot', null, 'received %s -> shutting down', signal);
    io.close(() => {
        server.close(() => {
            log.info('boot', null, 'http + socket server closed');
            process.exit(0);
        });
    });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
