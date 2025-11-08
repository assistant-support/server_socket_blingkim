// routes/emit.route.js
// ------------------------------------------------------------
// Endpoint đơn giản để broadcast sự kiện ra tất cả client.
// Có tuỳ chọn xác thực bằng ADMIN_API_KEY (header x-api-key).
// ------------------------------------------------------------

import { Router } from 'express';
import { log } from '../utils/logger.js';

export const emitRouter = (io) => {
    const r = Router();

    // (Tuỳ chọn) Bảo vệ bằng x-api-key
    r.use((req, res, next) => {
        const requiredKey = process.env.ADMIN_API_KEY;
        if (!requiredKey) return next();
        if (req.headers['x-api-key'] !== requiredKey) {
            log.warn('emit', null, 'reject invalid api key from %s', req.ip);
            return res.status(401).json({ ok: false, error: 'Invalid API key' });
        }
        next();
    });

    // Broadcast
    r.post('/', (req, res) => {
        const { event, payload } = req.body || {};
        if (!event) return res.status(400).json({ ok: false, error: 'Missing "event"' });
        log.info('emit', null, 'broadcast event=%s payloadKeys=%o', event, payload ? Object.keys(payload) : []);
        io.emit(event, payload);
        return res.json({ ok: true });
    });

    return r;
};
