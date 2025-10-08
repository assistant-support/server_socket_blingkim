// server.js
import http from 'http'
import express from 'express'
import { Server } from 'socket.io'
import cors from 'cors'

import { PORT, CORS_ORIGINS, POLL_INTERVAL_MS } from './config/environment.js'
// import { authMiddleware } from './middleware/auth.middleware.js' // không dùng trong mode đơn giản
import { registerEventHandlers } from './events/index.js'
import { emitRouter } from './routes/emit.route.js' // giữ nguyên để web có thể emit khi cần

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: CORS_ORIGINS, credentials: true },
})

// Middlewares (HTTP)
app.use(cors({ origin: CORS_ORIGINS, credentials: true }))
app.use(express.json())

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }))

// API để web/BE có thể đẩy event về client (tuỳ chọn dùng)
app.use('/api/emit', emitRouter(io))

// ⚠️ Mode đơn giản: KHÔNG xác thực socket
// io.use(authMiddleware)

io.on('connection', (socket) => {
    registerEventHandlers(io, socket)
})

server.listen(PORT, () =>
    console.log(`Socket.IO running on ${PORT} (poll=${POLL_INTERVAL_MS}ms)`),
)
