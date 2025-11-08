// utils/pancake.js
// Gom URL builder + fetch JSON Pancake

// Node >=18 có global fetch

function buildConvListURL({ pageId, token, count }) {
    const base = `https://pancake.vn/api/v1/pages/${pageId}/conversations`;
    const qs = new URLSearchParams({
        unread_first: 'true',
        mode: 'NONE',
        tags: '"ALL"',
        'except_tags[]': '',
        access_token: token,
        cursor_mode: 'true',
        from_platform: 'web',
    });
    if (count && Number(count) > 0) {
        qs.set('current_count', String(count));
    }
    return `${base}?${qs.toString()}`;
}

function buildMessagesURL({ pageId, conversationId, customerId, token, count = 0 }) {
    const cid = String(conversationId);
    let conversationPath;
    
    // ✅ Kiểm tra prefix để xử lý đúng format cho từng platform
    if (cid.startsWith('ttm_') || cid.startsWith('pzl_') || cid.startsWith('igo_')) {
        // TikTok, Zalo, Instagram Official: sử dụng conversation ID đầy đủ
        // Ví dụ: "pzl_12345_67890" → giữ nguyên "pzl_12345_67890"
        conversationPath = cid;
    } else if (cid.includes('_') && cid.split('_').length >= 2) {
        // Facebook: đã có format "pageId_customerId" → giữ nguyên
        // Ví dụ: "140918602777989_123456789" → giữ nguyên
        conversationPath = cid;
    } else {
        // Facebook: chỉ có customerId → ghép với pageId
        // Ví dụ: "123456789" → "140918602777989_123456789"
        conversationPath = `${pageId}_${cid}`;
    }
    
    const base = `https://pancake.vn/api/v1/pages/${pageId}/conversations/${conversationPath}/messages`;
    const qs = new URLSearchParams({
        access_token: token,
        is_new_api: 'true',
        customer_id: customerId || '',
    });
    if (Number(count) > 0) qs.set('current_count', String(count));
    return `${base}?${qs.toString()}`;
}

function buildSearchURL({ pageId, q, token }) {
    const base = `https://pancake.vn/api/v1/pages/${pageId}/conversations/search`;
    const qs = new URLSearchParams({
        q,
        access_token: token,
        cursor_mode: 'true',
    });
    return `${base}?${qs.toString()}`;
}

async function getJson(url) {
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Pancake ${r.status} ${text}`.trim());
    }
    return r.json();
}

export async function getConversations({ pageId, token, current_count }) {
    const url = buildConvListURL({ pageId, token, count: current_count });
    const data = await getJson(url);
    return Array.isArray(data?.conversations) ? data.conversations : [];
}

export async function getConversationsSearch({ pageId, token, q }) {
    const url = buildSearchURL({ pageId, token, q });
    const data = await getJson(url);
    return Array.isArray(data?.conversations) ? data.conversations : [];
}

export async function getMessages({ pageId, conversationId, customerId, token, count }) {
    const url = buildMessagesURL({ pageId, conversationId, customerId, token, count });
    const data = await getJson(url);
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.messages) ? data.messages : [];
}
