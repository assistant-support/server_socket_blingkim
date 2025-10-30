// omicall-manager.js
// ------------------------------------------------------------
// OMICall Manager - Server-side call management
// Centralized call state management and SDK handling
// ------------------------------------------------------------

import { log } from './utils/logger.js';

class OMICallManager {
    constructor() {
        this.calls = new Map(); // Map<callId, callData>
        this.sdk = null; // Not used in server-API mode
        this.isInitialized = true; // Server-API mode doesn't need SDK init
        this.io = null; // Socket.IO emitter
        this.api = {
            baseUrl: process.env.OMICALL_API_BASE || 'https://api.omicrm.com',
            apiKey: process.env.OMICALL_API_KEY || '',
            tenantId: process.env.OMICALL_TENANT_ID || '',
        };
        this.config = {
            sipRealm: 'sip.info268.com',
            sipUser: '100',
            sipPassword: 'Ws9nsNEClG',
            hotlineNumber: '842471238879'
        };
        
        // Alternative credentials for testing
        this.alternativeConfigs = [
            {
                sipRealm: 'info268',
                sipUser: '100',
                sipPassword: 'Ws9nsNEClG',
                hotlineNumber: '842471238879'
            },
            {
                sipRealm: 'sip.info268.com',
                sipUser: '100',
                sipPassword: 'Ws9nsNEClG',
                hotlineNumber: '842471238879'
            },
            {
                sipRealm: 'info268.com',
                sipUser: '100',
                sipPassword: 'Ws9nsNEClG',
                hotlineNumber: '842471238879'
            }
        ];
        
        // console.log('[OMICallManager] Initialized with config:', this.config);
    }

    // Inject Socket.IO emitter for broadcasting
    setEmitter(io) {
        this.io = io;
        // console.log('[OMICallManager] IO emitter attached');
    }

    // initializeSDK kept for compatibility; server-API mode doesn't require it
    async initializeSDK() {
        // console.log('[OMICallManager] initializeSDK() - server API mode, skipping');
        this.isInitialized = true;
    }

    // Load real SDK (server-side)
    async loadRealSDK() {
        // console.log('[OMICallManager] 📦 Attempting to load real SDK...');
        
        try {
            // In a real implementation, you would load the SDK here
            // For now, we'll return null to use mock
            // console.log('[OMICallManager] 📦 Real SDK loading not implemented, using mock');
            return null;
        } catch (error) {
            // console.error('[OMICallManager] ❌ Real SDK loading failed:', error);
            return null;
        }
    }

    // Create mock SDK for testing
    createMockSDK() {
        // console.log('[OMICallManager] 🎭 Creating mock SDK...');
        
        return {
            init: async (config) => {
                // console.log('[OMICallManager] Mock init:', config);
                return true;
            },
            register: async (params) => {
                // console.log('[OMICallManager] Mock register:', params);
                return { status: true };
            },
            makeCall: async (phoneNumber, options) => {
                // console.log('[OMICallManager] Mock makeCall:', phoneNumber, options);
                return true;
            },
            on: (event, callback) => {
                // console.log('[OMICallManager] Mock on:', event);
                // Simulate events
                if (event === 'register') {
                    setTimeout(() => callback({ status: 'connected' }), 500);
                }
            },
            currentCall: {
                end: () => {
                    console.log('[OMICallManager] Mock end call');
                }
            },
            disconnect: () => {
                console.log('[OMICallManager] Mock disconnect');
            },
            destroy: () => {
                console.log('[OMICallManager] Mock destroy');
            }
        };
    }

    // Start a new call via provider server API
    async startCall(phoneNumber, customerId) {
        // console.log('[OMICallManager] 📞 startCall() called:', { phoneNumber, customerId });
        
        try {
            // Generate unique call ID
            const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Create call data
            const callData = {
                callId,
                phoneNumber,
                customerId,
                status: 'connecting', // initial state
                startTime: new Date().toISOString(),
                isActive: true,
                timers: {},
                api: { requestId: callId }
            };
            
            // Store call
            this.calls.set(callId, callData);
            
            // console.log('[OMICallManager] 📞 Call created:', callData);
            
            // Emit initial status to room
            this.emitToRoom(callId, 'call:status', { callId, status: 'connecting', phoneNumber, customerId });

            // Trigger provider API remote call
            this.remoteCall(callId, phoneNumber)
                .then((providerResp) => {
                    // On provider accepted request, set ringing and start watchdog timers
                    this.updateCallStatus(callId, 'ringing');
                    this.emitToRoom(callId, 'call:status', { callId, status: 'ringing', phoneNumber, customerId });
                    this.armTimeouts(callId);
                })
                .catch((error) => {
                    this.updateCallStatus(callId, 'error');
                    this.emitToRoom(callId, 'call:error', { callId, message: error?.message || 'remoteCall failed' });
                    // Cleanup
                    this.safeEnd(callId);
                });
            
            return callId;
            
        } catch (error) {
            // console.error('[OMICallManager] ❌ startCall failed:', error);
            throw error;
        }
    }

