// events/zalo.handler.js
// ------------------------------------------------------------
// Zalo QR event handlers for Socket.IO server
// Handles Zalo QR code generation using zca-js
// ------------------------------------------------------------

import { Zalo as ZCA } from 'zca-js';
import { log } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { existsSync } from 'fs';
import { PORT } from '../config/environment.js';
import crypto from 'crypto';
import connectDB from '../config/connectDB.js';
import { ZaloAccount } from '../models/zalo-account.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QR_DIR = path.join(__dirname, '../public/ZaloQR');
const NEW_QR_DIR = path.join(__dirname, '../public/_zalo_qr');

// Đảm bảo thư mục tồn tại
if (!fs.existsSync(QR_DIR)) {
    fs.mkdirSync(QR_DIR, { recursive: true });
}
if (!fs.existsSync(NEW_QR_DIR)) {
    fs.mkdirSync(NEW_QR_DIR, { recursive: true });
}

// Helper function để tạo UUID
function newId() {
    return crypto.randomUUID();
}

// Helper function để đảm bảo thư mục QR tồn tại
function ensureQrDir() {
    if (!existsSync(NEW_QR_DIR)) {
        fs.mkdirSync(NEW_QR_DIR, { recursive: true });
    }
    return NEW_QR_DIR;
}

// Helper function để đảm bảo kết nối MongoDB
async function ensureMongo() {
    try {
        await connectDB();
    } catch (err) {
        log.error('zalo', null, 'MongoDB connection error: %s', err?.message);
        throw err;
    }
}

// Helper function để lấy cookie JSON từ API
async function extractCookieJSON(api) {
    try {
        const jar = await api.getCookie();
        if (jar && typeof jar.toJSON === 'function') return jar.toJSON();
        return jar || null;
    } catch {
        return null;
    }
}

// Helper function để chuẩn hóa profile
function normalizeProfile(ownId, info) {
    const profileData = info?.profile || info;
    const phone = profileData?.phoneNumber ? String(profileData.phoneNumber) : (profileData?.phone ? String(profileData.phone) : '');
    return {
        zaloId: String(ownId),
        displayName: profileData?.displayName || profileData?.zaloName || profileData?.name || String(ownId),
        avatar: profileData?.avatar || profileData?.avatarUrl || '',
        phoneMasked: phone
            ? phone.replace(
                /^(\+?\d{0,3})?(\d{3})(\d{3})(\d{0,3})$/,
                (_, $cc, a, b, c) => `${$cc || ''}${a}***${c ? '***' + c : '***'}`
            )
            : '',
        phone: phone || ''
    };
}

// Helper function để xóa tất cả file QR trong thư mục _zalo_qr
async function cleanupAllQRFiles() {
    try {
        const files = await fs.promises.readdir(NEW_QR_DIR);
        const pngFiles = files.filter(file => file.endsWith('.png'));
        
        if (pngFiles.length === 0) {
            log.info('zalo', null, 'No QR files to cleanup');
            return;
        }

        let deletedCount = 0;
        for (const file of pngFiles) {
            try {
                const filePath = path.join(NEW_QR_DIR, file);
                await fs.promises.unlink(filePath);
                deletedCount++;
            } catch (err) {
                log.warn('zalo', null, 'Failed to delete QR file %s: %s', file, err?.message);
            }
        }

        log.info('zalo', null, 'Cleaned up %d QR files from _zalo_qr directory', deletedCount);
        console.log('[Zalo Handler] 🗑️ Cleaned up %d QR files', deletedCount);
    } catch (err) {
        log.error('zalo', null, 'Error cleaning up QR files: %s', err?.message);
        console.error('[Zalo Handler] ❌ Error cleaning up QR files:', err);
    }
}

// Map lưu trữ các phiên QR: loginId -> { status, qrPath, zaloInstance, loginQrPromise, createdAt, socketId }
const qrSessions = new Map();
// Map lưu socketId -> loginId để dễ dàng tìm session theo socket
const socketToLoginId = new Map();

// Runtime Map để lưu API instances đã login (accountKey -> { api, startedAt })
// Sử dụng để tái sử dụng API instance thay vì login lại mỗi lần
const runtimeApiMap = new Map();

// Helper function để set API vào runtime
function setRuntimeApi(accountKey, api) {
    if (accountKey && api) {
        runtimeApiMap.set(accountKey, { api, startedAt: Date.now() });
        log.info('zalo', null, 'Saved API to runtime for account: %s', accountKey);
    }
}

// Helper function để remove API khỏi runtime
function removeRuntimeApi(accountKey) {
    if (accountKey) {
        runtimeApiMap.delete(accountKey);
        log.info('zalo', null, 'Removed API from runtime for account: %s', accountKey);
    }
}

let zaloInstance = null;
let zaloAPI = null;
let isInitializing = false; // Lock để tránh khởi tạo đồng thời
let initPromise = null; // Promise đang chờ khởi tạo

