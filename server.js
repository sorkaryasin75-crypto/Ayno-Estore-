const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'ayno_store_secret_jwt_key';
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const AUTO_APPROVE_UPLOADS = (process.env.AUTO_APPROVE_UPLOADS || 'false').toLowerCase() === 'true';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============================================================================
// DATABASE & PERSISTENCE
// ============================================================================

let db = {
  users: {},
  orders: [],
  withdrawals: [],
  verifications: [],
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

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = Object.assign(db, parsed);
      db.users = db.users || {};
      db.orders = db.orders || [];
      db.withdrawals = db.withdrawals || [];
      db.verifications = db.verifications || [];
      console.log('✅ Data loaded from file');
    } else {
      saveData(false);
    }
  } catch (e) {
    console.error('❌ Failed to load data file, using defaults', e);
  }
}

let saveTimeout = null;
function saveData(debounce = true) {
  if (debounce) {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => writeDataFile(), 200);
  } else {
    writeDataFile();
  }
}

function writeDataFile() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('❌ Failed to save data file', e);
  }
}

loadData();

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Trust Railway proxy - CRITICAL FIX
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(morgan('tiny'));

// ============================================================================
// RATE LIMITING - FIXED FOR RAILWAY
// ============================================================================

const createLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      return req.path === '/health' || req.path === '/api/health';
    },
    keyGenerator: (req) => {
      // Use X-Forwarded-For from Railway, fallback to IP
      return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
             req.socket?.remoteAddress || 
             req.connection?.remoteAddress ||
             req.ip || 
             'unknown';
    },
    onLimitReached: (req, res, options) => {
      console.warn(`⚠️ Rate limit reached for ${req.ip}`);
    }
  });
};

const apiLimiter = createLimiter(15 * 60 * 1000, 100, 'Too many API requests');
const authLimiter = createLimiter(15 * 60 * 1000, 5, 'Too many auth attempts');
const uploadLimiter = createLimiter(60 * 60 * 1000, 10, 'Too many uploads');

// ============================================================================
// STATIC FILES
// ============================================================================

app.use(express.static(__dirname, { maxAge: '1h' }));
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR), { maxAge: '7d' }));

// ============================================================================
// ROOT ROUTE
// ============================================================================

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('<h1>Ayno Store - Backend Running</h1>');
  }
});

// ============================================================================
// HEALTH CHECKS
// ============================================================================

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    uptime: process.uptime(), 
    timestamp: new Date().toISOString(), 
    maintenance: db.settings.maintenance 
  });
});

