const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ayno_store_secret_jwt_key';
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Middleware Setup
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// In-Memory Data Store (Simulated Database)
const db = {
    users: new Map(),
    orders: [],
    withdrawals: [],
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

// Telegram Bot Setup
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;
if (botToken) {
    bot = new TelegramBot(botToken, { polling: true });
    console.log('[BOT] Telegram Bot initialized with Polling.');
} else {
    console.warn('[BOT] TELEGRAM_BOT_TOKEN missing. Admin Bot will remain offline.');
}

// Authentication Middleware
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

// File Upload Storage Engine
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });

// -----------------------------------------------------
// API ROUTES
// -----------------------------------------------------

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        maintenance: db.settings.maintenance
    });
});

// User Authentication / Sync
app.post('/api/auth/sync', (req, res) => {
    const { tgId, firstName, lastName, username } = req.body;
    const userId = tgId ? String(tgId) : `guest_${Date.now()}`;
    
    let user = db.users.get(userId);
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
            joinedAt: new Date()
        };
        db.users.set(userId, user);
    }

    const token = jwt.sign({ tgId: user.tgId, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user });
});

// Get App Initial Data
app.get('/api/app-data', (req, res) => {
    res.json({
        success: true,
        products: db.products,
        settings: db.settings
    });
});

// Create Order Endpoint
app.post('/api/orders', authenticate, (req, res) => {
    const { item, price, method, trxId } = req.body;
    if (!item || price === undefined || !method || !trxId) {
        return res.status(400).json({ success: false, error: 'Missing order details.' });
    }

    const newOrder = {
        id: 'AYN' + Math.floor(100000 + Math.random() * 900000),
        userId: req.user.tgId,
        item,
        price: Number(price),
        method,
        trxId,
        status: 'Pending',
        createdAt: new Date()
    };

    db.orders.push(newOrder);
    res.json({ success: true, order: newOrder });
});

// Verify Payment Screenshot Endpoint
app.post('/api/verify-screenshot', authenticate, upload.single('screenshot'), (req, res) => {
    const user = db.users.get(req.user.tgId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

    const isManual = Math.random() > 0.5;
    if (!isManual) {
        user.balance += 100;
        res.json({ success: true, status: 'Approved', newBalance: user.balance });
    } else {
        res.json({ success: true, status: 'Manual_Review', newBalance: user.balance });
    }
});

// Submit Withdrawal Endpoint
app.post('/api/withdraw', authenticate, (req, res) => {
    const { amount, method, accountNumber, type } = req.body;
    const user = db.users.get(req.user.tgId);
    
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (amount < db.settings.minWithdraw) {
        return res.status(400).json({ success: false, error: `Minimum withdrawal is ৳${db.settings.minWithdraw}` });
    }
    if (user.referralBalance < amount) {
        return res.status(400).json({ success: false, error: 'Insufficient referral balance' });
    }

    user.referralBalance -= amount;
    if (type === 'wallet') {
        user.balance += Number(amount);
    }

    const withdrawal = {
        id: 'WTH' + Date.now(),
        userId: user.tgId,
        amount,
        method,
        accountNumber,
        type,
        status: type === 'wallet' ? 'Completed' : 'Pending',
        createdAt: new Date()
    };
    db.withdrawals.push(withdrawal);

    res.json({ success: true, withdrawal, newBalance: user.balance, newReferralBalance: user.referralBalance });
});

// Centralized Error Handler
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack);
    res.status(500).json({
        success: false,
        error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message
        }
    });
});

// -----------------------------------------------------
// TELEGRAM ADMIN BOT LOGIC
// -----------------------------------------------------
if (bot) {
    const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));

    bot.onText(/\/(start|admin|dashboard)/, (msg) => {
        if (!isAdmin(msg.from.id)) {
            return bot.sendMessage(msg.chat.id, '⛔ Access Denied: You are not authorized to use the Admin Panel.');
        }

        const adminKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📊 Dashboard', callback_data: 'admin_dashboard' }, { text: '👥 Users', callback_data: 'admin_users' }],
                    [{ text: '⚙️ Settings', callback_data: 'admin_settings' }, { text: '📋 Orders', callback_data: 'admin_orders' }],
                    [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }, { text: '🛠️ System Health', callback_data: 'admin_status' }]
                ]
            }
        };
        bot.sendMessage(msg.chat.id, '👑 *AYNO STORE ADMIN PANEL*\nSelect an option to manage the platform:', { parse_mode: 'Markdown', ...adminKeyboard });
    });

    bot.on('callback_query', (query) => {
        const chatId = query.message.chat.id;
        if (!isAdmin(query.from.id)) {
            return bot.answerCallbackQuery(query.id, { text: 'Unauthorized!', show_alert: true });
        }

        const data = query.callback_data;
        if (data === 'admin_dashboard') {
            bot.sendMessage(chatId, `📊 *Dashboard Statistics*\n\nTotal Users: ${db.users.size}\nTotal Orders: ${db.orders.length}\nPending Withdrawals: ${db.withdrawals.filter(w => w.status === 'Pending').length}`, { parse_mode: 'Markdown' });
        } else if (data === 'admin_status') {
            bot.sendMessage(chatId, `🛠️ *System Status*\n\nUptime: ${Math.floor(process.uptime())}s\nMaintenance Mode: ${db.settings.maintenance ? 'ON' : 'OFF'}`, { parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id);
    });
}

// Server Start
app.listen(PORT, () => {
    console.log(`[SERVER] Ayno Store operational on port ${PORT}`);
});
