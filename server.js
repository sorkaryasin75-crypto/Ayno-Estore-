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

// Configuration
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

// Simple file-backed persistence (atomic write)
let db = {
  users: {},
  orders: [],
  withdrawals: [],
  verifications: [], // uploaded screenshots waiting approval/history
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
      // Merge into default db to avoid missing keys
      db = Object.assign(db, parsed);
      // ensure users is object
      db.users = db.users || {};
      db.orders = db.orders || [];
      db.withdrawals = db.withdrawals || [];
      db.verifications = db.verifications || [];
    } else {
      saveData();
    }
  } catch (e) {
    console.error('[DATA] Failed to load data file, using defaults', e);
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
    console.error('[DATA] Failed to save data file', e);
  }
}

loadData();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

// Basic rate limiter
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// Serve static files (index.html and assets)
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

// Root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// JWT auth middleware
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

// Multer setup with limits and file filter
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Only images are allowed (png, jpg, jpeg, webp)'));
    cb(null, true);
  }
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'UP', uptime: process.uptime(), timestamp: new Date().toISOString(), maintenance: db.settings.maintenance });
});

// -------------------- API --------------------
// Auth sync
app.post('/api/auth/sync', (req, res) => {
  const { tgId, firstName, lastName, username } = req.body || {};
  const userId = tgId ? String(tgId) : `guest_${Date.now()}`;
  let user = db.users[userId];
  if (!user) {
    user = { tgId: userId, firstName: firstName || 'Guest', lastName: lastName || '', username: username || '', balance: 0, referralBalance: 0, totalEarned: 0, referredBy: null, joinedAt: new Date().toISOString() };
    db.users[userId] = user;
    saveData();
  }
  const token = jwt.sign({ tgId: user.tgId, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user });
});

// App data
app.get('/api/app-data', (req, res) => {
  res.json({ success: true, products: db.products, settings: db.settings });
});

// Create order
app.post('/api/orders', authenticate, (req, res) => {
  const { item, price, method, trxId } = req.body || {};
  if (!item || price === undefined || !method || !trxId) return res.status(400).json({ success: false, error: 'Missing order details.' });
  const newOrder = { id: 'AYN' + Math.floor(100000 + Math.random() * 900000), userId: req.user.tgId, item, price: Number(price), method, trxId, status: 'Pending', createdAt: new Date().toISOString() };
  db.orders.push(newOrder);
  saveData();
  res.json({ success: true, order: newOrder });
});

// Verify screenshot upload
app.post('/api/verify-screenshot', authenticate, upload.single('screenshot'), (req, res) => {
  const user = db.users[req.user.tgId];
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, error: 'No screenshot uploaded.' });

  const verification = { id: 'V' + Date.now(), userId: user.tgId, filename: file.filename, originalName: file.originalname, path: `/uploads/${file.filename}`, status: AUTO_APPROVE_UPLOADS ? 'Approved' : 'Manual_Review', createdAt: new Date().toISOString() };
  db.verifications.push(verification);

  if (AUTO_APPROVE_UPLOADS) {
    // credit a default amount for approved uploads (configurable)
    const credit = Number(process.env.AUTO_APPROVE_CREDIT || 100);
    user.balance = (user.balance || 0) + credit;
    saveData();
    return res.json({ success: true, status: 'Approved', newBalance: user.balance });
  }

  // Notify admins via Telegram if bot is active
  if (bot) {
    const admins = ADMIN_IDS.slice(0, 10);
    admins.forEach(adminId => {
      try {
        bot.sendMessage(adminId, `📸 New screenshot verification requested\nID: ${verification.id}\nUser: ${user.firstName} (${user.tgId})\nPath: ${verification.path}`, { disable_notification: true });
        const filePath = path.join(UPLOAD_DIR, file.filename);
        bot.sendPhoto(adminId, filePath, { caption: `Verification ${verification.id} — approve with /approve_ver ${verification.id} or reject with /reject_ver ${verification.id}` });
      } catch (e) {
        console.warn('[BOT] Failed to notify admin', e);
      }
    });
  }
  saveData();
  res.json({ success: true, status: 'Manual_Review', newBalance: user.balance });
});

// Submit withdrawal
app.post('/api/withdraw', authenticate, (req, res) => {
  const { amount, method, accountNumber, type } = req.body || {};
  const user = db.users[req.user.tgId];
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });
  if (numericAmount < db.settings.minWithdraw) return res.status(400).json({ success: false, error: `Minimum withdrawal is ৳${db.settings.minWithdraw}` });
  if ((user.referralBalance || 0) < numericAmount) return res.status(400).json({ success: false, error: 'Insufficient referral balance' });

  user.referralBalance = (user.referralBalance || 0) - numericAmount;
  if (type === 'wallet') user.balance = (user.balance || 0) + numericAmount;

  const withdrawal = { id: 'WTH' + Date.now(), userId: user.tgId, amount: numericAmount, method, accountNumber, type, status: type === 'wallet' ? 'Completed' : 'Pending', createdAt: new Date().toISOString() };
  db.withdrawals.push(withdrawal);
  saveData();
  res.json({ success: true, withdrawal, newBalance: user.balance, newReferralBalance: user.referralBalance });
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : (err && err.message) || String(err) } });
});

