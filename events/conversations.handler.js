// events/conversations.handler.js
// ------------------------------------------------------------
// Socket sẽ gọi Pancake để lấy danh sách & messages, và đẩy realtime
// cho chính socket hiện tại.
// - conv:get       -> trả danh sách ban đầu + bật poll upsert patch
// - conv:loadMore  -> lấy thêm + emit patch upsert (và restart poll theo current_count mới)
// - conv:search    -> search theo tên (ACK)
// - msg:get        -> lấy messages 1 lần (ACK)  **HỖ TRỢ count để load-more**
// - msg:watchStart -> bật poll messages cho 1 hội thoại, phát 'msg:new' khi có tin mới
// - msg:watchStop  -> dừng poll cho hội thoại đang theo dõi
// ------------------------------------------------------------

import {
    getConversations,
    getConversationsSearch,
    getMessages,
} from '../utils/pancake.js';

import { POLL_INTERVAL_MS } from '../config/environment.js';
import { log } from '../utils/logger.js';

// Poll danh sách hội thoại theo socket: socket.id -> NodeJS.Timer
const convTimers = new Map();

// Poll messages theo khóa watcher: `${socket.id}|${pageId}|${convoKey}` -> NodeJS.Timer
const msgWatchers = new Map();

/** Build key watcher đồng nhất */
const watcherKey = (socketId, pageId, convoKey) => `${socketId}|${pageId}|${convoKey}`;

/** Lấy phần sau dấu "_" (API messages yêu cầu {pageId}_{convoKey}) */
const extractConvoKey = (cid) => {
    if (!cid) return cid;
    const s = String(cid);
    
    // Đặc biệt xử lý cho TikTok: sử dụng conversation ID đầy đủ
    if (s.startsWith('ttm_')) {
        return s; // Trả về conversation ID đầy đủ cho TikTok
    }
    
    // Xử lý bình thường cho Facebook/Instagram
    const i = s.indexOf('_');
    return i >= 0 ? s.slice(i + 1) : s;
};

