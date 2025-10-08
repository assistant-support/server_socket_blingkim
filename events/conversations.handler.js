// events/conversations.handler.js
// Socket sẽ gọi Pancake để lấy danh sách & messages, và đẩy realtime cho CHÍNH socket hiện tại
// - conv:get       -> trả danh sách ban đầu + bật poll upsert patch
// - conv:loadMore  -> lấy thêm + emit patch upsert
// - conv:search    -> search theo tên (ACK)
// - msg:get        -> lấy messages 1 lần (ACK)
// - msg:watchStart -> bắt đầu poll messages cho 1 hội thoại, phát 'msg:new' khi có tin mới
// - msg:watchStop  -> dừng poll cho hội thoại đang theo dõi

import {
    getConversations,
    getConversationsSearch,
    getMessages
} from '../utils/pancake.js'
import { POLL_INTERVAL_MS, MSG_POLL_MS } from '../config/environment.js'

// Poll danh sách hội thoại theo socket
const convTimers = new Map() // socket.id -> NodeJS.Timer

// Poll messages theo socket + hội thoại
// key: `${socket.id}|${pageId}|${convoKey}` -> { timer, lastId }
const msgWatchers = new Map()

const watcherKey = (socketId, pageId, convoKey) => `${socketId}|${pageId}|${convoKey}`
// Lấy phần sau dấu "_" để gọi API messages (API yêu cầu {pageId}_{convoKey})
const extractConvoKey = (cid) => {
    if (!cid) return cid
    const s = String(cid)
    const i = s.indexOf('_')
    return i >= 0 ? s.slice(i + 1) : s
}

