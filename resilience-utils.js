/**
 * ============================================================================
 * AYNO STORE - RESILIENCE & FAULT TOLERANCE UTILITIES
 * ============================================================================
 * Comprehensive error handling, validation, retry logic, circuit breaker,
 * rate limiting, and health monitoring for production stability
 * ============================================================================
 */

// ============================================================================
// 1. GLOBAL ERROR HANDLERS
// ============================================================================

window.appErrorLogs = [];
const MAX_ERROR_LOGS = 100;

/**
 * Global error handler for uncaught JavaScript errors
 */
window.addEventListener('error', (event) => {
    const errorData = {
        type: 'javascript_error',
        message: event.message || 'Unknown error',
        filename: event.filename || 'Unknown file',
        lineno: event.lineno || 0,
        colno: event.colno || 0,
        stack: event.error?.stack || '',
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent
    };
    
    console.error('🔥 [GLOBAL ERROR]', errorData);
    logErrorToServer(errorData);
    showNotification('An error occurred. Our team has been notified.', 'error');
});

/**
 * Global handler for unhandled promise rejections
 */
window.addEventListener('unhandledrejection', (event) => {
    const errorData = {
        type: 'unhandled_rejection',
        message: event.reason?.message || String(event.reason),
        reason: String(event.reason),
        stack: event.reason?.stack || '',
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent
    };
    
    console.error('🔥 [UNHANDLED REJECTION]', errorData);
    logErrorToServer(errorData);
    showNotification('Connection error. Please refresh the page.', 'error');
    event.preventDefault(); // Prevent app crash
});

/**
 * Log errors to server with fallback to localStorage
 */
async function logErrorToServer(errorData) {
    try {
        await fetchWithTimeout('/api/logs/error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorData)
        }, 5000); // 5s timeout
    } catch (e) {
        console.warn('⚠️ Failed to send error log to server:', e.message);
        // Fallback: Store in localStorage
        const errorLogs = JSON.parse(localStorage.getItem('errorLogs') || '[]');
        errorLogs.push(errorData);
        localStorage.setItem('errorLogs', JSON.stringify(errorLogs.slice(-MAX_ERROR_LOGS)));
    }
}

// ============================================================================
// 2. NOTIFICATION SYSTEM
// ============================================================================

function showNotification(message, type = 'info', duration = 4000) {
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    // Create or use existing notification container
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 9998;
            max-width: 400px;
        `;
        document.body.appendChild(container);
    }
    
    // Create notification element
    const notification = document.createElement('div');
    const bgColors = {
        'error': '#DC2626',
        'warning': '#F97316',
        'success': '#16A34A',
        'info': '#0EA5E9'
    };
    
    notification.style.cssText = `
        background: ${bgColors[type] || bgColors['info'}};
        color: white;
        padding: 16px;
        border-radius: 8px;
        margin-bottom: 10px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: slideIn 0.3s ease-out;
        word-wrap: break-word;
        font-weight: 500;
    `;
    notification.textContent = message;
    container.appendChild(notification);
    
    // Auto remove
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

// Add animation styles
if (!document.getElementById('notification-styles')) {
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(400px);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);
}

// ============================================================================
// 3. INPUT VALIDATION & SANITIZATION
// ============================================================================

function validateTransactionId(trxId) {
    const sanitized = String(trxId || '').trim();
    
    if (sanitized.length === 0) {
        return { valid: false, error: 'Transaction ID is required' };
    }
    if (sanitized.length > 100) {
        return { valid: false, error: 'Transaction ID is too long (max 100 characters)' };
    }
    if (!/^[a-zA-Z0-9\-_#/.]+$/.test(sanitized)) {
        return { valid: false, error: 'Transaction ID contains invalid characters' };
    }
    
    return { valid: true, value: sanitized };
}

function validateScreenshot(file) {
    if (!file) return { valid: false, error: 'No file selected' };
    
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
    
    // Check file size
    if (file.size === 0) {
        return { valid: false, error: 'File is empty' };
    }
    if (file.size > MAX_SIZE) {
        return { valid: false, error: 'File too large (max 5MB)' };
    }
    
    // Check MIME type
    if (!ALLOWED_TYPES.includes(file.type)) {
        return { valid: false, error: 'Invalid file type (JPEG, PNG, WebP only)' };
    }
    
    // Check file extension
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
        return { valid: false, error: 'Invalid file extension' };
    }
    
    return { valid: true, file: file };
}

function validatePlanData(plan) {
    if (!plan || typeof plan !== 'object') {
        return { valid: false, error: 'Invalid plan data' };
    }
    if (typeof plan.name !== 'string' || plan.name.trim().length === 0) {
        return { valid: false, error: 'Plan name is missing' };
    }
    if (typeof plan.price !== 'number' || plan.price < 0) {
        return { valid: false, error: 'Invalid plan price' };
    }
    return { valid: true, plan: plan };
}

function validatePaymentMethod(method) {
    if (!method || typeof method !== 'object') {
        return { valid: false, error: 'Invalid payment method' };
    }
    if (typeof method.name !== 'string' || method.name.trim().length === 0) {
        return { valid: false, error: 'Payment method name is missing' };
    }
    return { valid: true, method: method };
}

// ============================================================================
// 4. ENHANCED FETCH WITH TIMEOUT & RETRY
// ============================================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
    }
}

async function fetchWithRetry(url, options = {}, config = {}) {
    const {
        maxRetries = 3,
        retryDelay = 1000,
        backoffMultiplier = 1.5,
        timeoutMs = 15000,
        shouldRetry = (error, attempt) => true
    } = config;
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchWithTimeout(url, options, timeoutMs);
            return response;
        } catch (error) {
            lastError = error;
            
            if (attempt < maxRetries && shouldRetry(error, attempt)) {
                const delay = retryDelay * Math.pow(backoffMultiplier, attempt);
                console.log(`🔄 Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    
    throw lastError;
}