// Khởi tạo Zalo instance
async function initializeZalo(forceNew = false) {
    // Nếu đang khởi tạo, đợi promise hiện tại
    if (isInitializing && initPromise) {
        log.info('zalo', null, 'Zalo is already initializing, waiting...');
        return await initPromise;
    }

    // Nếu đã có instance và không forceNew, trả về ngay
    if (!forceNew && zaloInstance && zaloAPI) {
        return { zalo: zaloInstance, api: zaloAPI };
    }

    // Set lock và tạo promise
    isInitializing = true;
    initPromise = (async () => {
        try {
            log.info('zalo', null, 'Initializing Zalo instance (forceNew: %s)...', forceNew);
            
            // Nếu forceNew, reset instance cũ
            if (forceNew) {
                zaloInstance = null;
                zaloAPI = null;
            }
            
            zaloInstance = new ZCA({
                selfListen: false,
                checkUpdate: true,
                logging: false
            });

            const qrPath = path.join(QR_DIR, 'qr.png');
            // Xóa QR cũ nếu tồn tại và forceNew
            if (forceNew && fs.existsSync(qrPath)) {
                try {
                    fs.unlinkSync(qrPath);
                    log.info('zalo', null, 'Deleted old QR file');
                } catch (err) {
                    log.warn('zalo', null, 'Failed to delete old QR: %s', err?.message);
                }
            }
            
            zaloAPI = await zaloInstance.loginQR({
                userAgent: '',
                qrPath: qrPath
            });

            zaloAPI.listener.start();
            
            log.info('zalo', null, 'Zalo instance initialized successfully');
            return { zalo: zaloInstance, api: zaloAPI };
        } catch (error) {
            log.error('zalo', null, 'Failed to initialize Zalo: %s', error?.message || error);
            // Reset lock khi lỗi
            isInitializing = false;
            initPromise = null;
            throw error;
        } finally {
            // Reset lock sau khi hoàn thành
            isInitializing = false;
            initPromise = null;
        }
    })();

    return await initPromise;
}

// Lock để tránh nhiều request đồng thời
let isProcessingQR = false;
let qrRequestQueue = [];

