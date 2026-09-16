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

const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// ফিক্স: Railway তে index.html নিশ্চিতভাবে লোড করার জন্য স্পেসিফিক রুট
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const db = {
    users: new Map(),
    orders: [],
    withdrawals: [],
    products: [
        { id: 'p1', name: 'NordVPN Premium', category: 'vpn', price: 30, stock: true, plans: [{ name: '1 Month', price: 30 }, { name: '6 Months', price: 150 }] }
    ],
    settings: { maintenance: false, minWithdraw: 50 }
};

const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;
if (botToken) {
    bot = new TelegramBot(botToken, { polling: true });
}

const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Token missing' });
    }
    try {
        req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
    }
};

app.get('/health', (req, res) => res.status(200).json({ status: 'UP' }));

// ফিক্স: Railway এর জন্য 0.0.0.0 হোস্টে পোর্ট লিসেন করা বাধ্যতামূলক
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Ayno Store operational on port ${PORT}`);
});
