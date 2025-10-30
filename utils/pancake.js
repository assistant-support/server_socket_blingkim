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
    // Đặc biệt xử lý cho TikTok: sử dụng conversation ID đầy đủ
    let conversationPath;
    if (conversationId.startsWith('ttm_')) {
        conversationPath = conversationId; // TikTok: sử dụng conversation ID đầy đủ
    } else {
        conversationPath = `${pageId}_${conversationId}`; // Facebook/Instagram: ghép pageId + conversationId
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
