// routes/emit.route.js (broadcast, không room)
import { Router } from 'express'

export const emitRouter = (io) => {
    const r = Router()
    r.use((req, res, next) => {
        // Tuỳ chọn bảo vệ bằng x-api-key (khuyên dùng)
        const requiredKey = process.env.ADMIN_API_KEY
        if (!requiredKey) return next()
        if (req.headers['x-api-key'] !== requiredKey) {
            return res.status(401).json({ ok: false, error: 'Invalid API key' })
        }
        next()
    })

    r.post('/', (req, res) => {
        const { event, payload } = req.body || {}
        if (!event) return res.status(400).json({ ok: false, error: 'Missing "event"' })
        io.emit(event, payload) // <— BROADCAST tới tất cả client
        return res.json({ ok: true })
    })

    return r
}
