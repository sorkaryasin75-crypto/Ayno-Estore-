/**
 * ============================================================================
 * AYNO STORE - FULL SYSTEM CONTROL & API HANDLER (PROD & ASYNC READY)
 * ============================================================================
 * Features Included:
 * - Client-Side Resilience & Offline Sync Queue
 * - Telegram WebApp HMAC SHA-256 Authentication & JWT Engine
 * - Full Async System Control Admin API Endpoints:
 *     1. POST /api/auth/telegram-login
 *     2. GET  /api/admin/dashboard-stats
 *     3. POST /api/admin/user/update-balance
 *     4. GET  /api/admin/orders/pending
 *     5. POST /api/admin/orders/manage
 * - Health Check & System Status
 * ============================================================================
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Global Configurations
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || 'ayno_store_super_secret_jwt_key_2026';
const ADMIN_TELEGRAM_IDS = [6246632270]; // Authorized Admin Telegram UIDs

const API_CONFIG = {
    BASE_URL: process.env.REACT_APP_API_URL || (typeof window !== 'undefined' ? window.location.origin : ''),
    TIMEOUT: 15000,
    RETRY_MAX: 3,
    RETRY_DELAY: 2000,
    HEALTH_CHECK_INTERVAL: 30000,
    CACHE_DURATION: 60000 * 5 // 5 Minutes
};

// ============================================================================
// PART 1: BACKEND SECURITY & ADMIN MIDDLEWARE (EXPRESS SERVER SIDE)
// ============================================================================

/**
 * Validates Telegram WebApp initData with HMAC SHA-256
 */
const verifyTelegramInitData = (initData) => {
    if (!initData) return false;
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        const dataCheckString = Array.from(urlParams.entries())
            .map(([key, value]) => `${key}=${value}`)
            .sort()
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (calculatedHash !== hash) return false;

        const userObj = JSON.parse(urlParams.get('user') || '{}');
        return userObj;
    } catch (err) {
        return false;
    }
};

/**
 * Admin Security Guard Middleware
 */
const requireAdminAuth = async (req, res, next) => {
    try {
        const initData = req.headers['x-telegram-init-data'];
        const authHeader = req.headers['authorization'];

        let tgUser = verifyTelegramInitData(initData);

        if (!tgUser && authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            tgUser = { id: decoded.tgId };
        }

        if (!tgUser || !tgUser.id) {
            return res.status(401).json({ success: false, message: "Unauthorized: Invalid Telegram Auth Data" });
        }

        if (!ADMIN_TELEGRAM_IDS.includes(Number(tgUser.id))) {
            return res.status(403).json({ success: false, message: "Access Denied: Admin privileges required" });
        }

        req.adminUser = tgUser;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: "Authentication Error: " + error.message });
    }
};

/**
 * Express Router Binding for System Control API
 */