export function registerZaloEvents(io, socket) {
    // Handler: zalo:qr:start - tạo QR và emit event thay vì callback
    socket.on('zalo:qr:start', async (data = {}) => {
        const userAgent = data.userAgent || socket.handshake.headers['user-agent'] || 'Mozilla/5.0';

        try {
            // Dừng session cũ nếu có (một socket chỉ nên có 1 QR session tại một thời điểm)
            const oldLoginId = socketToLoginId.get(socket.id);
            if (oldLoginId) {
                log.info('zalo', socket.id, 'Stopping old QR session: %s', oldLoginId);
                const oldSession = qrSessions.get(oldLoginId);
                if (oldSession && oldSession.zaloInstance) {
                    try {
                        // Cleanup old session
                        if (oldSession.loginQrPromise) {
                            // Không thể cancel promise, nhưng có thể ignore result
                        }
                    } catch (e) {
                        log.warn('zalo', socket.id, 'Error cleaning up old session: %s', e?.message);
                    }
                }
                qrSessions.delete(oldLoginId);
                socketToLoginId.delete(socket.id);
            }

            const loginId = newId();
            const dir = ensureQrDir();
            const qrPath = path.join(dir, `${loginId}.png`);

            // Trả về full URL từ socket server
            let socketHost = process.env.SOCKET_HOST || 'http://localhost';
            if (!socketHost.match(/^https?:\/\//)) {
                socketHost = `https://${socketHost}`;
            }
            const hostHasPort = socketHost.match(/:\d+$/);
            const isHttps = socketHost.startsWith('https://');
            const qrPublicUrl = hostHasPort 
                ? `${socketHost}/_zalo_qr/${loginId}.png`
                : isHttps
                    ? `${socketHost}/_zalo_qr/${loginId}.png`
                    : `${socketHost}:${PORT}/_zalo_qr/${loginId}.png`;

            // Lưu session với socketId
            qrSessions.set(loginId, { 
                status: 'waiting', 
                qrPath, 
                createdAt: Date.now(),
                socketId: socket.id
            });
            socketToLoginId.set(socket.id, loginId);

            // Gọi loginQR() và đợi file QR được tạo
            let loginQrPromise = null;
            let zaloInstance = null;
            try {
                // Tắt logging để tránh các lỗi cookie domain không cần thiết
                zaloInstance = new ZCA({ selfListen: false, checkUpdate: true, logging: false });

                qrSessions.set(loginId, { 
                    status: 'waiting', 
                    qrPath, 
                    createdAt: Date.now(),
                    zaloInstance,
                });

                log.info('zalo', socket.id, 'Calling loginQR with qrPath: %s', qrPath);
                loginQrPromise = zaloInstance.loginQR({ userAgent, qrPath });
                log.info('zalo', socket.id, 'loginQR called, promise created');

                const session = qrSessions.get(loginId);
                if (session) {
                    session.loginQrPromise = loginQrPromise;
                    qrSessions.set(loginId, session);
                }

                // Xử lý khi đăng nhập thành công (bất đồng bộ)
                loginQrPromise.then(async (api) => {
                    try {
                        log.info('zalo', socket.id, 'QR login successful, fetching account info...');
                        console.log('[Zalo Handler] ✅ QR login successful, calling fetchAccountInfo()...');
                        
                        // Lấy ownId trước
                        const ownId = String(await api.getOwnId());
                        console.log('[Zalo Handler] 📋 OwnId:', ownId);
                        
                        // Sử dụng phương thức fetchAccountInfo() để lấy thông tin tài khoản
                        let accountInfo = null;
                        try {
                            accountInfo = await api.fetchAccountInfo();
                            console.log('[Zalo Handler] 📥 fetchAccountInfo() response:', JSON.stringify(accountInfo, null, 2));
                            log.info('zalo', socket.id, 'Account info fetched successfully');
                        } catch (fetchError) {
                            console.error('[Zalo Handler] ❌ Error calling fetchAccountInfo():', fetchError);
                            log.error('zalo', socket.id, 'Failed to fetch account info: %s', fetchError?.message);
                            // Tiếp tục với accountInfo = null, sẽ dùng ownId làm fallback
                        }
                        
                        // Chuẩn hóa thông tin profile từ response của fetchAccountInfo()
                        // Response có cấu trúc: { profile: { displayName, avatar, phoneNumber, ... } }
                        // Cần truy cập accountInfo.profile để lấy thông tin
                        const profile = normalizeProfile(ownId, accountInfo);

                        console.log('[Zalo Handler] 👤 Normalized Profile:', profile);

                        // Lấy thông tin device và cookies để lưu vào DB
                        const ctx = api.getContext();
                        const imei = ctx?.imei || 'unknown_imei';
                        const ua = ctx?.userAgent || userAgent || 'Mozilla/5.0';
                        const cookieJSON = await extractCookieJSON(api);

                        // Lưu tài khoản vào MongoDB
                        try {
                            await ensureMongo();
                            
                            const device = {
                                imei,
                                userAgent: ua,
                                deviceName: 'bot-web'
                            };

                            await ZaloAccount.upsertFromLoginResult({
                                accountKey: ownId,
                                profile: {
                                    zaloId: profile.zaloId,
                                    displayName: profile.displayName,
                                    avatar: profile.avatar,
                                    phoneMasked: profile.phoneMasked
                                },
                                device,
                                cookies: cookieJSON,
                                loginMethod: 'qr'
                            });

                            log.info('zalo', socket.id, 'Account saved to MongoDB: %s', ownId);
                            console.log('[Zalo Handler] 💾 Account saved to MongoDB successfully');
                            
                            // Lưu API instance vào runtime Map để tái sử dụng
                            setRuntimeApi(ownId, api);
                        } catch (dbError) {
                            log.error('zalo', socket.id, 'Failed to save account to DB: %s', dbError?.message);
                            console.error('[Zalo Handler] ❌ Failed to save account to DB:', dbError);
                            // Tiếp tục emit event dù có lỗi DB
                        }
                        
                        // Lưu API instance vào runtime Map ngay cả khi có lỗi DB
                        setRuntimeApi(ownId, api);

                        // Cập nhật session và cleanup
                        const currentSession = qrSessions.get(loginId);
                        if (currentSession) {
                            currentSession.status = 'success';
                            currentSession.accountKey = ownId;
                            currentSession.profile = profile;
                            currentSession.api = api; // Lưu api instance để có thể dùng sau
                            qrSessions.set(loginId, currentSession);
                            
                            // Cleanup: xóa mapping socketId -> loginId vì đã hoàn thành
                            socketToLoginId.delete(socket.id);
                        }

                        // Emit event về client với thông tin đăng nhập thành công
                        // Chỉ emit nếu socket vẫn còn kết nối
                        const emitData = {
                            loginId,
                            profile: {
                                zaloId: profile.zaloId,
                                displayName: profile.displayName,
                                avatar: profile.avatar,
                                phone: profile.phone,
                                phoneMasked: profile.phoneMasked
                            }
                        };

                        console.log('[Zalo Handler] 📤 Emitting login success event:', emitData);

                        if (socket.connected) {
                            socket.emit('zalo:qr:loginSuccess', emitData);
                            log.info('zalo', socket.id, 'Emitted login success event for loginId: %s', loginId);
                            console.log('[Zalo Handler] ✅ Login success event emitted successfully');
                            
                            // Xóa tất cả file QR trong thư mục _zalo_qr sau khi đăng nhập thành công
                            await cleanupAllQRFiles();
                        } else {
                            log.warn('zalo', socket.id, 'Socket disconnected, cannot emit login success event for loginId: %s', loginId);
                            console.warn('[Zalo Handler] ⚠️ Socket disconnected, cannot emit login success event');
                        }
                    } catch (err) {
                        log.error('zalo', socket.id, 'Error fetching account info after login: %s', err?.message);
                        console.error('[Zalo Handler] ❌ Error in login success handler:', err);
                    }
                }).catch((err) => {
                    log.error('zalo', socket.id, 'QR login promise rejected: %s', err?.message);
                    console.error('[Zalo Handler] ❌ QR login promise rejected:', err);
                });

                // Đợi file QR được tạo
                log.info('zalo', socket.id, 'Waiting for QR file at: %s', qrPath);
                let retries = 50; // 50 * 200ms = 10 giây
                let fileFound = false;

                while (retries > 0 && !fileFound) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                    retries--;
                    fileFound = existsSync(qrPath);

                    // Log mỗi 2 giây (10 retries)
                    if (retries % 10 === 0) {
                        log.info('zalo', socket.id, 'Still waiting for QR file... (retries left: %d, exists: %s)', retries, fileFound);
                    }

                    if (fileFound) {
                        log.info('zalo', socket.id, 'QR file created after %d retries', 50 - retries);
                        break;
                    }
                }

                if (!fileFound) {
                    // Kiểm tra xem có file nào trong thư mục không
                    try {
                        const dir = path.dirname(qrPath);
                        const files = await fs.promises.readdir(dir).catch(() => []);
                        log.error('zalo', socket.id, 'QR file not created after 10s. Expected: %s, Files in dir: %o', qrPath, files);
                    } catch (e) {
                        log.error('zalo', socket.id, 'QR file not created after 10s. Error checking dir: %s', e.message);
                    }
                    qrSessions.set(loginId, { status: 'failed', qrPath, error: 'QR file not created', socketId: socket.id });
                    if (socket.connected) {
                        socket.emit('zalo:qr:error', { loginId, error: 'QR file not created' });
                    }
                    return;
                }

                const stats = await fs.promises.stat(qrPath).catch(() => null);
                if (!stats || stats.size === 0) {
                    log.error('zalo', socket.id, 'QR file is empty');
                    qrSessions.set(loginId, { status: 'failed', qrPath, error: 'QR file is empty', socketId: socket.id });
                    if (socket.connected) {
                        socket.emit('zalo:qr:error', { loginId, error: 'QR file is empty' });
                    }
                    return;
                }

                log.info('zalo', socket.id, 'QR file created successfully (size: %d bytes)', stats.size);
                log.info('zalo', socket.id, 'QR public URL: %s', qrPublicUrl);

                // Emit event zalo:qr thay vì callback
                if (socket.connected) {
                    socket.emit('zalo:qr', { ok: true, loginId, qrPublicUrl });
                    log.info('zalo', socket.id, 'Emitted zalo:qr event with loginId: %s', loginId);
                } else {
                    log.warn('zalo', socket.id, 'Socket disconnected, cannot emit QR');
                }
            } catch (err) {
                log.error('zalo', socket.id, 'loginQR error=%s', err.message);
                qrSessions.set(loginId, { status: 'failed', qrPath, error: err?.message || 'QR login failed', socketId: socket.id });
                if (socket.connected) {
                    socket.emit('zalo:qr:error', { loginId, error: err?.message || 'QR login failed' });
                }
                return;
            }
        } catch (err) {
            log.error('zalo', socket.id, 'zalo:qr:start error=%s', err.message);
            if (socket.connected) {
                socket.emit('zalo:qr:error', { error: err?.message || 'Failed to start QR login' });
            }
        }
    });

    // Handler: zalo:qr:stop - dừng QR session
    socket.on('zalo:qr:stop', async (data = {}) => {
        const loginId = data.loginId || socketToLoginId.get(socket.id);
        
        if (!loginId) {
            log.warn('zalo', socket.id, 'No QR session found to stop');
            return;
        }

        await stopQRSession(socket.id, loginId);
    });

    // Helper function để dừng QR session
    async function stopQRSession(socketId, loginId) {
        log.info('zalo', socketId, 'Stopping QR session: %s', loginId);
        
        const session = qrSessions.get(loginId);
        if (session) {
            // Cleanup session
            if (session.zaloInstance) {
                try {
                    // Có thể cleanup zaloInstance nếu cần
                } catch (e) {
                    log.warn('zalo', socketId, 'Error cleaning up zaloInstance: %s', e?.message);
                }
            }
            
            // Xóa file QR nếu tồn tại
            if (session.qrPath && existsSync(session.qrPath)) {
                try {
                    await fs.promises.unlink(session.qrPath);
                    log.info('zalo', socketId, 'Deleted QR file: %s', session.qrPath);
                } catch (e) {
                    log.warn('zalo', socketId, 'Failed to delete QR file: %s', e?.message);
                }
            }
            
            qrSessions.delete(loginId);
        }
        
        socketToLoginId.delete(socketId);
        log.info('zalo', socketId, 'QR session stopped: %s', loginId);
    }

    // Cleanup khi socket disconnect
    socket.on('disconnect', async () => {
        const loginId = socketToLoginId.get(socket.id);
        if (loginId) {
            log.info('zalo', socket.id, 'Socket disconnected, cleaning up QR session: %s', loginId);
            await stopQRSession(socket.id, loginId);
        }
    });

    // Yêu cầu tạo QR code (handler cũ, giữ lại để tương thích)
    socket.on('zalo:getQR', async (options = {}) => {
        // Nếu đang xử lý, thêm vào queue hoặc từ chối
        if (isProcessingQR) {
            log.warn('zalo', socket.id, 'QR request already processing, queuing...');
            socket.emit('zalo:qrError', {
                success: false,
                message: 'Đang xử lý request QR khác, vui lòng đợi...'
            });
            return;
        }

        isProcessingQR = true;
        
        try {
            const forceNew = options.forceNew || false;
            log.info('zalo', socket.id, 'Requesting Zalo QR code (forceNew: %s)', forceNew);
            
            // Kiểm tra xem QR đã tồn tại chưa (nếu không forceNew)
            const qrPath = path.join(QR_DIR, 'qr.png');
            if (!forceNew && fs.existsSync(qrPath)) {
                const stats = fs.statSync(qrPath);
                if (stats.size > 0) {
                    log.info('zalo', socket.id, 'QR file already exists, using existing file');
                    const qrUrl = `/ZaloQR/qr.png?t=${Date.now()}`;
                    socket.emit('zalo:qrReady', {
                        success: true,
                        qrUrl: qrUrl,
                        timestamp: Date.now()
                    });
                    isProcessingQR = false;
                    return;
                }
            }
            
            // Khởi tạo Zalo nếu chưa có hoặc forceNew
            if (!zaloInstance || !zaloAPI || forceNew) {
                await initializeZalo(forceNew);
            }
            
            // Đợi file QR được tạo (tối đa 5 giây)
            let attempts = 0;
            const maxAttempts = 15; // Tăng thời gian đợi
            while (!fs.existsSync(qrPath) && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 500));
                attempts++;
            }

            if (!fs.existsSync(qrPath)) {
                // Thử tạo QR mới một lần nữa
                log.warn('zalo', socket.id, 'QR file not found, trying to create new one...');
                await initializeZalo(true);
                
                // Đợi lại
                attempts = 0;
                while (!fs.existsSync(qrPath) && attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    attempts++;
                }
                
                if (!fs.existsSync(qrPath)) {
                    throw new Error('QR code file không được tạo sau khi khởi tạo Zalo');
                }
            }

            // Kiểm tra file có hợp lệ không (size > 0)
            let stats;
            try {
                stats = fs.statSync(qrPath);
                if (stats.size === 0) {
                    log.warn('zalo', socket.id, 'QR file is empty, creating new one...');
                    await initializeZalo(true);
                    stats = fs.statSync(qrPath);
                }
            } catch (err) {
                log.error('zalo', socket.id, 'Failed to stat QR file: %s', err?.message);
                throw new Error('QR file không hợp lệ');
            }

            // Lấy QR code data (nếu API hỗ trợ)
            let qrData = null;
            try {
                qrData = await zaloAPI.getQR();
            } catch (err) {
                log.warn('zalo', socket.id, 'getQR() không khả dụng, chỉ dùng file: %s', err?.message);
            }
            
            // Tạo URL để truy cập QR với timestamp để tránh cache
            const qrUrl = `/ZaloQR/qr.png?t=${Date.now()}`;
            
            log.info('zalo', socket.id, 'QR code generated successfully at %s (size: %d bytes)', qrPath, stats.size);
            log.info('zalo', socket.id, 'QR URL: %s', qrUrl);
            
            socket.emit('zalo:qrReady', {
                success: true,
                qrUrl: qrUrl,
                qrData: qrData,
                timestamp: Date.now()
            });
        } catch (error) {
            log.error('zalo', socket.id, 'Failed to get QR: %s', error?.message || error);
            log.error('zalo', socket.id, 'Error stack: %s', error?.stack);
            
            // Xử lý lỗi cụ thể
            let errorMessage = 'Không thể tạo QR code';
            if (error?.message?.includes('Cannot get API login version')) {
                errorMessage = 'Lỗi kết nối đến API Zalo. Vui lòng thử lại sau hoặc kiểm tra kết nối mạng.';
            } else if (error?.message?.includes('Unexpected token')) {
                errorMessage = 'API Zalo trả về dữ liệu không hợp lệ. Có thể do rate limit hoặc API thay đổi.';
            } else if (error?.message) {
                errorMessage = error.message;
            }
            
            socket.emit('zalo:qrError', {
                success: false,
                message: errorMessage,
                error: error?.message
            });
        } finally {
            isProcessingQR = false;
        }
    });

    // Kiểm tra trạng thái kết nối Zalo
    socket.on('zalo:checkStatus', async () => {
        try {
            if (!zaloInstance || !zaloAPI) {
                socket.emit('zalo:status', {
                    connected: false,
                    message: 'Zalo chưa được khởi tạo'
                });
                return;
            }

            const qrPath = path.join(QR_DIR, 'qr.png');
            const hasQR = fs.existsSync(qrPath);
            
            socket.emit('zalo:status', {
                connected: hasQR,
                hasQR: hasQR,
                qrUrl: hasQR ? `/ZaloQR/qr.png?t=${Date.now()}` : null
            });
        } catch (error) {
            log.error('zalo', socket.id, 'Failed to check status: %s', error?.message || error);
            socket.emit('zalo:status', {
                connected: false,
                message: error?.message || 'Failed to check status'
            });
        }
    });

    // Cập nhật trạng thái tài khoản bằng getUserInfo
    socket.on('zalo:updateAccountStatus', async (data, ack) => {
        const safeAck = (response) => {
            if (typeof ack === 'function') {
                try {
                    ack(response);
                } catch (err) {
                    log.error('zalo', socket.id, 'Ack error: %s', err?.message);
                }
            } else {
                socket.emit('zalo:updateAccountStatus:response', response);
            }
        };

        try {
            await ensureMongo();
            
            const accounts = await ZaloAccount.find({})
                .select('profile accountKey status device session')
                .lean();

            const results = [];
            
            for (const acc of accounts) {
                try {
                    let api = null;
                    let status = acc.status || 'disconnected';
                    let error = null;

                    // Ưu tiên 1: Thử lấy API từ runtime Map (nếu đã login và đang chạy)
                    const runtimeItem = runtimeApiMap.get(acc.accountKey);
                    if (runtimeItem && runtimeItem.api) {
                        api = runtimeItem.api;
                        log.info('zalo', socket.id, 'Using existing API from runtime for account: %s', acc.accountKey);
                        console.log('[Zalo Handler] ✅ Using existing API from runtime');
                    } else {
                        // Ưu tiên 2: Thử login lại bằng cookies
                        try {
                            if (acc.session?.cookies && acc.device?.imei && acc.device?.userAgent) {
                                const zaloInstance = new ZCA({ selfListen: false, checkUpdate: true, logging: false });
                                api = await zaloInstance.login({
                                    cookie: acc.session.cookies,
                                    imei: acc.device.imei,
                                    userAgent: acc.device.userAgent
                                });
                                if (api?.listener?.start) {
                                    api.listener.start();
                                }
                                // Lưu vào runtime Map để tái sử dụng
                                setRuntimeApi(acc.accountKey, api);
                                log.info('zalo', socket.id, 'Logged in by cookies and saved to runtime for account: %s', acc.accountKey);
                                console.log('[Zalo Handler] ✅ Logged in by cookies and saved to runtime');
                            } else {
                                throw new Error('Missing cookies or device info');
                            }
                        } catch (loginErr) {
                            error = loginErr?.message || 'Cannot login';
                            status = 'disconnected';
                            
                            // Chỉ cập nhật status trong DB nếu status hiện tại không phải disconnected
                            const currentStatus = acc.status || 'disconnected';
                            const shouldUpdate = status !== currentStatus;
                            
                            if (shouldUpdate) {
                                try {
                                    await ZaloAccount.updateOne(
                                        { accountKey: acc.accountKey },
                                        { 
                                            $set: { 
                                                status: 'disconnected',
                                                'session.lastActiveAt': new Date()
                                            } 
                                        }
                                    );
                                    log.warn('zalo', socket.id, 'Updated status to disconnected (login failed) for account: %s (%s → disconnected)', 
                                        acc.accountKey, currentStatus);
                                } catch (dbErr) {
                                    log.error('zalo', socket.id, 'Failed to update status in DB: %s', dbErr?.message);
                                }
                            }
                            
                            results.push({
                                accountKey: acc.accountKey,
                                status: 'disconnected',
                                error,
                                updated: shouldUpdate
                            });
                            continue;
                        }
                    }

                    // Gọi getUserInfo với ownId để kiểm tra trạng thái
                    try {
                        const ownId = acc.accountKey;
                        const userInfoResponse = await api.getUserInfo(ownId);
                        
                        console.log('[Zalo Handler] 📥 getUserInfo response for', ownId, ':', JSON.stringify(userInfoResponse, null, 2));
                        
                        if (userInfoResponse && typeof userInfoResponse === 'object') {
                            // Kiểm tra cấu trúc hợp lệ trước
                            if (userInfoResponse.phonebook_version !== undefined || 
                                userInfoResponse.changed_profiles !== undefined || 
                                userInfoResponse.unchanged_profiles !== undefined) {
                                
                                // Tìm profile của ownId
                                let profile = null;
                                
                                if (userInfoResponse.changed_profiles && typeof userInfoResponse.changed_profiles === 'object') {
                                    profile = userInfoResponse.changed_profiles[ownId] || 
                                             Object.values(userInfoResponse.changed_profiles)[0];
                                }
                                
                                if (!profile && userInfoResponse.unchanged_profiles && typeof userInfoResponse.unchanged_profiles === 'object') {
                                    profile = userInfoResponse.unchanged_profiles[ownId] || 
                                             Object.values(userInfoResponse.unchanged_profiles)[0];
                                }
                                
                                // Xác định trạng thái dựa trên profile (ưu tiên isActive/isActiveWeb)
                                if (profile && typeof profile === 'object') {
                                    // Ưu tiên 1: Kiểm tra isActiveWeb hoặc isActive
                                    if (profile.isActiveWeb === 1 || profile.isActive === 1) {
                                        status = 'active';
                                        log.info('zalo', socket.id, 'Account is active (isActiveWeb=%s, isActive=%s) for: %s', 
                                            profile.isActiveWeb, profile.isActive, ownId);
                                    }
                                    // Ưu tiên 2: Kiểm tra lastActionTime
                                    else if (profile.lastActionTime) {
                                        const lastActionTime = new Date(profile.lastActionTime);
                                        const now = new Date();
                                        const diffMinutes = (now - lastActionTime) / (1000 * 60);
                                        
                                        if (diffMinutes < 5) {
                                            status = 'active';
                                            log.info('zalo', socket.id, 'Account is active (lastActionTime < 5min, diff=%.2f min) for: %s', diffMinutes, ownId);
                                        } else {
                                            status = 'disconnected';
                                            log.warn('zalo', socket.id, 'Account is disconnected (lastActionTime > 5min, diff=%.2f min) for: %s', diffMinutes, ownId);
                                        }
                                    }
                                    // Ưu tiên 3: Nếu có profile hợp lệ nhưng không có isActive/lastActionTime → active
                                    else {
                                        status = 'active';
                                        log.info('zalo', socket.id, 'Account is active (has valid profile but no isActive/lastActionTime) for: %s', ownId);
                                    }
                                } else {
                                    // Không tìm thấy profile nhưng response có cấu trúc hợp lệ → active
                                    status = 'active';
                                    log.info('zalo', socket.id, 'Account is active (valid response structure but no profile) for: %s', ownId);
                                }
                            } else {
                                // Response không có cấu trúc hợp lệ → disconnected
                                status = 'disconnected';
                                log.warn('zalo', socket.id, 'Invalid response structure for account: %s', ownId);
                            }
                        } else {
                            status = 'disconnected';
                            log.warn('zalo', socket.id, 'getUserInfo returned null for account: %s', ownId);
                        }

                        // Chỉ cập nhật status trong DB nếu status mới khác với status hiện tại
                        const currentStatus = acc.status || 'disconnected';
                        const shouldUpdate = status !== currentStatus;
                        
                        if (shouldUpdate) {
                            // Cập nhật status trong DB khi status thay đổi
                            try {
                                const updateResult = await ZaloAccount.updateOne(
                                    { accountKey: acc.accountKey },
                                    { 
                                        $set: { 
                                            status: status,
                                            'session.lastActiveAt': new Date()
                                        } 
                                    }
                                );
                                
                                log.info('zalo', socket.id, 'Updated status in DB for account %s: %s → %s (matched: %d, modified: %d)', 
                                    acc.accountKey, currentStatus, status, updateResult.matchedCount, updateResult.modifiedCount);
                                console.log('[Zalo Handler] 💾 Updated status in DB:', acc.accountKey, currentStatus, '→', status);
                                
                                results.push({
                                    accountKey: acc.accountKey,
                                    status,
                                    error: null,
                                    updated: true,
                                    previousStatus: currentStatus
                                });
                            } catch (dbUpdateErr) {
                                log.error('zalo', socket.id, 'Failed to update status in DB for account %s: %s', 
                                    acc.accountKey, dbUpdateErr?.message);
                                
                                results.push({
                                    accountKey: acc.accountKey,
                                    status,
                                    error: dbUpdateErr?.message || 'Failed to update DB',
                                    updated: false
                                });
                            }
                        } else {
                            // Status không thay đổi → chỉ cập nhật lastActiveAt
                            try {
                                await ZaloAccount.updateOne(
                                    { accountKey: acc.accountKey },
                                    { 
                                        $set: { 
                                            'session.lastActiveAt': new Date()
                                        } 
                                    }
                                );
                                
                                log.info('zalo', socket.id, 'Status unchanged for account %s: %s (no DB update needed)', 
                                    acc.accountKey, status);
                                console.log('[Zalo Handler] ✅ Status unchanged:', acc.accountKey, '→', status);
                                
                                results.push({
                                    accountKey: acc.accountKey,
                                    status,
                                    error: null,
                                    updated: false, // Không cập nhật vì status giống nhau
                                    previousStatus: currentStatus
                                });
                            } catch (dbUpdateErr) {
                                log.error('zalo', socket.id, 'Failed to update lastActiveAt in DB for account %s: %s', 
                                    acc.accountKey, dbUpdateErr?.message);
                                
                                results.push({
                                    accountKey: acc.accountKey,
                                    status,
                                    error: dbUpdateErr?.message || 'Failed to update DB',
                                    updated: false
                                });
                            }
                        }
                    } catch (getUserInfoErr) {
                        error = getUserInfoErr?.message || 'getUserInfo failed';
                        status = 'disconnected';
                        
                        // Chỉ cập nhật status trong DB khi có lỗi NẾU status hiện tại không phải disconnected
                        const currentStatus = acc.status || 'disconnected';
                        const shouldUpdate = status !== currentStatus;
                        
                        if (shouldUpdate) {
                            try {
                                await ZaloAccount.updateOne(
                                    { accountKey: acc.accountKey },
                                    { 
                                        $set: { 
                                            status: 'disconnected',
                                            'session.lastActiveAt': new Date()
                                        } 
                                    }
                                );
                                log.warn('zalo', socket.id, 'Updated status to disconnected (getUserInfo failed) for account: %s (%s → disconnected)', 
                                    acc.accountKey, currentStatus);
                                
                                results.push({
                                    accountKey: acc.accountKey,
                                    status: 'disconnected',
                                    error,
                                    updated: true,
                                    previousStatus: currentStatus
                                });
                            } catch (dbUpdateErr) {
                                log.error('zalo', socket.id, 'Failed to update status in DB: %s', dbUpdateErr?.message);
                                
                                results.push({
                                    accountKey: acc.accountKey,
                                    status: 'disconnected',
                                    error: dbUpdateErr?.message || 'Failed to update DB',
                                    updated: false
                                });
                            }
                        } else {
                            log.warn('zalo', socket.id, 'Status already disconnected for account %s (getUserInfo failed, no DB update)', acc.accountKey);
                            
                            results.push({
                                accountKey: acc.accountKey,
                                status: 'disconnected',
                                error,
                                updated: false, // Không cập nhật vì đã là disconnected
                                previousStatus: currentStatus
                            });
                        }
                    }
                } catch (err) {
                    log.error('zalo', socket.id, 'Error updating status for account %s: %s', acc.accountKey, err?.message);
                    results.push({
                        accountKey: acc.accountKey,
                        status: acc.status || 'disconnected',
                        error: err?.message || 'Unknown error',
                        updated: false
                    });
                }
            }

            console.log('[Zalo Handler] 📊 Updated status for %d accounts', results.length);
            safeAck({ ok: true, results });
        } catch (err) {
            log.error('zalo', socket.id, 'Failed to update account status: %s', err?.message);
            console.error('[Zalo Handler] ❌ Failed to update account status:', err);
            safeAck({ 
                ok: false, 
                error: err?.message || 'Failed to update account status',
                results: []
            });
        }
    });

    // Lấy danh sách tài khoản Zalo đã đăng nhập
    socket.on('zalo:getAccounts', async (data, ack) => {
        const safeAck = (response) => {
            if (typeof ack === 'function') {
                try {
                    ack(response);
                } catch (err) {
                    log.error('zalo', socket.id, 'Ack error: %s', err?.message);
                }
            } else {
                socket.emit('zalo:accounts:response', response);
            }
        };

        try {
            await ensureMongo();
            
            // Lấy tổng số lượng tài khoản từ database
            const totalCount = await ZaloAccount.countDocuments({});
            
            const accounts = await ZaloAccount.find({})
                .select('profile accountKey status createdAt updatedAt')
                .sort({ updatedAt: -1 })
                .lean();

            const accountsList = accounts.map(acc => ({
                accountKey: acc.accountKey,
                zaloId: acc.profile?.zaloId || acc.accountKey,
                displayName: acc.profile?.displayName || 'Người dùng Zalo',
                avatar: acc.profile?.avatar || '',
                phoneMasked: acc.profile?.phoneMasked || '',
                status: acc.status || 'active',
                createdAt: acc.createdAt,
                updatedAt: acc.updatedAt
            }));

            log.info('zalo', socket.id, 'Fetched %d accounts from DB (total: %d)', accountsList.length, totalCount);
            console.log('[Zalo Handler] 📋 Fetched accounts:', accountsList.length, 'Total in DB:', totalCount);
            
            safeAck({ ok: true, accounts: accountsList, totalCount });
        } catch (err) {
            log.error('zalo', socket.id, 'Failed to fetch accounts: %s', err?.message);
            console.error('[Zalo Handler] ❌ Failed to fetch accounts:', err);
            // Trả về danh sách rỗng thay vì lỗi để UI vẫn hiển thị được
            safeAck({ 
                ok: false, 
                error: err?.message || 'Failed to fetch accounts', 
                accounts: [],
                message: 'Không thể kết nối đến database. Vui lòng kiểm tra cấu hình MongoDB_URI trong file .env'
            });
        }
    });

    // Xóa tài khoản Zalo
    socket.on('zalo:deleteAccount', async (data, ack) => {
        const safeAck = (response) => {
            if (typeof ack === 'function') {
                try {
                    ack(response);
                } catch (err) {
                    log.error('zalo', socket.id, 'Ack error: %s', err?.message);
                }
            } else {
                socket.emit('zalo:deleteAccount:response', response);
            }
        };

        try {
            const { accountKey } = data || {};
            
            if (!accountKey) {
                safeAck({ ok: false, error: 'accountKey is required' });
                return;
            }

            await ensureMongo();

            // Xóa account từ database
            const deleteResult = await ZaloAccount.deleteOne({ accountKey });
            
            if (deleteResult.deletedCount === 0) {
                log.warn('zalo', socket.id, 'Account not found for deletion: %s', accountKey);
                safeAck({ ok: false, error: 'Account not found' });
                return;
            }

            // Xóa API instance khỏi runtime Map nếu có
            removeRuntimeApi(accountKey);

            log.info('zalo', socket.id, 'Deleted account: %s', accountKey);
            console.log('[Zalo Handler] 🗑️ Deleted account:', accountKey);
            
            safeAck({ ok: true, accountKey, deletedCount: deleteResult.deletedCount });
        } catch (err) {
            log.error('zalo', socket.id, 'Failed to delete account: %s', err?.message);
            console.error('[Zalo Handler] ❌ Failed to delete account:', err);
            safeAck({ 
                ok: false, 
                error: err?.message || 'Failed to delete account'
            });
        }
    });
}

