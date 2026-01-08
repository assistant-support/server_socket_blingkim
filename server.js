// server.js
// ------------------------------------------------------------
// Khởi tạo Express + Socket.IO, cấu hình CORS, healthcheck,
// route broadcast /api/emit, đăng ký event handlers, và logging.
// ------------------------------------------------------------

import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { PORT, CORS_ORIGINS, POLL_INTERVAL_MS } from './config/environment.js';
import { registerEventHandlers } from './events/index.js';
import { emitRouter } from './routes/emit.route.js';
import { log } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// Khởi tạo Socket.IO
const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: CORS_ORIGINS, credentials: true },
});

// Middlewares (HTTP)
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json());

// Serve static files from public directory
app.use('/ZaloQR', express.static(path.join(__dirname, 'public/ZaloQR'), {
    setHeaders: (res, filePath) => {
        // Cho phép CORS cho static files
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// Serve static files from _zalo_qr directory (cho QR mới)
app.use('/_zalo_qr', express.static(path.join(__dirname, 'public/_zalo_qr'), {
    setHeaders: (res, filePath) => {
        // Cho phép CORS cho static files
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// Healthcheck
app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        time: new Date().toISOString(),
        pollMs: POLL_INTERVAL_MS,
        origins: CORS_ORIGINS,
        logLevel: process.env.LOG_LEVEL || 'info',
    });
});

// Test endpoint để kiểm tra QR file
app.get('/test-qr', (_req, res) => {
    const qrPath = path.join(__dirname, 'public/ZaloQR/qr.png');
    const exists = fs.existsSync(qrPath);
    if (exists) {
        const stats = fs.statSync(qrPath);
        res.json({
            exists: true,
            path: qrPath,
            size: stats.size,
            url: '/ZaloQR/qr.png',
            fullUrl: `http://localhost:${PORT}/ZaloQR/qr.png`
        });
    } else {
        res.json({
            exists: false,
            path: qrPath,
            message: 'QR file not found'
        });
    }
});

// API broadcast sự kiện tới tất cả client (dùng nội bộ/BE)
app.use('/api/emit', emitRouter(io));

// (Tuỳ chọn) Bảo vệ socket bằng middleware auth nếu cần
// io.use(authMiddleware)

io.on('connection', (socket) => {
    log.info('io', socket.id, 'connected ip=%s ua=%s', socket.handshake.address, socket.handshake.headers['user-agent']);
    registerEventHandlers(io, socket);
    socket.on('disconnect', (reason) => {
        log.info('io', socket.id, 'disconnected reason=%s', reason);
    });
});

server.listen(PORT, () => {
    log.info('boot', null, 'Socket.IO running on %d (poll=%dms) origins=%o', PORT, POLL_INTERVAL_MS, CORS_ORIGINS);
});

// Bắt lỗi tổng quát để không crash âm thầm
process.on('unhandledRejection', (e) => log.error('process', null, 'unhandledRejection %s', e?.stack || e));
process.on('uncaughtException', (e) => log.error('process', null, 'uncaughtException %s', e?.stack || e));