const registerExpressRoutes = (app) => {
    const express = require('express');
    const router = express.Router();

    // 1. Health Check Endpoint
    router.head('/health', (req, res) => res.status(200).end());
    router.get('/health', (req, res) => res.json({ status: "healthy", timestamp: new Date().toISOString() }));

    // 2. Telegram WebApp Auto Login
    router.post('/auth/telegram-login', async (req, res) => {
        try {
            const { initData } = req.body;
            const tgUser = verifyTelegramInitData(initData);

            if (!tgUser || !tgUser.id) {
                return res.status(400).json({ success: false, message: "Invalid Telegram Auth Data" });
            }

            const db = req.app.get('db');
            let user = await db.collection('users').findOne({ tgId: Number(tgUser.id) });

            if (!user) {
                const newUser = {
                    tgId: Number(tgUser.id),
                    firstName: tgUser.first_name || '',
                    lastName: tgUser.last_name || '',
                    username: tgUser.username || '',
                    balance: 0,
                    role: ADMIN_TELEGRAM_IDS.includes(Number(tgUser.id)) ? 'admin' : 'user',
                    createdAt: new Date(),
                    updatedAt: new Date()
                };

                const result = await db.collection('users').insertOne(newUser);
                user = { _id: result.insertedId, ...newUser };
            } else {
                await db.collection('users').updateOne(
                    { tgId: Number(tgUser.id) },
                    { $set: { firstName: tgUser.first_name, username: tgUser.username, updatedAt: new Date() } }
                );
            }

            const token = jwt.sign(
                { userId: user._id, tgId: user.tgId, role: user.role },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            res.json({
                success: true,
                token,
                user: {
                    id: user._id,
                    tgId: user.tgId,
                    name: `${user.firstName} ${user.lastName}`.trim(),
                    username: user.username,
                    balance: user.balance,
                    role: user.role
                }
            });
        } catch (err) {
            res.status(500).json({ success: false, message: "Login Error: " + err.message });
        }
    });

    // 3. Admin: Live System Analytics
    router.get('/admin/dashboard-stats', requireAdminAuth, async (req, res) => {
        try {
            const db = req.app.get('db');

            const [totalUsers, pendingOrders, revenueAgg] = await Promise.all([
                db.collection('users').countDocuments(),
                db.collection('orders').countDocuments({ status: 'pending' }),
                db.collection('orders').aggregate([
                    { $match: { status: 'approved' } },
                    { $group: { _id: null, total: { $sum: "$amount" } } }
                ]).toArray()
            ]);

            const totalRevenue = revenueAgg[0]?.total || 0;

            res.json({
                success: true,
                stats: { totalUsers, pendingOrders, totalRevenue, systemStatus: "Active" }
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // 4. Admin: Balance Control (Add/Cut Money)
    router.post('/admin/user/update-balance', requireAdminAuth, async (req, res) => {
        try {
            const { targetTgId, amount, action } = req.body;
            if (!targetTgId || !amount || isNaN(amount) || amount <= 0) {
                return res.status(400).json({ success: false, message: "Invalid parameters" });
            }

            const db = req.app.get('db');
            const numericAmount = Number(amount);
            const increment = action === 'add' ? numericAmount : -numericAmount;

            const updatedUser = await db.collection('users').findOneAndUpdate(
                { tgId: Number(targetTgId) },
                { $inc: { balance: increment }, $set: { updatedAt: new Date() } },
                { returnDocument: 'after' }
            );

            if (!updatedUser || !updatedUser.value) {
                return res.status(404).json({ success: false, message: "Target user not found" });
            }

            res.json({
                success: true,
                message: `Balance updated! New Balance: ৳${updatedUser.value.balance}`,
                newBalance: updatedUser.value.balance
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // 5. Admin: Get Pending Orders List
    router.get('/admin/orders/pending', requireAdminAuth, async (req, res) => {
        try {
            const db = req.app.get('db');
            const orders = await db.collection('orders')
                .find({ status: 'pending' })
                .sort({ createdAt: -1 })
                .toArray();

            res.json({ success: true, orders });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // 6. Admin: Approve / Reject Orders
    router.post('/admin/orders/manage', requireAdminAuth, async (req, res) => {
        try {
            const { orderId, status } = req.body;
            if (!orderId || !['approved', 'rejected'].includes(status)) {
                return res.status(400).json({ success: false, message: "Invalid order action" });
            }

            const db = req.app.get('db');
            const order = await db.collection('orders').findOne({ _id: orderId });

            if (!order) return res.status(404).json({ success: false, message: "Order not found" });

            await db.collection('orders').updateOne(
                { _id: orderId },
                { $set: { status: status, processedBy: req.adminUser.id, updatedAt: new Date() } }
            );

            // Refund balance on rejection if applicable
            if (status === 'rejected' && order.paymentMethod === 'balance') {
                await db.collection('users').updateOne(
                    { tgId: order.userId },
                    { $inc: { balance: order.amount } }
                );
            }

            res.json({ success: true, message: `Order #${orderId} set to ${status}` });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    app.use('/api', router);
};

// ============================================================================
// PART 2: FRONTEND ASYNC CLIENT MANAGER (BROWSER SIDE)
// ============================================================================

class APIManager {
    constructor() {
        this.cache = new Map();
        this.pendingRequests = [];
        this.serverHealthy = true;
        this.isOffline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
        this.circuitBreaker = new Map();
        this.lastHealthCheck = null;

        if (typeof window !== 'undefined') {
            this.initializeNetworkListener();
            this.startHealthMonitor();
            this.loadPendingRequests();
        }
    }

    initializeNetworkListener() {
        window.addEventListener('online', async () => {
            this.isOffline = false;
            await this.syncPendingRequests();
        });

        window.addEventListener('offline', () => {
            this.isOffline = true;
        });
    }

    startHealthMonitor() {
        this.checkServerHealth();
        setInterval(() => this.checkServerHealth(), API_CONFIG.HEALTH_CHECK_INTERVAL);
    }

    async checkServerHealth() {
        try {
            const response = await this.fetchWithTimeout(`${API_CONFIG.BASE_URL}/api/health`, { method: 'HEAD' }, 5000);
            this.serverHealthy = response.ok;
            if (this.serverHealthy) await this.syncPendingRequests();
        } catch (error) {
            this.serverHealthy = false;
        }
    }

    fetchWithTimeout(url, options = {}, timeoutMs = API_CONFIG.TIMEOUT) {
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
                reject(new Error(`Timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            const headers = {
                'Content-Type': 'application/json',
                'x-telegram-init-data': window.Telegram?.WebApp?.initData || '',
                ...options.headers
            };

            fetch(url, { ...options, headers, signal: controller.signal })
                .then(res => { clearTimeout(timeoutId); resolve(res); })
                .catch(err => { clearTimeout(timeoutId); reject(err); });
        });
    }

    async request(endpoint, options = {}, useCache = true) {
        const fullUrl = `${API_CONFIG.BASE_URL}${endpoint}`;
        const method = (options.method || 'GET').toUpperCase();
        const cacheKey = `${method}:${fullUrl}`;

        if (this.isOffline) {
            const cached = this.getCachedData(cacheKey);
            if (cached) return cached;
            throw new Error('Offline and no cache available');
        }

        let lastError;
        for (let attempt = 0; attempt <= API_CONFIG.RETRY_MAX; attempt++) {
            try {
                const response = await this.fetchWithTimeout(fullUrl, options);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const data = await response.json();
                if (useCache && method === 'GET') this.setCachedData(cacheKey, data);
                return data;
            } catch (error) {
                lastError = error;
                if (attempt < API_CONFIG.RETRY_MAX) {
                    await new Promise(r => setTimeout(r, API_CONFIG.RETRY_DELAY * Math.pow(2, attempt)));
                }
            }
        }
        throw lastError;
    }

    setCachedData(key, data) {
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    getCachedData(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() - item.timestamp > API_CONFIG.CACHE_DURATION) {
            this.cache.delete(key);
            return null;
        }
        return item.data;
    }

    async enqueuePendingRequest(endpoint, options = {}) {
        const request = { id: Math.random().toString(36), endpoint, options, timestamp: Date.now() };
        this.pendingRequests.push(request);
        this.savePendingRequests();
        return request;
    }

    savePendingRequests() {
        try { localStorage.setItem('ayno_pending_requests', JSON.stringify(this.pendingRequests)); } catch (e) {}
    }

    loadPendingRequests() {
        try {
            const stored = localStorage.getItem('ayno_pending_requests');
            this.pendingRequests = stored ? JSON.parse(stored) : [];
        } catch (e) { this.pendingRequests = []; }
    }

    async syncPendingRequests() {
        if (this.pendingRequests.length === 0) return;
        const failed = [];
        for (const req of this.pendingRequests) {
            try { await this.request(req.endpoint, req.options); }
            catch (e) { failed.push(req); }
        }
        this.pendingRequests = failed;
        this.savePendingRequests();
    }

    // ========================================================================
    // PUBLIC ASYNC CLIENT METHODS (ADMIN & USER)
    // ========================================================================

    async loginViaTelegram() {
        return this.request('/api/auth/telegram-login', {
            method: 'POST',
            body: JSON.stringify({ initData: window.Telegram?.WebApp?.initData })
        }, false);
    }

    async getAdminDashboardStats() {
        return this.request('/api/admin/dashboard-stats', { method: 'GET' }, false);
    }

    async updateUserBalance(targetTgId, amount, action) {
        return this.request('/api/admin/user/update-balance', {
            method: 'POST',
            body: JSON.stringify({ targetTgId, amount, action })
        }, false);
    }

    async getPendingOrders() {
        return this.request('/api/admin/orders/pending', { method: 'GET' }, false);
    }

    async manageOrder(orderId, status) {
        return this.request('/api/admin/orders/manage', {
            method: 'POST',
            body: JSON.stringify({ orderId, status })
        }, false);
    }
}

// Module Export for Node Server & Global Window Instance for Frontend
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        registerExpressRoutes,
        verifyTelegramInitData,
        requireAdminAuth
    };
}

if (typeof window !== 'undefined') {
    window.apiManager = new APIManager();
}