// -------------------- Telegram Bot --------------------
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  if (WEBHOOK_URL) {
    // webhook mode (developer must configure WEBHOOK_URL correctly)
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
    bot.setWebHook(`${WEBHOOK_URL.replace(/\/$/, '')}/bot${TELEGRAM_BOT_TOKEN}`).then(() => console.log('[BOT] Webhook set')).catch(e => console.warn('[BOT] Webhook set failed', e));
  } else {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log('[BOT] Telegram Bot initialized with Polling.');
  }

  const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, '⛔ Access Denied: Authorized admins only.');
    const adminKeyboard = { reply_markup: { inline_keyboard: [ [{ text: '📊 Dashboard', callback_data: 'admin_dashboard' }, { text: '👥 Users', callback_data: 'admin_users' }], [{ text: '⚙️ Settings', callback_data: 'admin_settings' }, { text: '📋 Orders', callback_data: 'admin_orders' }], [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }, { text: '🛠️ System Health', callback_data: 'admin_status' }] ] } };
    bot.sendMessage(chatId, '👑 *AYNO STORE ADMIN PANEL*\nSelect an option:', { parse_mode: 'Markdown', ...adminKeyboard });
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: 'Unauthorized!', show_alert: true });
    const data = query.data;
    if (data === 'admin_dashboard') {
      const totalUsers = Object.keys(db.users).length;
      const totalOrders = db.orders.length;
      const pendingWithdrawals = db.withdrawals.filter(w => w.status === 'Pending').length;
      const pendingVerifications = db.verifications.filter(v => v.status === 'Manual_Review').length;
      await bot.sendMessage(chatId, `📊 *Dashboard Statistics*\n\nTotal Users: ${totalUsers}\nTotal Orders: ${totalOrders}\nPending Withdrawals: ${pendingWithdrawals}\nPending Verifications: ${pendingVerifications}`, { parse_mode: 'Markdown' });
    } else if (data === 'admin_status') {
      await bot.sendMessage(chatId, `🛠️ *System Status*\n\nUptime: ${Math.floor(process.uptime())}s\nMaintenance Mode: ${db.settings.maintenance ? 'ON' : 'OFF'}`, { parse_mode: 'Markdown' });
    } else if (data === 'admin_users') {
      const keys = Object.keys(db.users).slice(0, 50);
      if (keys.length === 0) return bot.sendMessage(chatId, 'No users found');
      let text = '*Users (up to 50):*\n';
      keys.forEach(k => {
        const u = db.users[k];
        text += `\n• ${u.firstName || ''} (${u.tgId}) — Balance: ৳${u.balance || 0} — Referral: ৳${u.referralBalance || 0}`;
      });
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } else if (data === 'admin_orders') {
      const recent = db.orders.slice(-20).reverse();
      if (recent.length === 0) return bot.sendMessage(chatId, 'No orders');
      let text = '*Recent Orders:*\n';
      recent.forEach(o => { text += `\n• ${o.id} — ${o.item} — ৳${o.price} — ${o.status}`; });
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } else if (data === 'admin_broadcast') {
      await bot.sendMessage(chatId, 'Send broadcast using /broadcast Your message here');
    } else if (data === 'admin_settings') {
      await bot.sendMessage(chatId, `Settings:\nMaintenance: ${db.settings.maintenance ? 'ON' : 'OFF'}\nMinWithdraw: ৳${db.settings.minWithdraw}`);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
  });

  // Approve/reject verifications via commands
  bot.onText(/\/approve_ver (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Unauthorized');
    const verId = (match && match[1]) || '';
    const v = db.verifications.find(x => x.id === verId);
    if (!v) return bot.sendMessage(chatId, 'Verification not found');
    if (v.status === 'Approved') return bot.sendMessage(chatId, 'Already approved');
    v.status = 'Approved';
    const user = db.users[v.userId];
    const credit = Number(process.env.ADMIN_APPROVE_CREDIT || 100);
    if (user) { user.balance = (user.balance || 0) + credit; }
    saveData();
    bot.sendMessage(chatId, `Verification ${verId} approved. Credited ৳${credit} to user ${v.userId}`);
    if (user) bot.sendMessage(v.userId, `✅ Your payment screenshot (${verId}) has been approved. ৳${credit} credited to your balance.`).catch(()=>{});
  });

  bot.onText(/\/reject_ver (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Unauthorized');
    const verId = (match && match[1]) || '';
    const v = db.verifications.find(x => x.id === verId);
    if (!v) return bot.sendMessage(chatId, 'Verification not found');
    v.status = 'Rejected';
    saveData();
    bot.sendMessage(chatId, `Verification ${verId} rejected.`);
    bot.sendMessage(v.userId, `❌ Your payment screenshot (${verId}) was rejected. Please try again or contact support.`).catch(()=>{});
  });

  // Broadcast: /broadcast Hello world
  bot.onText(/\/broadcast (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Unauthorized');
    const text = match[1];
    const users = Object.keys(db.users);
    bot.sendMessage(msg.chat.id, `Broadcasting to ${users.length} users (in background)`);
    users.forEach(uid => {
      setTimeout(() => {
        bot.sendMessage(uid, `📢 Broadcast from Admin:\n\n${text}`).catch(() => {});
      }, 50);
    });
  });
}

// -------------------- Server init & graceful shutdown --------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`[SERVER] Ayno Store running on http://${HOST}:${PORT}`);
});

function shutdown() {
  console.log('[SERVER] Shutdown initiated');
  server.close(() => {
    console.log('[SERVER] HTTP server closed');
    if (bot && bot.stopPolling) {
      bot.stopPolling().then(() => console.log('[BOT] Polling stopped')).catch(() => {});
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[SERVER] Forcing exit');
    process.exit(1);
  }, 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