// ============================================================================
// 5. CIRCUIT BREAKER PATTERN
// ============================================================================

class CircuitBreaker {
    constructor(name, threshold = 5, timeout = 60000) {
        this.name = name;
        this.failureCount = 0;
        this.successCount = 0;
        this.threshold = threshold;
        this.timeout = timeout;
        this.state = 'CLOSED'; // CLOSED -> OPEN -> HALF_OPEN
        this.nextAttemptTime = 0;
        this.lastError = null;
    }
    
    async execute(fn, fallback = null) {
        if (this.state === 'OPEN') {
            const timeUntilRetry = Math.max(0, this.nextAttemptTime - Date.now());
            if (timeUntilRetry > 0) {
                console.warn(`⚠️ [${this.name}] Circuit breaker OPEN. Retry in ${Math.ceil(timeUntilRetry / 1000)}s`);
                if (fallback) return fallback();
                throw new Error(`Circuit breaker OPEN for ${this.name}`);
            }
            
            this.state = 'HALF_OPEN';
            console.log(`⚡ [${this.name}] Attempting recovery...`);
        }
        
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure(error);
            throw error;
        }
    }
    
    onSuccess() {
        this.failureCount = 0;
        if (this.state === 'HALF_OPEN') {
            this.state = 'CLOSED';
            console.log(`✅ [${this.name}] Circuit breaker CLOSED - recovered!`);
        }
    }
    
    onFailure(error) {
        this.failureCount++;
        this.lastError = error;
        
        if (this.failureCount >= this.threshold) {
            this.state = 'OPEN';
            this.nextAttemptTime = Date.now() + this.timeout;
            console.error(`🚫 [${this.name}] Circuit breaker OPEN for ${this.timeout / 1000}s`);
        }
    }
    
    getStatus() {
        return {
            name: this.name,
            state: this.state,
            failureCount: this.failureCount,
            threshold: this.threshold,
            lastError: this.lastError?.message || null
        };
    }
}

// Create circuit breakers for critical APIs
const apiBreakers = {
    orders: new CircuitBreaker('orders', 3, 30000),
    payments: new CircuitBreaker('payments', 3, 30000),
    userData: new CircuitBreaker('userData', 5, 60000),
    appData: new CircuitBreaker('appData', 3, 30000)
};

// ============================================================================
// 6. RATE LIMITER
// ============================================================================

class RateLimiter {
    constructor(maxAttempts = 3, windowMs = 10000) {
        this.maxAttempts = maxAttempts;
        this.windowMs = windowMs;
        this.attempts = [];
    }
    
    isAllowed() {
        const now = Date.now();
        this.attempts = this.attempts.filter(time => now - time < this.windowMs);
        
        if (this.attempts.length < this.maxAttempts) {
            this.attempts.push(now);
            return true;
        }
        
        return false;
    }
    
    getRemainingTime() {
        if (this.attempts.length === 0) return 0;
        const oldestAttempt = this.attempts[0];
        const elapsed = Date.now() - oldestAttempt;
        return Math.max(0, this.windowMs - elapsed);
    }
    
    reset() {
        this.attempts = [];
    }
}

const rateLimiters = {
    submitPayment: new RateLimiter(1, 3000), // 1 attempt per 3 seconds
    addBalance: new RateLimiter(2, 5000), // 2 attempts per 5 seconds
    apiRequest: new RateLimiter(10, 1000) // 10 requests per second
};

// ============================================================================
// 7. HEALTH MONITOR
// ============================================================================

