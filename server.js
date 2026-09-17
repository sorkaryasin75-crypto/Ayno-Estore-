/**
 * ============================================================================
 * AYNO STORE - FULL ASYNC BACKEND SERVER WITH SYSTEM CONTROL ADMIN PANEL
 * ============================================================================
 * Features Included:
 * - Express.js Server with Trust Proxy (Railway compatible)
 * - Async Read/Write Database Operations
 * - HMAC SHA-256 Telegram WebApp Security & Authentication
 * - Async Admin Control API Endpoints (Stats, User Balance, Order Management)
 * - Integration with Custom api-handler Module
 * - Telegram Bot Integration (Polling & Webhook Modes)
 * ============================================================================
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Custom API Handler Router Module
const apiHandler = require('./api-handler');

const app = express();

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'ayno_store_secret_jwt_key';
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '6246632270').split(',').map(id => Number(id.trim())).filter(Boolean);
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const AUTO_APPROVE_UPLOADS = (process.env.AUTO_APPROVE_UPLOADS || 'false').toLowerCase() === 'true';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============================================================================
// DATABASE & ASYNC PERSISTENCE
// ============================================================================

let db = {
  users: {},
  orders: [],
  withdrawals: [],
  verifications: [],
  transactions: [],
  products: [
    { id: 'p1', name: 'NordVPN Premium', category: 'vpn', price: 30, stock: true, plans: [{ name: '1 Month', price: 30 }, { name: '6 Months', price: 150 }] },
    { id: 'p2', name: 'Residential Proxy', category: 'proxy', price: 150, stock: true, plans: [] },
    { id: 'p3', name: 'Outlook / Hotmail Mail', category: 'mail', price: 1, stock: true, plans: [] },
    { id: 'p4', name: 'Telegram Premium', category: 'app', price: 250, stock: true, plans: [] },
    { id: 'p5', name: 'USA Virtual Number', category: 'number', price: 8, stock: true, plans: [] }
  ],
  settings: {
    maintenance: false,
    minWithdraw: 50
  }
};

async function loadDataAsync() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = Object.assign(db, parsed);
      db.users = db.users || {};
      db.orders = db.orders || [];
      db.withdrawals = db.withdrawals || [];
      db.verifications = db.verifications || [];
      db.transactions = db.transactions || [];
      console.log('✅ Async Database loaded successfully');
    } else {
      await saveDataAsync(false);
    }
  } catch (e) {
    console.error('❌ Failed to load async data file, using defaults', e);
  }
}

let saveTimeout = null;
function saveDataAsync(debounce = true) {
  return new Promise((resolve) => {
    if (debounce) {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        await writeDataFileAsync();
        resolve();
      }, 200);
    } else {
      writeDataFileAsync().then(resolve);
    }
  });
}

async function writeDataFileAsync() {
  try {
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.promises.rename(tmp, DATA_FILE);
  } catch (e) {
    console.error('❌ Failed to write async data file', e);
  }
}

// Initial Async Load
loadDataAsync();

// ============================================================================
// MIDDLEWARE CONFIGURATION
// ============================================================================

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(morgan('tiny'));

// ============================================================================
// RATE LIMITING
// ============================================================================

const createLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.path === '/api/health',
    keyGenerator: (req) => {
      return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
             req.socket?.remoteAddress || 
             req.ip || 
             'unknown';
    }
  });
};

const apiLimiter = createLimiter(15 * 60 * 1000, 200, 'Too many API requests');
const authLimiter = createLimiter(15 * 60 * 1000, 20, 'Too many auth attempts');
const uploadLimiter = createLimiter(60 * 60 * 1000, 10, 'Too many uploads');

// Static File Hosting
app.use(express.static(__dirname, { maxAge: '1h' }));
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR), { maxAge: '7d' }));

// ============================================================================
// TELEGRAM AUTHENTICATION & SECURITY HELPERS
// ============================================================================

const verifyTelegramInitData = (initData) => {
  if (!initData || !TELEGRAM_BOT_TOKEN) return false;
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return false;
    return JSON.parse(urlParams.get('user') || '{}');
  } catch (err) {
    return false;
  }
};

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Token missing' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
  }
};

const requireAdminAuth = async (req, res, next) => {
  try {
    const initData = req.headers['x-telegram-init-data'];
    const authHeader = req.headers.authorization;

    let tgUser = verifyTelegramInitData(initData);

    if (!tgUser && authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      tgUser = { id: Number(decoded.tgId) };
    }

    if (!tgUser || !tgUser.id) {
      return res.status(401).json({ success: false, error: "Unauthorized: Invalid Telegram Auth" });
    }

    if (!ADMIN_IDS.includes(Number(tgUser.id))) {
      return res.status(403).json({ success: false, error: "Forbidden: Admin access required" });
    }

    req.adminUser = tgUser;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: "Authentication failed" });
  }
};

// ============================================================================
// SYSTEM CONTROL & ADMIN API ENDPOINTS (FULL ASYNC)
// ============================================================================

// 1. Auto Login via Telegram InitData
app.post('/api/auth/telegram-login', authLimiter, async (req, res) => {
  try {
    const { initData } = req.body || {};
    const tgUser = verifyTelegramInitData(initData);

    if (!tgUser || !tgUser.id) {
      return res.status(400).json({ success: false, error: "Invalid Telegram Auth Payload" });
    }

    const userId = String(tgUser.id);
    let user = db.users[userId];

    if (!user) {
      user = {
        tgId: userId,
        firstName: tgUser.first_name || '',
        lastName: tgUser.last_name || '',
        username: tgUser.username || '',
        balance: 0,
        role: ADMIN_IDS.includes(Number(userId)) ? 'admin' : 'user',
        createdAt: new Date().toISOString()
      };
      db.users[userId] = user;
    } else {
      user.firstName = tgUser.first_name || user.firstName;
      user.username = tgUser.username || user.username;
    }

    await saveDataAsync();

    const token = jwt.sign(
      { tgId: user.tgId, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user.tgId,
        tgId: user.tgId,
        name: `${user.firstName} ${user.lastName || ''}`.trim(),
        username: user.username,
        balance: user.balance,
        role: user.role
      }
    });
  } catch (error) {
    console.error('❌ Async Login Error:', error);
    res.status(500).json({ success: false, error: 'Login process failed' });
  }
});

// 2. Admin Dashboard Live Stats
app.get('/api/admin/dashboard-stats', apiLimiter, requireAdminAuth, async (req, res) => {
  try {
    const totalUsers = Object.keys(db.users).length;
    const pendingOrders = db.orders.filter(o => o.status === 'Pending' || o.status === 'pending').length;
    
    const totalRevenue = db.orders
      .filter(o => o.status === 'Approved' || o.status === 'approved')
      .reduce((sum, o) => sum + (Number(o.price) || 0), 0);

    res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        pendingOrders,
        totalRevenue,
        systemStatus: "Active"
      }
    });
  } catch (error) {
    console.error('❌ Dashboard stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve stats' });
  }
});

// 3. Admin Balance Control
app.post('/api/admin/user/update-balance', apiLimiter, requireAdminAuth, async (req, res) => {
  try {
    const { targetTgId, amount, action } = req.body || {};
    const userId = String(targetTgId);

    if (!userId || amount === undefined || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Valid Target ID and Amount are required' });
    }

    const user = db.users[userId];
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in system' });
    }

    const numAmount = Number(amount);
    if (action === 'add') {
      user.balance = (user.balance || 0) + numAmount;
    } else if (action === 'deduct') {
      user.balance = Math.max(0, (user.balance || 0) - numAmount);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action specified' });
    }

    db.transactions.push({
      adminTgId: req.adminUser.id,
      targetTgId: userId,
      action,
      amount: numAmount,
      newBalance: user.balance,
      timestamp: new Date().toISOString()
    });

    await saveDataAsync();

    res.status(200).json({
      success: true,
      message: `Balance updated successfully! New Balance: ৳${user.balance}`,
      newBalance: user.balance
    });
  } catch (error) {
    console.error('❌ Balance update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user balance' });
  }
});

// 4. Admin Pending Orders Stream
app.get('/api/admin/orders/pending', apiLimiter, requireAdminAuth, async (req, res) => {
  try {
    const pendingOrders = db.orders.filter(o => o.status === 'Pending' || o.status === 'pending');
    res.status(200).json({ success: true, orders: pendingOrders });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch pending orders' });
  }
});

// 5. Admin Manage Order Status
app.post('/api/admin/orders/manage', apiLimiter, requireAdminAuth, async (req, res) => {
  try {
    const { orderId, status } = req.body || {};
    const orderIndex = db.orders.findIndex(o => String(o.id) === String(orderId));

    if (orderIndex === -1) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const order = db.orders[orderIndex];
    order.status = status === 'approved' ? 'Approved' : 'Rejected';
    order.processedBy = req.adminUser.id;
    order.updatedAt = new Date().toISOString();

    // Refund if rejected and paid by balance
    if (status === 'rejected' && order.method === 'balance') {
      const user = db.users[order.userId];
      if (user) {
        user.balance = (user.balance || 0) + Number(order.price);
      }
    }

    await saveDataAsync();
    res.status(200).json({ success: true, message: `Order #${orderId} marked as ${order.status}` });
  } catch (error) {
    console.error('❌ Order management error:', error);
    res.status(500).json({ success: false, error: 'Failed to update order status' });
  }
});

// Register api-handler Router
if (typeof apiHandler.registerExpressRoutes === 'function') {
  apiHandler.registerExpressRoutes(app);
}

// ============================================================================
// STANDARD PUBLIC APIS
// ============================================================================

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.processUptime?.() || 0, timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'healthy', server: 'running', database: 'connected', timestamp: new Date().toISOString() });
});

app.get('/api/app-data', apiLimiter, async (req, res) => {
  res.status(200).json({ success: true, products: db.products, settings: db.settings });
});

app.get('/api/data', apiLimiter, async (req, res) => {
  res.status(200).json({ success: true, products: db.products, settings: db.settings });
});

app.post('/api/orders', apiLimiter, authenticate, async (req, res) => {
  try {
    const { item, price, method, trxId } = req.body || {};
    if (!item || price === undefined || !method || !trxId) {
      return res.status(400).json({ success: false, error: 'Missing required order fields' });
    }

    const newOrder = {
      id: 'AYN' + Math.floor(100000 + Math.random() * 900000),
      userId: req.user.tgId,
      item,
      price: Number(price),
      method,
      trxId,
      status: 'Pending',
      createdAt: new Date().toISOString()
    };

    db.orders.push(newOrder);
    await saveDataAsync();

    res.status(201).json({ success: true, order: newOrder });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to place order' });
  }
});

app.get('/api/orders', apiLimiter, authenticate, async (req, res) => {
  const userOrders = db.orders.filter(o => String(o.userId) === String(req.user.tgId));
  res.status(200).json({ success: true, orders: userOrders });
});

// ============================================================================
// SCREENSHOT UPLOAD & VERIFICATION
// ============================================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    if (!allowed.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  }
});

app.post('/api/verify-screenshot', uploadLimiter, authenticate, upload.single('screenshot'), async (req, res) => {
  try {
    const userId = String(req.user.tgId);
    const user = db.users[userId];
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const verification = {
      id: 'V' + Date.now(),
      userId,
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      status: AUTO_APPROVE_UPLOADS ? 'Approved' : 'Manual_Review',
      createdAt: new Date().toISOString()
    };

    db.verifications.push(verification);

    if (AUTO_APPROVE_UPLOADS) {
      user.balance = (user.balance || 0) + Number(process.env.AUTO_APPROVE_CREDIT || 100);
    }

    await saveDataAsync();
    res.status(200).json({ success: true, status: verification.status, newBalance: user.balance });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Upload process failed' });
  }
});

// ============================================================================
// TELEGRAM BOT WEBHOOK & INITIALIZATION
// ============================================================================

let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  try {
    if (WEBHOOK_URL) {
      bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
      const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
      bot.setWebHook(`${WEBHOOK_URL.replace(/\/$/, '')}${webhookPath}`);

      app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
      });
      console.log('✅ [BOT] Webhook operational');
    } else {
      bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
      console.log('✅ [BOT] Polling operational');
    }
  } catch (error) {
    console.error('❌ Telegram Bot Error:', error.message);
  }
}

// ============================================================================
// ROUTE FALLBACKS & ERROR HANDLING
// ============================================================================

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(200).send('<h1>AyNo Store Server - Active</h1>');
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'API route not found' });
  }
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).send('Page Not Found');
});

app.use((err, req, res, next) => {
  console.error('🔥 Internal Express Error:', err.stack);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// ============================================================================
// SERVER STARTUP & GRACEFUL SHUTDOWN
// ============================================================================

const server = app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   🚀 AYNO STORE ASYNC SERVER OPERATIONAL         ║
╠══════════════════════════════════════════════════╣
║ 🌐 Address: http://${HOST}:${PORT}                      ║
║ 🔒 Security & HMAC: ✅ Enabled                   ║
║ ⚡ System Control Admin API: ✅ Ready             ║
║ 🤖 Telegram Bot Engine: ${bot ? '✅ Active' : '❌ Disabled'}                 ║
╚══════════════════════════════════════════════════╝
  `);
});

const handleShutdown = async () => {
  console.log('📡 Graceful Shutdown initiated...');
  await saveDataAsync(false);
  server.close(() => {
    console.log('✅ HTTP Server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

module.exports = app;