export function registerConversationEvents(io, socket) {
    // 🧹 cleanup khi socket disconnect
    socket.on('disconnect', () => {
        const t = convTimers.get(socket.id)
        if (t) { clearInterval(t); convTimers.delete(socket.id) }

        // dừng mọi watcher messages thuộc socket này
        for (const key of Array.from(msgWatchers.keys())) {
            if (key.startsWith(`${socket.id}|`)) {
                const w = msgWatchers.get(key)
                if (w?.timer) clearInterval(w.timer)
                msgWatchers.delete(key)
            }
        }
    })

    // ===== Danh sách hội thoại =====
    socket.on('conv:get', async (params, ack) => {
        const { pageId, token, current_count } = params || {}
        if (!pageId || !token) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing pageId/token' })
        }

        // clear poll cũ nếu có
        const old = convTimers.get(socket.id)
        if (old) { clearInterval(old); convTimers.delete(socket.id) }
        try {
            const items = await getConversations({ pageId, token, current_count })
            typeof ack === 'function' && ack({ ok: true, items })
            const timer = setInterval(async () => {
                try {
                    const incoming = await getConversations({ pageId, token, current_count })
                    socket.emit('conv:patch', { pageId, type: 'upsert', items: incoming })
                } catch (e) {
                    console.warn('[conv:poll] error:', e.message)
                }
            }, POLL_INTERVAL_MS)
            convTimers.set(socket.id, timer)
        } catch (e) {
            typeof ack === 'function' && ack({ ok: false, error: e.message })
        }
    })

    socket.on('conv:loadMore', async (params, ack) => {
        const { pageId, token, current_count } = params || {}
        if (!pageId || !token || !current_count) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' })
        }
        try {
            const items = await getConversations({ pageId, token, current_count })
            typeof ack === 'function' && ack({ ok: true, items })
            socket.emit('conv:patch', { pageId, type: 'upsert', items })
            // 👉 Cập nhật poll theo current_count mới (restart interval)
            const old = convTimers.get(socket.id)
            if (old) { clearInterval(old); convTimers.delete(socket.id) }
            const timer = setInterval(async () => {
                try {
                    const incoming = await getConversations({ pageId, token, current_count })
                    socket.emit('conv:patch', { pageId, type: 'upsert', items: incoming })
                } catch (e) {
                    console.warn('[conv:poll] error:', e.message)
                }
            }, POLL_INTERVAL_MS)
            convTimers.set(socket.id, timer)
        } catch (e) {
            typeof ack === 'function' && ack({ ok: false, error: e.message })
        }
    })

    socket.on('conv:search', async (params, ack) => {
        const { pageId, token, q } = params || {}
        if (!pageId || !token || !q) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' })
        }
        try {
            const items = await getConversationsSearch({ pageId, token, q })
            typeof ack === 'function' && ack({ ok: true, items })
        } catch (e) {
            typeof ack === 'function' && ack({ ok: false, error: e.message })
        }
    })

    // ===== Messages =====
    socket.on('msg:get', async (params, ack) => {
        const { pageId, token, conversationId, customerId } = params || {};
        // count có thể undefined hoặc 0 -> coi là 0
        let { count } = params || {};
        count = Number.isFinite(Number(count)) ? Number(count) : 0;

        if (!pageId || !token || !conversationId) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing pageId/token/conversationId' });
        }
        try {
            const items = await getMessages({ pageId, token, conversationId, customerId, count }); // count=0 => không gửi current_count
            return typeof ack === 'function' && ack({ ok: true, items });
        } catch (e) {
            return typeof ack === 'function' && ack({ ok: false, error: e.message });
        }
    });

    socket.on('msg:watchStart', async (params, ack) => {
        const { pageId, token, conversationId, customerId, intervalMs } = params || {};
        let { count } = params || {};
        count = Number.isFinite(Number(count)) ? Number(count) : 0; // 0 = từ đầu

        if (!pageId || !token || !conversationId) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' });
        }

        // clear watcher cũ nếu có
        const key = `${socket.id}:${pageId}:${conversationId}`;
        const old = msgWatchers.get(key);
        if (old) { clearInterval(old); msgWatchers.delete(key); }

        // lần đầu bắn 1 phát (từ count)
        try {
            const initial = await getMessages({ pageId, token, conversationId, customerId, count });
            // đẩy ngay để UI có dữ liệu nếu cần (bạn đang gọi msg:get trước rồi nên có thể bỏ)
            // socket.emit('msg:init', { pageId, conversationId, items: initial });

            typeof ack === 'function' && ack({ ok: true });

            // bật poll
            const timer = setInterval(async () => {
                try {
                    // ở đây bạn có thể dùng cursor/timestamp để chỉ lấy phần mới.
                    // nếu API chỉ hỗ trợ current_count, gọi lại giống ban đầu với count=0 hoặc giá trị tuỳ bạn
                    const incoming = await getMessages({ pageId, token, conversationId, customerId, count: 0 });
                    // lọc ra message mới so với lần trước (có thể track lastId/lastTime tuỳ bạn)
                    // đơn giản nhất: phát hết, client tự merge dedupe theo id
                    for (const m of incoming) {
                        socket.emit('msg:new', m);

                        // 👉 đẩy patch nhỏ cho sidebar để “nhảy lên đầu” ngay:
                        socket.emit('conv:patch', {
                            pageId,
                            type: 'upsert',
                            items: [{
                                id: `${pageId}_${conversationId}`, // khớp id client đang dùng
                                type: 'INBOX',
                                snippet: m?.content?.content || '',
                                updated_at: m?.inserted_at || new Date().toISOString()
                            }]
                        });
                    }
                } catch (e) {
                    console.warn('[msg:poll] error:', e.message);
                }
            }, Math.max(1000, Number(intervalMs || 2500)));

            msgWatchers.set(key, timer);
        } catch (e) {
            typeof ack === 'function' && ack({ ok: false, error: e.message });
        }
    });


    socket.on('msg:watchStop', (params, ack) => {
        const { pageId, conversationId } = params || {}
        if (!pageId || !conversationId) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' })
        }
        const key = watcherKey(socket.id, pageId, extractConvoKey(conversationId))
        const w = msgWatchers.get(key)
        if (w?.timer) clearInterval(w.timer)
        msgWatchers.delete(key)
        typeof ack === 'function' && ack({ ok: true, stopped: true })
    })
}
