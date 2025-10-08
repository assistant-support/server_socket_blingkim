// events/index.js
// ------------------------------------------------------------
// Tập hợp và đăng ký các nhóm sự kiện cho 1 socket kết nối.
// ------------------------------------------------------------

import { registerConversationEvents } from './conversations.handler.js';

export function registerEventHandlers(io, socket) {
    // Có thể đăng ký thêm các nhóm khác tại đây (notifications, typing, v.v.)
    registerConversationEvents(io, socket);
}
