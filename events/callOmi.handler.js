// events/callOmi.handler.js
// Các event chính:
// - call:init       -> Khởi tạo OMICall SDK (nếu chưa có instance) + đăng ký agent
// - call:register   -> Đăng ký tài khoản SIP (agent_id, extension, password)
// - call:make       -> Thực hiện cuộc gọi ra (emit lại 'call:status' theo tiến trình)
// - call:end        -> Kết thúc cuộc gọi hiện tại
// - call:status     -> Server đẩy realtime trạng thái cuộc gọi (ringing, answered, ended, failed)
// - call:reconnect  -> Thử kết nối lại OMICall SDK nếu mất kết nối (sau reload hoặc reconnect socket)
// ------------------------------------------------------------
