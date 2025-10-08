// events/index.js
import { registerConversationEvents } from './conversations.handler.js'

export function registerEventHandlers(io, socket) {
    registerConversationEvents(io, socket)
    // có thể đăng ký thêm handler khác tại đây (notifications, typing, vv.)
}