export function registerConversationEvents(io, socket) {
    // 🧹 Cleanup khi socket disconnect
    socket.on('disconnect', () => {
        const t = convTimers.get(socket.id);
        if (t) { clearInterval(t); convTimers.delete(socket.id); }
        log.info('conv', socket.id, 'cleanup conv poll timer cleared');

        // dừng mọi watcher messages thuộc socket này
        for (const key of Array.from(msgWatchers.keys())) {
            if (key.startsWith(`${socket.id}|`)) {
                const timer = msgWatchers.get(key);
                if (timer) clearInterval(timer);
                msgWatchers.delete(key);
                log.info('msg', socket.id, 'cleanup watcher key=%s cleared', key);
            }
        }
    });

    // ===== Danh sách hội thoại =====
    socket.on('conv:get', async (params, ack) => {
        const { pageId, token, current_count } = params || {};
        log.info('conv', socket.id, 'conv:get pageId=%s current_count=%s', pageId, current_count);
        if (!pageId || !token) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing pageId/token' });
        }

        // clear poll cũ nếu có
        const old = convTimers.get(socket.id);
        if (old) { clearInterval(old); convTimers.delete(socket.id); }

        try {
            const items = await getConversations({ pageId, token, current_count });
            log.info('conv', socket.id, 'conv:get fetched=%d', Array.isArray(items) ? items.length : -1);
            typeof ack === 'function' && ack({ ok: true, items });

            const timer = setInterval(async () => {
                try {
                    const incoming = await getConversations({ pageId, token, current_count });
                    socket.emit('conv:patch', { pageId, type: 'upsert', items: incoming });
                    log.debug('conv', socket.id, 'conv:poll tick upsert=%d', Array.isArray(incoming) ? incoming.length : -1);
                } catch (e) {
                    log.warn('conv', socket.id, 'conv:poll error=%s', e?.message || e);
                }
            }, POLL_INTERVAL_MS);

            convTimers.set(socket.id, timer);
            log.info('conv', socket.id, 'conv:poll started every %dms', POLL_INTERVAL_MS);
        } catch (e) {
            log.error('conv', socket.id, 'conv:get error=%s', e?.message || e);
            typeof ack === 'function' && ack({ ok: false, error: e.message });
        }
    });

    socket.on('conv:loadMore', async (params, ack) => {
        const { pageId, token, current_count } = params || {};
        log.info('conv', socket.id, 'conv:loadMore pageId=%s current_count=%s', pageId, current_count);
        if (!pageId || !token || !current_count) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' });
        }
        try {
            const items = await getConversations({ pageId, token, current_count });
            log.info('conv', socket.id, 'conv:loadMore fetched=%d', Array.isArray(items) ? items.length : -1);
            typeof ack === 'function' && ack({ ok: true, items });
            socket.emit('conv:patch', { pageId, type: 'upsert', items });

            // restart poll theo current_count mới
            const old = convTimers.get(socket.id);
            if (old) { clearInterval(old); convTimers.delete(socket.id); }

            const timer = setInterval(async () => {
                try {
                    const incoming = await getConversations({ pageId, token, current_count });
                    socket.emit('conv:patch', { pageId, type: 'upsert', items: incoming });
                    log.debug('conv', socket.id, 'conv:poll(loadMore) tick upsert=%d', Array.isArray(incoming) ? incoming.length : -1);
                } catch (e) {
                    log.warn('conv', socket.id, 'conv:poll(loadMore) error=%s', e?.message || e);
                }
            }, POLL_INTERVAL_MS);

            convTimers.set(socket.id, timer);
            log.info('conv', socket.id, 'conv:poll restarted every %dms', POLL_INTERVAL_MS);
        } catch (e) {
            log.error('conv', socket.id, 'conv:loadMore error=%s', e?.message || e);
            typeof ack === 'function' && ack({ ok: false, error: e.message });
        }
    });

    socket.on('conv:search', async (params, ack) => {
        const { pageId, token, q } = params || {};
        log.info('conv', socket.id, 'conv:search pageId=%s q=%s', pageId, q);
        if (!pageId || !token || !q) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' });
        }
        try {
            const items = await getConversationsSearch({ pageId, token, q });
            log.info('conv', socket.id, 'conv:search results=%d', Array.isArray(items) ? items.length : -1);
            typeof ack === 'function' && ack({ ok: true, items });
        } catch (e) {
            log.error('conv', socket.id, 'conv:search error=%s', e?.message || e);
            typeof ack === 'function' && ack({ ok: false, error: e.message });
        }
    });

    // ===== Messages =====
    socket.on('msg:get', async (params, ack) => {
        // console.log(params, ack);

        const { pageId, token, conversationId, customerId } = params || {};
        let { count } = params || {};
        count = Number.isFinite(Number(count)) ? Number(count) : 0;
        log.info('msg', socket.id, 'msg:get pageId=%s convo=%s customerId=%s count=%s', pageId, conversationId, customerId, count);

        if (!pageId || !token || !conversationId) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing pageId/token/conversationId' });
        }
        try {
            const convoKey = extractConvoKey(conversationId);
            const items = await getMessages({ pageId, token, conversationId: convoKey, customerId, count });
            log.info('msg', socket.id, 'msg:get fetched=%d', Array.isArray(items) ? items.length : -1);
            return typeof ack === 'function' && ack({ ok: true, items });
        } catch (e) {
            log.error('msg', socket.id, 'msg:get error=%s', e?.message || e);
            return typeof ack === 'function' && ack({ ok: false, error: e.message });
        }
    });

    socket.on('msg:watchStart', async (params, ack) => {
        const { pageId, token, conversationId, customerId, intervalMs } = params || {};
        let { count } = params || {};
        count = Number.isFinite(Number(count)) ? Number(count) : 0; // 0 = từ đầu
        const convoKey = extractConvoKey(conversationId);
        const key = watcherKey(socket.id, pageId, convoKey);
        log.info('msg', socket.id, 'watchStart pageId=%s convo=%s (key=%s) cust=%s count=%s interval=%s', pageId, convoKey, key, customerId, count, intervalMs);

        if (!pageId || !token || !conversationId) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' });
        }

        const old = msgWatchers.get(key);
        if (old) { clearInterval(old); msgWatchers.delete(key); }
        log.info('msg', socket.id, 'watcher reset key=%s', key);

        try {
            const initial = await getMessages({ pageId, token, conversationId: convoKey, customerId, count });
            log.info('msg', socket.id, 'watchStart initial fetched=%d', Array.isArray(initial) ? initial.length : -1);

            typeof ack === 'function' && ack({ ok: true });

            const timer = setInterval(async () => {
                try {
                    const incoming = await getMessages({ pageId, token, conversationId: convoKey, customerId, count: 0 });
                    for (const m of incoming) {
                        socket.emit('msg:new', m);
                        
                        // Chỉ emit conv:patch nếu có customer data đầy đủ
                        if (m?.customers && Array.isArray(m.customers) && m.customers.length > 0) {
                            socket.emit('conv:patch', {
                                pageId,
                                type: 'upsert',
                                items: [{
                                    id: `${pageId}_${convoKey}`,
                                    type: 'INBOX',
                                    snippet: (m?.original_message || m?.message || '').toString().slice(0, 100),
                                    updated_at: m?.inserted_at || new Date().toISOString(),
                                    customers: m.customers, // Thêm customer data
                                }],
                            });
                        }
                    }
                    log.debug('msg', socket.id, 'poll tick incoming=%d key=%s', Array.isArray(incoming) ? incoming.length : -1, key);
                } catch (e) {
                    log.warn('msg', socket.id, 'poll error key=%s err=%s', key, e?.message || e);
                }
            }, Math.max(1000, Number(intervalMs || 2500)));

            msgWatchers.set(key, timer);
            log.info('msg', socket.id, 'watcher started key=%s interval=%d', key, Math.max(1000, Number(intervalMs || 2500)));
        } catch (e) {
            log.error('msg', socket.id, 'watchStart error=%s', e?.message || e);
            typeof ack === 'function' && ack({ ok: false, error: e.message });
        }
    });

    socket.on('msg:watchStop', (params, ack) => {
        const { pageId, conversationId } = params || {};
        if (!pageId || !conversationId) {
            return typeof ack === 'function' && ack({ ok: false, error: 'missing params' });
        }
        const convoKey = extractConvoKey(conversationId);
        const key = watcherKey(socket.id, pageId, convoKey);
        const timer = msgWatchers.get(key);
        if (timer) clearInterval(timer);
        msgWatchers.delete(key);
        log.info('msg', socket.id, 'watcher stopped key=%s', key);
        typeof ack === 'function' && ack({ ok: true, stopped: true });
    });
}
