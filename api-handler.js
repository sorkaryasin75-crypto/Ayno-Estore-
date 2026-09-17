/**
 * ============================================================================
 * AYNO STORE - API HANDLER WITH RAILWAY SERVER FALLBACK & OFFLINE SUPPORT
 * ============================================================================
 * Handles:
 * - Railway server downtime detection
 * - Automatic fallback to cached/mock data
 * - Retry logic with exponential backoff
 * - Network status monitoring
 * - Queue pending operations
 * - Auto-sync when server comes back online
 * ============================================================================
 */

const API_CONFIG = {
    BASE_URL: (window.__AYNO_API_URL__ || window.location.origin),
    TIMEOUT: 15000,
    RETRY_MAX: 3,
    RETRY_DELAY: 2000,
    HEALTH_CHECK_INTERVAL: 30000,
    CACHE_DURATION: 60000 * 5 // 5 minutes
};

class APIManager {
    constructor() {
        this.cache = new Map();
        this.pendingRequests = [];
        this.serverHealthy = true;
        this.isOffline = !navigator.onLine;
        this.circuitBreaker = new Map();
        this.lastHealthCheck = null;
        
        this.initializeNetworkListener();
        this.startHealthMonitor();
        this.loadPendingRequests();
    }
    
    // ========================================================================
    // NETWORK STATUS MONITORING
    // ========================================================================
    
    initializeNetworkListener() {
        window.addEventListener('online', () => {
            this.isOffline = false;
            console.log('✅ Network: ONLINE');
            this.onNetworkRestored();
        });
        
        window.addEventListener('offline', () => {
            this.isOffline = true;
            console.log('⚠️ Network: OFFLINE');
            this.onNetworkLost();
        });
    }
    
    async onNetworkRestored() {
        showNotification('🌐 Internet connection restored', 'success', 3000);
        this.updateUI('online');
        await this.syncPendingRequests();
    }
    
    onNetworkLost() {
        showNotification('📡 Offline mode - limited functionality', 'warning');
        this.updateUI('offline');
    }
    
    // ========================================================================
    // HEALTH CHECK - RAILWAY SERVER STATUS
    // ========================================================================
    
    startHealthMonitor() {
        this.checkServerHealth();
        setInterval(() => this.checkServerHealth(), API_CONFIG.HEALTH_CHECK_INTERVAL);
    }
    
    async checkServerHealth() {
        try {
            const response = await this.fetchWithTimeout(`${API_CONFIG.BASE_URL}/api/health`, {
                method: 'HEAD'
            }, 5000);
            
            const wasUnhealthy = !this.serverHealthy;
            this.serverHealthy = response.ok;
            
            if (wasUnhealthy && this.serverHealthy) {
                console.log('🚀 Railway Server: BACK ONLINE');
                await this.syncPendingRequests();
                this.updateUI('online');
            } else if (this.serverHealthy) {
                console.log('✅ Railway Server: HEALTHY');
            }
        } catch (error) {
            this.serverHealthy = false;
            console.warn('⚠️ Railway Server: UNREACHABLE', error.message);
            this.updateUI('server-down');
        }
        
        this.lastHealthCheck = new Date().toISOString();
    }
    
    // ========================================================================
    // ENHANCED FETCH WITH TIMEOUT
    // ========================================================================
    
