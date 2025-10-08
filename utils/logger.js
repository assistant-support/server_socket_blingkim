// utils/logger.js
// ------------------------------------------------------------
// Logger nhẹ theo mức (error/warn/info/debug) điều khiển bằng env LOG_LEVEL
// Dùng: log.info('scope', socketId, 'message %s', var)
// ------------------------------------------------------------

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CUR = (process.env.LOG_LEVEL || 'info').toLowerCase();

/** ISO timestamp */
function ts() {
    return new Date().toISOString();
}

/** Chuẩn hoá format log: [time] [scope] sid=... message */
function fmt(scope, socketId, msg, ...args) {
    const sid = socketId ? ` sid=${socketId}` : '';
    return [`[${ts()}] [${scope}]${sid} ${msg}`, ...args];
}

export const log = {
    error(scope, socketId, msg, ...args) { if (LEVELS[CUR] >= LEVELS.error) console.error(...fmt(scope, socketId, msg, ...args)); },
    warn(scope, socketId, msg, ...args) { if (LEVELS[CUR] >= LEVELS.warn) console.warn(...fmt(scope, socketId, msg, ...args)); },
    info(scope, socketId, msg, ...args) { if (LEVELS[CUR] >= LEVELS.info) console.log(...fmt(scope, socketId, msg, ...args)); },
    debug(scope, socketId, msg, ...args) { if (LEVELS[CUR] >= LEVELS.debug) console.log(...fmt(scope, socketId, msg, ...args)); },
};