    // End a call
    async endCall(callId) {
        // console.log('[OMICallManager] 📞 endCall() called:', callId);
        
        try {
            const callData = this.calls.get(callId);
            
            if (!callData) {
                // console.log('[OMICallManager] ⚠️ Call not found:', callId);
                return;
            }
            // Cancel via provider API (best-effort)
            try { await this.cancelRemoteCall(callId); } catch {}
            
            // Update call status
            callData.status = 'ended';
            callData.isActive = false;
            callData.endTime = new Date().toISOString();
            
            // Clear timers
            this.disarmTimeouts(callId);

            // Remove from active calls
            this.calls.delete(callId);
            
            // console.log('[OMICallManager] ✅ Call ended:', callId);
            this.emitToRoom(callId, 'call:ended', { callId });
            
        } catch (error) {
            // console.error('[OMICallManager] ❌ endCall failed:', error);
            throw error;
        }
    }

    // Update call status
    updateCallStatus(callId, status) {
        // console.log('[OMICallManager] 📞 updateCallStatus:', { callId, status });
        
        const callData = this.calls.get(callId);
        if (callData) {
            callData.status = status;
            callData.lastUpdate = new Date().toISOString();
            
            // console.log('[OMICallManager] 📞 Call status updated:', callData);
            this.emitToRoom(callId, 'call:status', { callId, status, phoneNumber: callData.phoneNumber, customerId: callData.customerId });
        }
    }

    // Get call data
    getCall(callId) {
        return this.calls.get(callId);
    }

    // Get all active calls
    getActiveCalls() {
        const activeCalls = [];
        for (const [callId, callData] of this.calls) {
            if (callData.isActive) {
                activeCalls.push(callData);
            }
        }
        return activeCalls;
    }

    // Cleanup inactive calls
    cleanupInactiveCalls() {
        // console.log('[OMICallManager] 🧹 Cleaning up inactive calls...');
        
        const now = Date.now();
        const timeout = 5 * 60 * 1000; // 5 minutes
        
        for (const [callId, callData] of this.calls) {
            const callTime = new Date(callData.startTime).getTime();
            if (now - callTime > timeout) {
                // console.log('[OMICallManager] 🧹 Removing old call:', callId);
                this.calls.delete(callId);
            }
        }
    }

    // Handle SDK errors
    handleSDKError(error) {
        // console.error('[OMICallManager] ❌ SDK Error:', error);
        
        // Emit error to all active calls
        for (const [callId, callData] of this.calls) {
            if (callData.isActive) {
                callData.status = 'error';
                callData.error = error.message || 'Unknown error';
            }
        }
    }

    // Get manager status
    getStatus() {
        return {
            isInitialized: this.isInitialized,
            activeCalls: this.calls.size,
            calls: Array.from(this.calls.values())
        };
    }

    // Cleanup all resources
    destroy() {
        // console.log('[OMICallManager] 🧹 Destroying manager...');
        
        // End all active calls
        for (const [callId, callData] of this.calls) {
            if (callData.isActive) {
                this.endCall(callId);
            }
        }
        
        // Clear calls map
        this.calls.clear();
        
        // Destroy SDK
        if (this.sdk?.destroy) {
            this.sdk.destroy();
        }
        
        this.sdk = null;
        this.isInitialized = false;
        
        // console.log('[OMICallManager] ✅ Manager destroyed');
    }

    // ===== Provider API helpers =====
    async remoteCall(callId, phoneNumber) {
        // Example provider API call. Replace with real OMICall server-side API.
        const url = `${this.api.baseUrl}/v1/calls/outbound`;
        const body = {
            tenant_id: this.api.tenantId,
            to: phoneNumber,
            request_id: callId,
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.api.apiKey}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`remoteCall failed: ${res.status} ${txt}`);
        }
        return await res.json();
    }

    async cancelRemoteCall(callId) {
        const url = `${this.api.baseUrl}/v1/calls/${encodeURIComponent(callId)}/cancel`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.api.apiKey}`,
            },
        });
        return res.ok;
    }

    // ===== Timeouts & cleanup to avoid stuck states =====
    armTimeouts(callId) {
        const call = this.calls.get(callId);
        if (!call) return;
        // If not accepted within 45s -> timeout
        call.timers.acceptTimeout = setTimeout(() => {
            const c = this.calls.get(callId);
            if (!c || c.status === 'accepted' || c.status === 'ended') return;
            this.updateCallStatus(callId, 'timeout');
            this.emitToRoom(callId, 'call:error', { callId, message: 'Call timeout' });
            this.safeEnd(callId);
        }, 45000);
    }

    disarmTimeouts(callId) {
        const call = this.calls.get(callId);
        if (!call || !call.timers) return;
        Object.values(call.timers).forEach(t => {
            try { clearTimeout(t); } catch {}
        });
        call.timers = {};
    }

    async safeEnd(callId) {
        try { await this.endCall(callId); } catch {}
    }

    // Emit to per-call room
    emitToRoom(callId, event, payload) {
        if (!this.io) return;
        this.io.to(callId).emit(event, payload);
    }
}

// Singleton instance
let omicallManagerInstance = null;

const getOMICallManager = () => {
    if (!omicallManagerInstance) {
        omicallManagerInstance = new OMICallManager();
        // console.log('[OMICallManager] Created singleton instance');
    }
    return omicallManagerInstance;
};

export default getOMICallManager();