app.head('/health', (req, res) => {
  res.status(200).send();
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    server: 'running',
    database: 'connected',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// API - APP DATA
// ============================================================================

app.get('/api/data', apiLimiter, (req, res) => {
  try {
    res.status(200).json({ 
      success: true, 
      products: db.products, 
      settings: db.settings,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error in /api/data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch data' });
  }
});

app.get('/api/app-data', apiLimiter, (req, res) => {
  try {
    res.status(200).json({ 
      success: true, 
      products: db.products, 
      settings: db.settings,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error in /api/app-data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch app data' });
  }
});

// ============================================================================
// AUTHENTICATION
// ============================================================================

const authenticate = (req, res, next) => {
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

app.post('/api/auth/sync', authLimiter, (req, res) => {
  try {
    const { tgId, firstName, lastName, username } = req.body || {};
    const userId = tgId ? String(tgId) : `guest_${Date.now()}`;
    let user = db.users[userId];
    
    if (!user) {
      user = { 
        tgId: userId, 
        firstName: firstName || 'Guest', 
        lastName: lastName || '', 
        username: username || '', 
        balance: 0, 
        referralBalance: 0, 
        totalEarned: 0, 
        referredBy: null, 
        joinedAt: new Date().toISOString() 
      };
      db.users[userId] = user;
      saveData();
    }
    
    const token = jwt.sign({ tgId: user.tgId, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ success: true, token, user });
  } catch (error) {
    console.error('❌ Auth error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
});

// ============================================================================
// ORDERS
// ============================================================================

app.post('/api/orders', apiLimiter, authenticate, (req, res) => {
  try {
    const { item, price, method, trxId, id, tgId, status, timestamp } = req.body || {};
    
    if (!item || price === undefined || !method || !trxId) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    if (typeof price !== 'number' || price < 0) {
      return res.status(400).json({ success: false, error: 'Invalid price' });
    }
    
    const newOrder = { 
      id: id || ('AYN' + Math.floor(100000 + Math.random() * 900000)), 
      userId: req.user.tgId, 
      item, 
      price: Number(price), 
      method, 
      trxId, 
      status: status || 'Pending', 
      tgId: tgId || null,
      createdAt: timestamp || new Date().toISOString() 
    };
    
    db.orders.push(newOrder);
    saveData();
    
    console.log('✅ Order created:', newOrder);
    res.status(201).json({ success: true, order: newOrder });
  } catch (error) {
    console.error('❌ Order creation error:', error);
    res.status(500).json({ success: false, error: 'Failed to create order' });
  }
});

app.get('/api/orders', apiLimiter, authenticate, (req, res) => {
  try {
    const userOrders = db.orders.filter(o => o.userId === req.user.tgId);
    res.status(200).json({ success: true, orders: userOrders });
  } catch (error) {
    console.error('❌ Fetch orders error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// ============================================================================
// MULTER FILE UPLOAD
// ============================================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Only images allowed'));
    cb(null, true);
  }
});

// ============================================================================
// SCREENSHOT VERIFICATION
// ============================================================================

app.post('/api/verify-screenshot', uploadLimiter, authenticate, upload.single('screenshot'), (req, res) => {
  try {
    const user = db.users[req.user.tgId];
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'No screenshot uploaded' });

    const verification = { 
      id: 'V' + Date.now(), 
      userId: user.tgId, 
      filename: file.filename, 
      originalName: file.originalname, 
      path: `/uploads/${file.filename}`, 
      status: AUTO_APPROVE_UPLOADS ? 'Approved' : 'Manual_Review',
      createdAt: new Date().toISOString()
    };
    db.verifications.push(verification);

    if (AUTO_APPROVE_UPLOADS) {
      const credit = Number(process.env.AUTO_APPROVE_CREDIT || 100);
      user.balance = (user.balance || 0) + credit;
      saveData();
      console.log('✅ Screenshot auto-approved:', verification.id);
      return res.status(200).json({ success: true, status: 'Approved', newBalance: user.balance });
    }

    saveData();
    console.log('✅ Screenshot queued for review:', verification.id);
    res.status(200).json({ success: true, status: 'Manual_Review', newBalance: user.balance });
  } catch (error) {
    console.error('❌ Screenshot verification error:', error);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// ============================================================================
// ERROR LOGGING
// ============================================================================

app.post('/api/logs/error', apiLimiter, (req, res) => {
  try {
    const { message, type, stack, timestamp } = req.body;
    console.error(`📋 Client Error [${type}]:`, { message, stack, timestamp });
    res.status(200).json({ success: true, message: 'Error logged' });
  } catch (error) {
    console.error('❌ Error logging:', error);
    res.status(500).json({ success: false, error: 'Failed to log error' });
  }
});

// ============================================================================
// TELEGRAM BOT
// ============================================================================

let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  try {
    if (WEBHOOK_URL) {
      bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
      bot.setWebHook(`${WEBHOOK_URL.replace(/\/$/, '')}/bot${TELEGRAM_BOT_TOKEN}`)
        .then(() => console.log('✅ [BOT] Webhook configured'))
        .catch(e => console.warn('⚠️ [BOT] Webhook error:', e.message));
    } else {
      bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
      console.log('✅ [BOT] Telegram Bot initialized with Polling');
    }
  } catch (error) {
    console.error('❌ [BOT] Initialization error:', error.message);
    bot = null;
  }
}

// ============================================================================
// 404 & ERROR HANDLER
// ============================================================================

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ success: false, error: 'API endpoint not found', path: req.path });
  } else {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ success: false, error: 'Not found' });
    }
  }
});

app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err.stack);
  res.status(err.status || 500).json({ 
    success: false, 
    error: process.env.NODE_ENV === 'production' ? 'Internal error' : err.message 
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const server = app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   ✅ AYNO STORE BACKEND SERVER STARTED           ║
╠══════════════════════════════════════════════════╣
║ 🌐 Server: http://${HOST}:${PORT}                       ║
║ 📦 Environment: ${(process.env.NODE_ENV || 'development').padEnd(26)} ║
║ 🔒 Trust Proxy: ✅ Enabled (Railway)             ║
║ ⚡ Rate Limiting: ✅ Enabled                     ║
║ 📂 Static Files: ✅ Ready                        ║
║ 🤖 Telegram Bot: ${bot ? '✅ Ready' : '❌ Disabled'.padEnd(28)} ║
║ 💾 Database: ✅ Connected                       ║
╚══════════════════════════════════════════════════╝
  `);
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

function shutdown() {
  console.log('📡 Shutdown signal received - closing server');
  server.close(() => {
    console.log('✅ HTTP server closed');
    if (bot && bot.stopPolling) {
      bot.stopPolling().then(() => {
        console.log('✅ Bot polling stopped');
        process.exit(0);
      }).catch(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.error('❌ Forced shutdown after 30s');
    process.exit(1);
  }, 30000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (error) => {
  console.error('🔥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('🔥 Unhandled Rejection:', reason);
  process.exit(1);
});

module.exports = app;
