// events/index.js
// ------------------------------------------------------------
// Tập hợp và đăng ký các nhóm sự kiện cho 1 socket kết nối.
// ------------------------------------------------------------

import { registerConversationEvents } from './conversations.handler.js';
import { registerCallEvents } from './call.handler.js';

export function registerEventHandlers(io, socket) {
    // Đăng ký conversation events
    registerConversationEvents(io, socket);
    
    // Đăng ký call events
    registerCallEvents(io, socket);
}
