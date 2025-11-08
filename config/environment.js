// config/environment.js
import 'dotenv/config'

// helper đọc & trim
const read = (k, def = '') => (process.env[k] ?? def).toString().trim()

export const PORT = Number(read('PORT', '3001'))

export const AUTH_SECRET = read('AUTH_SECRET')
export const ADMIN_API_KEY = read('ADMIN_API_KEY')
export const SERVICE_KEY = read('SERVICE_KEY')                // socket -> web
export const CONVERSATION_API_BASE = read('CONVERSATION_API_BASE') // vd: http://localhost:3000/api
export const UPLOAD_API_URL = read('UPLOAD_API_URL')          // optional
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || '3000')
export const MSG_POLL_MS = Number(process.env.MSG_POLL_MS || '2500')
export const CORS_ORIGINS = read('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

// Kiểm tra biến bắt buộc
const required = {
    AUTH_SECRET,
    ADMIN_API_KEY,
    CONVERSATION_API_BASE,
}
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
    console.error('[ENV] Missing required:', missing.join(', '))
    process.exit(1)
}

// Cảnh báo mềm nếu dùng chung secret (không dừng app)
if (SERVICE_KEY && SERVICE_KEY === AUTH_SECRET) {
    console.warn('[ENV] SERVICE_KEY đang trùng AUTH_SECRET. Nên tách khóa để an toàn hơn.')
}
if (ADMIN_API_KEY === AUTH_SECRET) {
    console.warn('[ENV] ADMIN_API_KEY đang trùng AUTH_SECRET. Nên dùng khóa khác cho /api/emit.')
}
