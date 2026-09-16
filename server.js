const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ১. ফ্রন্টএন্ড ফাইল পরিবেশন (index.html লোড করার জন্য)
app.use(express.static(path.join(__dirname, './')));

// ২. ডাটা এবং সেটিংস API
app.get('/api/data', (req, res) => {
    res.json({
        success: true,
        user: {
            tgId: 123456789,
            firstName: "Yasin",
            lastName: "Arafat",
            username: "yasin_arafat",
            balance: 500.00,
            loyaltyPoints: 50
        },
        settings: {
            minAddBalance: 50,
            usdRate: 125,
            coinSystemEnabled: true,
            paymentMethods: [
                { id: 'bk', name: 'Bkash', number: '01712345678' },
                { id: 'ng', name: 'Nagad', number: '01712345678' }
            ]
        },
        products: [
            {
                id: 'vpn-1',
                name: 'NordVPN Premium',
                category: 'vpn',
                price: 50,
                stock: true,
                plans: [
                    { name: '1 Month', price: 50 },
                    { name: '1 Year', price: 350 }
                ]
            }
        ],
        orders: []
    });
});

// ৩. অর্ডার সাবমিট API
app.post('/api/orders', (req, res) => {
    const orderData = req.body;
    console.log("New Order Received:", orderData);
    
    res.json({
        success: true,
        order: {
            ...orderData,
            status: 'Pending',
            date: new Date().toISOString()
        }
    });
});

// ৪. পেমেন্ট স্ক্রিনশট বা ভেরিফিকেশন API
app.post('/api/verify-screenshot', (req, res) => {
    res.json({
        success: true,
        newBalance: 1000.00,
        status: 'Approved'
    });
});

// ফলব্যাক রুট (index.html রিটার্ন করার জন্য)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running successfully on port ${PORT}`);
});