    fetchWithTimeout(url, options = {}, timeoutMs = API_CONFIG.TIMEOUT) {
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
                reject(new Error(`Request timeout after ${timeoutMs}ms - ${url}`));
            }, timeoutMs);
            
            fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            })
            .then(response => {
                clearTimeout(timeoutId);
                resolve(response);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                reject(error);
            });
        });
    }
    
    // ========================================================================
    // RETRY LOGIC WITH CIRCUIT BREAKER
    // ========================================================================
    
    shouldRetry(endpoint, error) {
        // Don't retry if it's a client error (4xx)
        if (error.response?.status >= 400 && error.response?.status < 500) {
            return false;
        }
        
        // Retry on network errors, timeouts, and server errors (5xx)
        if (error.message.includes('timeout') || 
            error.message.includes('Failed to fetch') ||
            error.response?.status >= 500) {
            return true;
        }
        
        return false;
    }
    
    getCircuitBreakerStatus(endpoint) {
        if (!this.circuitBreaker.has(endpoint)) {
            this.circuitBreaker.set(endpoint, {
                failures: 0,
                lastFailure: null,
                state: 'CLOSED' // CLOSED, OPEN, HALF_OPEN
            });
        }
        return this.circuitBreaker.get(endpoint);
    }
    
    recordFailure(endpoint) {
        const breaker = this.getCircuitBreakerStatus(endpoint);
        breaker.failures++;
        breaker.lastFailure = Date.now();
        
        if (breaker.failures >= 5) {
            breaker.state = 'OPEN';
            console.warn(`🔴 Circuit breaker OPEN for ${endpoint}`);
        }
    }
    
    recordSuccess(endpoint) {
        const breaker = this.getCircuitBreakerStatus(endpoint);
        breaker.failures = 0;
        breaker.state = 'CLOSED';
    }
    
    isCircuitBreakerOpen(endpoint) {
        const breaker = this.getCircuitBreakerStatus(endpoint);
        
        if (breaker.state !== 'OPEN') return false;
        
        // Try to recover after 30 seconds
        const timeSinceLastFailure = Date.now() - breaker.lastFailure;
        if (timeSinceLastFailure > 30000) {
            breaker.state = 'HALF_OPEN';
            console.log(`⚡ Circuit breaker HALF_OPEN for ${endpoint} - retrying...`);
            return false;
        }
        
        return true;
    }
    
    // ========================================================================
    // MAKE API REQUEST WITH FULL RESILIENCE
    // ========================================================================
    
    async request(endpoint, options = {}, useCache = true) {
        const fullUrl = `${API_CONFIG.BASE_URL}${endpoint}`;
        const method = (options.method || 'GET').toUpperCase();
        const cacheKey = `${method}:${fullUrl}`;
        // V3: every state-changing request gets one stable idempotency key so retries cannot double-charge.
        const requestOptions = { ...options, headers: { ...(options.headers || {}) } };
        if (!['GET','HEAD','OPTIONS'].includes(method) && !requestOptions.headers['Idempotency-Key'] && !requestOptions.headers['idempotency-key']) {
            requestOptions.headers['Idempotency-Key'] = (crypto?.randomUUID ? crypto.randomUUID() : `ayno-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        }
        
        // Check circuit breaker
        if (this.isCircuitBreakerOpen(endpoint)) {
            console.warn(`⚠️ Circuit breaker open for ${endpoint}`);
            const cached = this.getCachedData(cacheKey);
            if (cached) {
                showNotification('Using cached data (server unavailable)', 'warning');
                return cached;
            }
            throw new Error(`Server temporarily unavailable for ${endpoint}`);
        }
        
        // If offline, use cache
        if (this.isOffline) {
            const cached = this.getCachedData(cacheKey);
            if (cached) {
                console.log(`📦 Using cached data (offline): ${endpoint}`);
                return cached;
            }
            throw new Error('Offline and no cached data available');
        }
        
        // Retry logic
        let lastError;
        for (let attempt = 0; attempt <= API_CONFIG.RETRY_MAX; attempt++) {
            try {
                const response = await this.fetchWithTimeout(fullUrl, requestOptions, API_CONFIG.TIMEOUT);
                
                if (!response.ok) {
                    if (response.status === 503 || response.status === 502 || response.status === 504) {
                        // Server/gateway error - mark as unhealthy
                        this.serverHealthy = false;
                        throw new Error(`Server error ${response.status}: Railway may be down`);
                    }
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                
                // Cache successful response
                if (useCache && method === 'GET') {
                    this.setCachedData(cacheKey, data);
                }
                
                // Record success
                this.recordSuccess(endpoint);
                return data;
                
            } catch (error) {
                lastError = error;
                this.recordFailure(endpoint);
                
                if (attempt < API_CONFIG.RETRY_MAX && this.shouldRetry(endpoint, error)) {
                    const delay = API_CONFIG.RETRY_DELAY * Math.pow(2, attempt); // Exponential backoff
                    console.log(`🔄 Retry ${attempt + 1}/${API_CONFIG.RETRY_MAX} after ${delay}ms: ${endpoint}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    break;
                }
            }
        }
        
        // All retries failed - use cache or throw
        const cached = this.getCachedData(cacheKey);
        if (cached) {
            console.warn(`⚠️ Using cached data (request failed): ${endpoint}`);
            showNotification('Using cached data (connection issue)', 'warning');
            return cached;
        }
        
        // No cache available
        throw lastError || new Error(`Failed to fetch ${endpoint}`);
    }
    
    // ========================================================================
    // CACHING
    // ========================================================================
    
    setCachedData(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
    
    getCachedData(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        const age = Date.now() - item.timestamp;
        if (age > API_CONFIG.CACHE_DURATION) {
            this.cache.delete(key);
            return null;
        }
        
        return item.data;
    }
    
    clearCache() {
        this.cache.clear();
        console.log('🗑️ Cache cleared');
    }
    
    // ========================================================================
    // PENDING REQUESTS QUEUE
    // ========================================================================
    
    async enqueuePendingRequest(endpoint, options = {}) {
        const request = {
            id: Math.random().toString(36),
            endpoint,
            options,
            timestamp: Date.now()
        };
        
        this.pendingRequests.push(request);
        this.savePendingRequests();
        
        console.log(`📋 Request queued (offline): ${endpoint}`);
        return request;
    }
    
    savePendingRequests() {
        try {
            localStorage.setItem('ayno_pending_requests', JSON.stringify(this.pendingRequests));
        } catch (e) {
            console.error('Failed to save pending requests:', e);
        }
    }
    
    loadPendingRequests() {
        try {
            const stored = localStorage.getItem('ayno_pending_requests');
            this.pendingRequests = stored ? JSON.parse(stored) : [];
            console.log(`📋 Loaded ${this.pendingRequests.length} pending requests`);
        } catch (e) {
            console.error('Failed to load pending requests:', e);
            this.pendingRequests = [];
        }
    }
    
    async syncPendingRequests() {
        if (this.pendingRequests.length === 0) return;
        
        console.log(`🔄 Syncing ${this.pendingRequests.length} pending requests...`);
        
        const failed = [];
        for (const request of this.pendingRequests) {
            try {
                await this.request(request.endpoint, request.options);
                console.log(`✅ Synced: ${request.endpoint}`);
            } catch (error) {
                console.error(`❌ Failed to sync: ${request.endpoint}`, error.message);
                failed.push(request);
            }
        }
        
        this.pendingRequests = failed;
        this.savePendingRequests();
        
        if (failed.length === 0) {
            showNotification('✅ All pending requests synced', 'success');
        } else {
            showNotification(`⚠️ ${failed.length} requests still pending`, 'warning');
        }
    }
    
    // ========================================================================
    // UI UPDATES
    // ========================================================================
    
    updateUI(status) {
        const statusIndicator = document.getElementById('server-status-indicator');
        if (!statusIndicator) {
            const div = document.createElement('div');
            div.id = 'server-status-indicator';
            div.style.cssText = `
                position: fixed;
                top: 70px;
                left: 20px;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 600;
                z-index: 9996;
                backdrop-filter: blur(10px);
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            `;
            document.body.appendChild(div);
        }
        
        const statusConfig = {
            'online': {
                bg: '#DCFCE7',
                text: '#166534',
                icon: '🟢',
                message: 'Online'
            },
            'offline': {
                bg: '#FEE2E2',
                text: '#991B1B',
                icon: '🔴',
                message: 'Offline Mode'
            },
            'server-down': {
                bg: '#FEF3C7',
                text: '#92400E',
                icon: '🟡',
                message: 'Server Connecting...'
            }
        };
        
        const config = statusConfig[status] || statusConfig['offline'];
        document.getElementById('server-status-indicator').style.backgroundColor = config.bg;
        document.getElementById('server-status-indicator').style.color = config.text;
        document.getElementById('server-status-indicator').innerHTML = `
            ${config.icon} ${config.message}
        `;
    }
    
    // ========================================================================
    // PUBLIC API METHODS
    // ========================================================================
    
    async fetchAppData() {
        return this.request('/api/app-data', {}, true);
    }
    
    async fetchUserData() {
        const token = localStorage.getItem('tg_token');
        return this.request('/api/user', {
            headers: { 'Authorization': `Bearer ${token}` }
        }, true);
    }
    
    async createOrder(orderData) {
        const token = localStorage.getItem('tg_token');
        
        // Queue if offline
        if (this.isOffline) {
            return this.enqueuePendingRequest('/api/orders', {
                method: 'POST',
                body: JSON.stringify(orderData),
                headers: { 'Authorization': `Bearer ${token}` }
            });
        }
        
        return this.request('/api/orders', {
            method: 'POST',
            body: JSON.stringify(orderData),
            headers: { 'Authorization': `Bearer ${token}` }
        }, false);
    }
    
    async uploadScreenshot(file) {
        const token = localStorage.getItem('tg_token');
        const formData = new FormData();
        formData.append('screenshot', file);
        
        const fullUrl = `${API_CONFIG.BASE_URL}/api/verify-screenshot`;
        
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', fullUrl);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            
            xhr.timeout = API_CONFIG.TIMEOUT;
            xhr.ontimeout = () => {
                this.recordFailure('/api/verify-screenshot');
                reject(new Error('Upload timeout - server may be down'));
            };
            
            xhr.onerror = () => {
                this.recordFailure('/api/verify-screenshot');
                reject(new Error('Upload failed - network error'));
            };
            
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    this.recordSuccess('/api/verify-screenshot');
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(new Error('Invalid response format'));
                    }
                } else {
                    this.recordFailure('/api/verify-screenshot');
                    reject(new Error(`Upload failed: HTTP ${xhr.status}`));
                }
            };
            
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const progress = Math.round((event.loaded / event.total) * 100);
                    console.log(`📤 Upload progress: ${progress}%`);
                }
            };
            
            xhr.send(formData);
        });
    }
    
    getStatus() {
        return {
            serverHealthy: this.serverHealthy,
            isOffline: this.isOffline,
            lastHealthCheck: this.lastHealthCheck,
            pendingRequests: this.pendingRequests.length,
            cachedItems: this.cache.size,
            circuitBreakers: Object.fromEntries(
                Array.from(this.circuitBreaker.entries()).map(([k, v]) => [k, v.state])
            )
        };
    }
}

// ============================================================================
// GLOBAL INSTANCE
// ============================================================================

const apiManager = new APIManager();
window.apiManager = apiManager;

console.log('✅ API Manager initialized - Railway server resilience enabled');