class HealthMonitor {
    constructor(checkInterval = 30000, healthCheckUrl = '/api/health') {
        this.checkInterval = checkInterval;
        this.healthCheckUrl = healthCheckUrl;
        this.isHealthy = true;
        this.checkTimer = null;
        this.lastCheckTime = null;
        this.failureCount = 0;
        this.maxFailures = 3;
    }
    
    start() {
        console.log('🏥 Health monitor started');
        this.performHealthCheck();
        this.checkTimer = setInterval(() => this.performHealthCheck(), this.checkInterval);
    }
    
    stop() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
            console.log('🏥 Health monitor stopped');
        }
    }
    
    async performHealthCheck() {
        try {
            const response = await Promise.race([
                fetchWithTimeout(this.healthCheckUrl, { method: 'HEAD' }, 5000),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Health check timeout')), 5000)
                )
            ]);
            
            if (response.ok) {
                this.setHealthy(true);
            } else {
                this.setHealthy(false);
            }
        } catch (error) {
            console.warn('⚠️ Health check failed:', error.message);
            this.failureCount++;
            
            if (this.failureCount >= this.maxFailures) {
                this.setHealthy(false);
                this.failureCount = 0; // Reset for next cycle
            }
        }
        
        this.lastCheckTime = new Date().toISOString();
    }
    
    setHealthy(status) {
        if (this.isHealthy === status) return;
        
        this.isHealthy = status;
        this.failureCount = 0;
        
        if (status) {
            console.log('✅ Backend is healthy');
            this.onReconnect();
        } else {
            console.warn('⚠️ Backend is unhealthy');
            this.onDisconnect();
        }
    }
    
    onDisconnect() {
        const overlay = document.getElementById('health-warning-overlay');
        if (!overlay) {
            const div = document.createElement('div');
            div.id = 'health-warning-overlay';
            div.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                background: #FCA5A5;
                color: #7F1D1D;
                padding: 12px;
                text-align: center;
                z-index: 9997;
                font-weight: 600;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            `;
            div.innerHTML = `
                <i class="fa-solid fa-exclamation-triangle"></i>
                Connection issues detected. Some features may be limited.
            `;
            document.body.insertBefore(div, document.body.firstChild);
        }
        
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.style.opacity = '0.6';
            appContainer.style.pointerEvents = 'none';
        }
    }
    
    onReconnect() {
        const overlay = document.getElementById('health-warning-overlay');
        if (overlay) overlay.remove();
        
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.style.opacity = '1';
            appContainer.style.pointerEvents = 'auto';
        }
        
        showNotification('✅ Connection restored', 'success', 3000);
    }
    
    getStatus() {
        return {
            isHealthy: this.isHealthy,
            lastCheckTime: this.lastCheckTime,
            failureCount: this.failureCount
        };
    }
}

// ============================================================================
// 8. SAFE DATA ACCESS HELPERS
// ============================================================================

function safeGet(obj, path, defaultValue = null) {
    try {
        const value = path.split('.').reduce((current, key) => current?.[key], obj);
        return value !== undefined ? value : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}

function safeJsonParse(jsonString, defaultValue = null) {
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        console.warn('⚠️ JSON parse error:', e.message);
        return defaultValue;
    }
}

function safeJsonStringify(obj, defaultValue = '{}') {
    try {
        return JSON.stringify(obj);
    } catch (e) {
        console.warn('⚠️ JSON stringify error:', e.message);
        return defaultValue;
    }
}

// ============================================================================
// 9. LOCAL STORAGE HELPERS WITH FALLBACK
// ============================================================================

class SafeStorage {
    static setItem(key, value) {
        try {
            localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('⚠️ Storage set failed:', e.message);
            return false;
        }
    }
    
    static getItem(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.warn('⚠️ Storage get failed:', e.message);
            return defaultValue;
        }
    }
    
    static removeItem(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            console.error('⚠️ Storage remove failed:', e.message);
            return false;
        }
    }
    
    static clear() {
        try {
            localStorage.clear();
            return true;
        } catch (e) {
            console.error('⚠️ Storage clear failed:', e.message);
            return false;
        }
    }
}

// ============================================================================
// 10. INITIALIZATION
// ============================================================================

// Start health monitor when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ Resilience utilities loaded');
    
    // Uncomment to enable health monitoring
    // const healthMonitor = new HealthMonitor(30000);
    // healthMonitor.start();
    // window.healthMonitor = healthMonitor;
});

// Export for use in other scripts
window.resilience = {
    showNotification,
    validateTransactionId,
    validateScreenshot,
    validatePlanData,
    validatePaymentMethod,
    fetchWithTimeout,
    fetchWithRetry,
    CircuitBreaker,
    RateLimiter,
    HealthMonitor,
    apiBreakers,
    rateLimiters,
    safeGet,
    safeJsonParse,
    safeJsonStringify,
    SafeStorage,
    logErrorToServer
};

console.log('🛡️ Resilience framework initialized:', window.resilience);
