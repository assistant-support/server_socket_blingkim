// events/call.handler.js
// ------------------------------------------------------------
// Call event handlers for Socket.IO server
// Handles call synchronization between clients
// ------------------------------------------------------------

import { log } from '../utils/logger.js';
import callManager from '../omicall-manager.js';

export function registerCallEvents(io, socket) {
    // console.log('[CallHandler] Registering call events for socket:', socket.id);
    
    // New call flow: socket is coordination center
    socket.on('call:start', async ({ phoneNumber, customerId }) => {
        try {
            const callId = await callManager.startCall(phoneNumber, customerId);
            // Join per-call room
            socket.join(callId);
            socket.data.callId = callId;
            io.to(callId).emit('call:status', { callId, status: 'calling', phoneNumber, customerId });
        } catch (error) {
            log.error('call', socket.id, 'start error %s', error?.message || error);
            socket.emit('call:error', { message: error?.message || 'Start call failed' });
        }
    });

    socket.on('call:end', async ({ callId }) => {
        try {
            await callManager.endCall(callId);
            io.to(callId).emit('call:ended', { callId, by: socket.id, timestamp: new Date().toISOString() });
            socket.leave(callId);
        } catch (error) {
            log.error('call', socket.id, 'end error %s', error?.message || error);
            socket.emit('call:error', { message: error?.message || 'End call failed' });
        }
    });

    socket.on('call:sync', ({ callId }) => {
        const call = callManager.getCall(callId);
        if (call) {
            socket.emit('call:status', { callId, status: call.status, phoneNumber: call.phoneNumber, customerId: call.customerId });
        } else {
            socket.emit('call:ended', { callId, reason: 'not_found' });
        }
    });
    
    // Cleanup when socket disconnects
    socket.on('disconnect', async () => {
        // console.log('[CallHandler] Socket disconnected:', socket.id);
        if (socket.data.callId) {
            try {
                await callManager.endCall(socket.data.callId);
            } catch {}
            io.to(socket.data.callId).emit('call:ended', { callId: socket.data.callId, reason: 'disconnect' });
            socket.leave(socket.data.callId);
        }
    });
    
    // Remove legacy handlers (validate/force_end/cleanup/status/rooms)
    
    // (legacy handlers removed in new flow)
    
    // (legacy handlers removed in new flow)
    
    // (handled above in new flow)
    
    // (handled above in new flow)
    
    // (status updates emitted globally by server)
}
