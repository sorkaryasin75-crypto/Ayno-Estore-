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

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.warn('⚠️ JWT_SECRET is missing/weak. Set a random secret of at least 32 characters in production.');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || crypto.randomBytes(48).toString('hex');
const ADMIN_IDS = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AUTO_APPROVE_UPLOADS = String(process.env.AUTO_APPROVE_UPLOADS || 'false').toLowerCase() === 'true';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const SMSBOWER_API_KEY = process.env.SMSBOWER_API_KEY || '';
const SMSBOWER_API_URL = process.env.SMSBOWER_API_URL || 'https://smsbower.online';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const defaultPaymentMethods = [
  { id: 'bk', name: 'bKash', number: process.env.BKASH_NUMBER || '01700000000', logoUrl: '/assets/logos/bkash.svg', enabled: true },
  { id: 'ng', name: 'Nagad', number: process.env.NAGAD_NUMBER || '01700000000', logoUrl: '/assets/logos/nagad.svg', enabled: true }
];
const defaultProducts = [
  { id:'p1', name:'NordVPN Premium', category:'vpn', price:30, stock:true, isAvailable:true, isHidden:false, logoUrl:'/assets/logos/nordvpn.svg', plans:[{name:'1 Month',price:30},{name:'6 Months',price:150}], iconClass:'fa-solid fa-shield-halved', bgClass:'bg-blue-600' },
  { id:'p2', name:'Residential Proxy', category:'proxy', price:150, pricePerGb:150, stock:true, isAvailable:true, isHidden:false, logoUrl:'/assets/logos/proxy.svg', plans:[], iconClass:'fa-solid fa-network-wired', bgClass:'bg-indigo-600' },
  { id:'p3', name:'Outlook / Hotmail Mail', category:'mail', price:1, stock:true, isAvailable:true, isHidden:false, logoUrl:'/assets/logos/outlook.svg', plans:[], iconClass:'fa-solid fa-envelope', bgClass:'bg-sky-600' },
  { id:'p4', name:'Telegram Premium', category:'app', price:250, stock:true, isAvailable:true, isHidden:false, logoUrl:'/assets/logos/telegram.svg', plans:[], iconClass:'fa-brands fa-telegram', bgClass:'bg-cyan-600' },
  { id:'p5', name:'USA Virtual Number', category:'number', price:8, stock:true, isAvailable:true, isHidden:false, logoUrl:'/assets/logos/number.svg', plans:[], iconClass:'fa-solid fa-phone', bgClass:'bg-orange-600' }
];
const defaults = {
  users:{}, orders:[], withdrawals:[], verifications:[], reviews:[], transfers:[], logs:[], coupons:[],
  products:defaultProducts,
  settings:{ maintenance:false, minWithdraw:50, minAddBalance:50, rewardEnabled:true, coinSystemEnabled:true, coinRateVpn:100, coinRateProxy:100, coinRateMail:100, referralBonus:0, paymentMethods:defaultPaymentMethods, leaderboardEnabled:true },
  smsServices:[], smsCountries:{},
};
let db = loadData();
function loadData(){
  try {
    if(fs.existsSync(DATA_FILE)) {
      const parsed=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      const merged={...defaults,...parsed};
      for(const k of Object.keys(defaults)) if(merged[k]===undefined) merged[k]=defaults[k];
      merged.settings={...defaults.settings,...(parsed.settings||{})};
      merged.products=Array.isArray(parsed.products)?parsed.products:defaults.products;
      return merged;
    }
  } catch(e){ console.error('Data load failed:',e.message); }
  writeData(defaults); return JSON.parse(JSON.stringify(defaults));
}
let saveTimer=null;
function writeData(data=db){
  try { const tmp=DATA_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(data,null,2)); fs.renameSync(tmp,DATA_FILE); }
  catch(e){ console.error('Data save failed:',e.message); }
}
function saveData(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>writeData(),150); }
function now(){return new Date().toISOString();}
function id(prefix){return prefix+Date.now().toString(36)+crypto.randomBytes(3).toString('hex');}
function bearer(req){ const h=req.headers.authorization||''; return h.startsWith('Bearer ')?h.slice(7):null; }
function signUser(user){ return jwt.sign({tgId:String(user.tgId),username:user.username||'',role:user.role||'user'},EFFECTIVE_JWT_SECRET,{expiresIn:'7d'}); }
function authenticate(req,res,next){
  const token=bearer(req); if(!token) return res.status(401).json({success:false,error:'Unauthorized: Token missing'});
  try { req.user=jwt.verify(token,EFFECTIVE_JWT_SECRET); const u=db.users[String(req.user.tgId)]; if(!u) return res.status(401).json({success:false,error:'User not found'}); req.dbUser=u; next(); }
  catch(e){ return res.status(401).json({success:false,error:'Unauthorized: Invalid token'}); }
}
function requireAdmin(req,res,next){ if(req.dbUser?.role!=='admin' && !ADMIN_IDS.has(String(req.user?.tgId))) return res.status(403).json({success:false,error:'Admin access required'}); next(); }
function sanitizeText(v,max=500){return String(v??'').replace(/[<>]/g,'').trim().slice(0,max);}
function safeNumber(v,min=0){const n=Number(v); return Number.isFinite(n)&&n>=min?n:null;}

app.set('trust proxy',1); app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({origin:true,credentials:false}));
app.use(express.json({limit:'10mb'})); app.use(express.urlencoded({extended:true,limit:'10mb'})); app.use(morgan('tiny'));
const limiter=rateLimit({windowMs:15*60*1000,max:200,standardHeaders:true,legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false});
app.use('/api/',limiter);
app.use(express.static(__dirname,{maxAge:'1h'}));
app.use('/uploads',express.static(UPLOAD_DIR,{maxAge:'7d',fallthrough:false}));

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/health',(req,res)=>res.json({status:'OK',uptime:process.uptime(),timestamp:now(),maintenance:!!db.settings.maintenance}));
app.head('/health',(req,res)=>res.status(200).end());
app.get('/api/health',(req,res)=>res.json({status:'healthy',server:'running',database:'file-json',timestamp:now(),version:'2.0.0'}));

function telegramValidate(initData){
  if(!initData || !TELEGRAM_BOT_TOKEN) return null;
  const p=new URLSearchParams(initData); const hash=p.get('hash'); if(!hash)return null; p.delete('hash');
  const dataCheck=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const calc=crypto.createHmac('sha256',secret).update(dataCheck).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(calc),Buffer.from(hash))) return null;
  const authDate=Number(p.get('auth_date')||0); if(!authDate || Date.now()/1000-authDate>86400) return null;
  try{return JSON.parse(p.get('user')||'null');}catch{return null;}
}
function upsertUser(tg){
  const uid=String(tg.id); let u=db.users[uid];
  if(!u){u={tgId:uid,firstName:sanitizeText(tg.first_name,100)||'User',lastName:sanitizeText(tg.last_name,100),username:sanitizeText(tg.username,100),photoUrl:tg.photo_url||'',balance:0,referralBalance:0,totalEarned:0,loyaltyPoints:0,referralsCount:0,referredBy:null,webNotifications:[],joinedAt:now(),role:ADMIN_IDS.has(uid)?'admin':'user',backupKey:id('BK-')}; db.users[uid]=u;}
  else {u.firstName=sanitizeText(tg.first_name,100)||u.firstName;u.lastName=sanitizeText(tg.last_name,100);u.username=sanitizeText(tg.username,100);if(tg.photo_url)u.photoUrl=tg.photo_url;if(ADMIN_IDS.has(uid))u.role='admin';}
  saveData(); return u;
}
app.post('/api/auth/telegram',authLimiter,(req,res)=>{const tg=telegramValidate(req.body?.initData);if(!tg)return res.status(401).json({success:false,error:'Invalid or expired Telegram initData'});const user=upsertUser(tg);res.json({success:true,token:signUser(user),user});});
app.post('/api/auth/sync',authLimiter,(req,res)=>{const b=req.body||{};const tgId=String(b.tgId||'');if(!tgId)return res.status(400).json({success:false,error:'Telegram ID required'});const user=upsertUser({id:tgId,first_name:b.firstName,last_name:b.lastName,username:b.username});res.json({success:true,token:signUser(user),user});});

function publicUser(u){if(!u)return null;const {backupKey,...safe}=u;return safe;}
function userOrders(uid){return db.orders.filter(o=>String(o.userId)===String(uid)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));}
app.get('/api/data',(req,res)=>{let user=null;if(bearer(req)){try{const p=jwt.verify(bearer(req),EFFECTIVE_JWT_SECRET);user=publicUser(db.users[String(p.tgId)]);}catch{}}const orders=user?userOrders(user.tgId):[];res.json({success:true,user,products:db.products,settings:db.settings,orders,withdrawals:user?db.withdrawals.filter(w=>String(w.userId)===String(user.tgId)):[],transfers:user?db.transfers.filter(t=>String(t.senderTgId)===String(user.tgId)||String(t.receiverTgId)===String(user.tgId)):[],coupons:[],stocks:{},mailStockSummary:{},webNotifications:user?.webNotifications||[],timestamp:now()});});
app.get('/api/app-data',(req,res)=>res.json({success:true,products:db.products,settings:db.settings,timestamp:now()}));

app.get('/api/orders',authenticate,(req,res)=>res.json({success:true,orders:userOrders(req.dbUser.tgId)}));
app.post('/api/orders',authenticate,(req,res)=>{
  const b=req.body||{}; const price=safeNumber(b.price); if(!b.item||price===null||!b.method||!b.trxId)return res.status(400).json({success:false,error:'Missing or invalid order fields'});
  const trx=sanitizeText(b.trxId,100); if(!/^[a-zA-Z0-9_\-#/.]+$/.test(trx))return res.status(400).json({success:false,error:'Invalid transaction ID'});
  const order={id:b.id||id('AYN'),userId:String(req.dbUser.tgId),tgId:String(req.dbUser.tgId),item:sanitizeText(b.item,300),price,method:sanitizeText(b.method,80),trxId:trx,status:'Pending',category:b.category||'',externalType:b.externalType||'',createdAt:now(),updatedAt:now()};
  db.orders.push(order); saveData(); res.status(201).json({success:true,order});
});
app.delete('/api/orders/:id',authenticate,(req,res)=>{const i=db.orders.findIndex(o=>o.id===req.params.id&&String(o.userId)===String(req.dbUser.tgId));if(i<0)return res.status(404).json({success:false,error:'Order not found'});if(['Completed','Delivered'].includes(db.orders[i].status))return res.status(400).json({success:false,error:'Completed orders cannot be deleted'});db.orders.splice(i,1);saveData();res.json({success:true});});

const storage=multer.diskStorage({destination:UPLOAD_DIR,filename:(req,file,cb)=>cb(null,Date.now()+'-'+crypto.randomBytes(8).toString('hex')+path.extname(file.originalname).toLowerCase())});
const upload=multer({storage,limits:{fileSize:5*1024*1024},fileFilter:(req,file,cb)=>{const ok=['.png','.jpg','.jpeg','.webp'].includes(path.extname(file.originalname).toLowerCase());cb(ok?null:new Error('Only JPEG, PNG and WebP images are allowed'),ok);}});
app.post('/api/verify-screenshot',authenticate,upload.single('screenshot'),(req,res)=>{if(!req.file)return res.status(400).json({success:false,error:'No screenshot uploaded'});const v={id:id('V'),userId:String(req.dbUser.tgId),filename:req.file.filename,originalName:req.file.originalname,path:'/uploads/'+req.file.filename,status:AUTO_APPROVE_UPLOADS?'Approved':'Manual_Review',createdAt:now()};db.verifications.push(v);if(AUTO_APPROVE_UPLOADS){const credit=Number(process.env.AUTO_APPROVE_CREDIT||0);req.dbUser.balance+=credit;}saveData();res.json({success:true,status:v.status,newBalance:req.dbUser.balance,verification:v});});
app.post('/api/user/avatar',authenticate,upload.single('avatar'),(req,res)=>{if(!req.file)return res.status(400).json({success:false,error:'No avatar uploaded'});req.dbUser.photoUrl='/uploads/'+req.file.filename;saveData();res.json({success:true,photoUrl:req.dbUser.photoUrl,user:publicUser(req.dbUser)});});

function findOrder(id1,uid){return db.orders.find(o=>(o.id===id1||o.externalOrderId===id1)&&String(o.userId)===String(uid));}
app.post('/api/buy-external',authenticate,async(req,res)=>{const b=req.body||{};const price=safeNumber(b.price);if(!b.externalId||price===null)return res.status(400).json({success:false,error:'externalId and valid price are required'});if(req.dbUser.balance<price)return res.status(400).json({success:false,error:'Insufficient balance'});const order={id:id('EXT'),userId:String(req.dbUser.tgId),tgId:String(req.dbUser.tgId),item:sanitizeText(b.itemName||b.externalId,300),price,method:'Wallet',status:'Processing',category:b.externalType||'external',externalType:b.externalType||'',externalId:String(b.externalId),service:b.service||'',country:b.country||'',providerId:b.providerId||'',createdAt:now(),updatedAt:now()};req.dbUser.balance-=price;db.orders.push(order);saveData();res.status(201).json({success:true,order,user:publicUser(req.dbUser),providerConfigured:!!SMSBOWER_API_KEY});});
app.post('/api/get-otp',authenticate,(req,res)=>{const o=findOrder(req.body?.orderId,req.dbUser.tgId);if(!o)return res.status(404).json({success:false,error:'Order not found'});if(!SMSBOWER_API_KEY)return res.json({success:false,status:o.status,error:'SMS provider is not configured'});res.json({success:false,status:o.status,error:'OTP polling adapter is not configured for this provider'});});
app.post('/api/cancel-order',authenticate,(req,res)=>{const o=findOrder(req.body?.internalOrderId||req.body?.orderId,req.dbUser.tgId);if(!o)return res.status(404).json({success:false,error:'Order not found'});if(['Completed','Delivered'].includes(o.status))return res.status(400).json({success:false,error:'Completed order cannot be cancelled'});o.status='Cancelled';if(o.method==='Wallet'){req.dbUser.balance+=Number(o.price||0);}o.updatedAt=now();saveData();res.json({success:true,order:o,newBalance:req.dbUser.balance});});
app.post('/api/complete-order',authenticate,(req,res)=>{const o=findOrder(req.body?.internalOrderId||req.body?.orderId,req.dbUser.tgId);if(!o)return res.status(404).json({success:false,error:'Order not found'});o.status='Completed';o.updatedAt=now();saveData();res.json({success:true,order:o});});

app.get('/api/reviews/:productId',(req,res)=>res.json({success:true,reviews:db.reviews.filter(r=>String(r.productId)===String(req.params.productId))}));
app.post('/api/reviews',authenticate,(req,res)=>{const b=req.body||{};const rating=Math.max(1,Math.min(5,Number(b.rating)||0));if(!b.productId||!rating)return res.status(400).json({success:false,error:'Product and rating required'});const r={id:id('R'),productId:String(b.productId),userId:String(req.dbUser.tgId),userName:sanitizeText(req.dbUser.firstName,80),rating,comment:sanitizeText(b.comment,500),date:now()};db.reviews.push(r);saveData();res.status(201).json({success:true,review:r});});

app.post('/api/withdraw',authenticate,(req,res)=>{const b=req.body||{};const amount=safeNumber(b.amount,1);if(amount===null||amount<Number(db.settings.minWithdraw||50))return res.status(400).json({success:false,error:`Minimum withdrawal is ${db.settings.minWithdraw||50}`});if(req.dbUser.balance<amount)return res.status(400).json({success:false,error:'Insufficient balance'});if(!b.accountNumber)return res.status(400).json({success:false,error:'Account number required'});req.dbUser.balance-=amount;const w={id:id('W'),userId:String(req.dbUser.tgId),amount,type:sanitizeText(b.type,40),method:sanitizeText(b.method,60),accountNumber:sanitizeText(b.accountNumber,50),status:'Pending',createdAt:now()};db.withdrawals.push(w);saveData();res.json({success:true,withdrawal:w,newBalance:req.dbUser.balance});});
app.post('/api/transfer',authenticate,(req,res)=>{const amount=safeNumber(req.body?.amount,1),receiver=String(req.body?.receiverTgId||'');if(!receiver||amount===null)return res.status(400).json({success:false,error:'Receiver and amount required'});const r=db.users[receiver];if(!r)return res.status(404).json({success:false,error:'Receiver not found'});if(String(r.tgId)===String(req.dbUser.tgId))return res.status(400).json({success:false,error:'Cannot transfer to yourself'});if(req.dbUser.balance<amount)return res.status(400).json({success:false,error:'Insufficient balance'});req.dbUser.balance-=amount;r.balance=(r.balance||0)+amount;const t={id:id('T'),senderTgId:String(req.dbUser.tgId),receiverTgId:receiver,amount,createdAt:now()};db.transfers.push(t);saveData();res.json({success:true,transfer:t,newBalance:req.dbUser.balance});});
app.get('/api/users/search',authenticate,(req,res)=>{const q=String(req.query.q||'').toLowerCase().replace('@','');const users=Object.values(db.users).filter(u=>String(u.username||'').toLowerCase().includes(q)&&String(u.tgId)!==String(req.dbUser.tgId)).slice(0,10).map(publicUser);res.json({success:true,users});});

app.post('/api/user/notifications/ack',authenticate,(req,res)=>{req.dbUser.webNotifications=[];saveData();res.json({success:true});});
app.post('/api/user/vpn-expiry/ack',authenticate,(req,res)=>{res.json({success:true});});
app.get('/api/user/backup-key',authenticate,(req,res)=>res.json({success:true,backupKey:req.dbUser.backupKey}));

app.post('/api/reward/claim',authenticate,(req,res)=>{if(!db.settings.rewardEnabled)return res.status(400).json({success:false,error:'Reward disabled'});if(req.dbUser.rewardClaimed)return res.status(400).json({success:false,error:'Reward already claimed'});req.dbUser.rewardClaimed=true;const coupon={id:id('C'),code:'WELCOME-'+crypto.randomBytes(3).toString('hex').toUpperCase(),type:'fixed',value:5,userId:String(req.dbUser.tgId),expiresAt:new Date(Date.now()+7*86400000).toISOString()};db.coupons.push(coupon);saveData();res.json({success:true,coupon,discountFixed:5});});
app.post('/api/reward/ignore',authenticate,(req,res)=>{req.dbUser.rewardIgnored=true;saveData();res.json({success:true});});
app.post('/api/loyalty/checkin',authenticate,(req,res)=>{const day=new Date().toISOString().slice(0,10);if(req.dbUser.lastCheckin===day)return res.status(400).json({success:false,error:'Already checked in today'});req.dbUser.lastCheckin=day;req.dbUser.loyaltyPoints=(req.dbUser.loyaltyPoints||0)+10;saveData();res.json({success:true,pointsEarned:10,loyaltyPoints:req.dbUser.loyaltyPoints});});
app.post('/api/loyalty/redeem',authenticate,(req,res)=>{const points=Math.floor(Number(req.body?.points)||0);if(points<1000||points>Number(req.dbUser.loyaltyPoints||0))return res.status(400).json({success:false,error:'Invalid points amount'});const amount=points/1000;req.dbUser.loyaltyPoints-=points;req.dbUser.balance+=amount;saveData();res.json({success:true,amountAdded:amount,newBalance:req.dbUser.balance,remainingPoints:req.dbUser.loyaltyPoints});});
app.post('/api/loyalty/scratch',authenticate,(req,res)=>{const reward=5;req.dbUser.balance+=reward;saveData();res.json({success:true,reward,amountAdded:reward,newBalance:req.dbUser.balance});});
app.get('/api/leaderboard',(req,res)=>{if(db.settings.leaderboardEnabled===false)return res.json({enabled:false,leaders:[]});const leaders=Object.values(db.users).sort((a,b)=>(b.totalEarned||0)-(a.totalEarned||0)).slice(0,20).map(u=>({tgId:u.tgId,username:u.username,firstName:u.firstName,totalEarned:u.totalEarned||0}));res.json({success:true,enabled:true,leaders});});

app.post('/api/mail/inbox',authenticate,(req,res)=>res.json({success:false,error:'Mail inbox provider is not configured'}));
app.get('/api/smsbower/services',authenticate,(req,res)=>res.json({success:true,services:db.smsServices}));
app.get('/api/smsbower/top-countries',authenticate,(req,res)=>res.json({success:true,countries:db.smsCountries[req.query.service]||[]}));
app.post('/api/tools/proxy-checker',authenticate,(req,res)=>{const port=sanitizeText(req.body?.port,200);if(!port)return res.status(400).json({success:false,error:'Proxy/port is required'});res.json({success:true,checked:port,status:'unverified',message:'Checker adapter requires a configured proxy provider'});});

app.post('/api/ai-support',async(req,res)=>{const messages=Array.isArray(req.body?.messages)?req.body.messages:[];if(!GROQ_API_KEY)return res.json({success:false,error:'AI support is not configured. Set GROQ_API_KEY.'});try{const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_API_KEY}`},body:JSON.stringify({model:GROQ_MODEL,messages,temperature:0.3,max_tokens:500})});const data=await r.json();if(!r.ok)return res.status(502).json({success:false,error:data?.error?.message||'AI provider error'});res.json({success:true,message:data.choices?.[0]?.message?.content||''});}catch(e){res.status(502).json({success:false,error:'AI provider unavailable'});}});

// ========================= ADMIN API =========================
app.get('/api/admin/me',authenticate,requireAdmin,(req,res)=>res.json({success:true,admin:publicUser(req.dbUser)}));
app.get('/api/admin/dashboard',authenticate,requireAdmin,(req,res)=>{const users=Object.values(db.users);res.json({success:true,stats:{users:users.length,products:db.products.length,orders:db.orders.length,pendingOrders:db.orders.filter(o=>o.status==='Pending').length,withdrawals:db.withdrawals.length,pendingWithdrawals:db.withdrawals.filter(w=>w.status==='Pending').length,verifications:db.verifications.length,pendingVerifications:db.verifications.filter(v=>v.status==='Manual_Review').length},recentOrders:db.orders.slice(-20).reverse(),recentWithdrawals:db.withdrawals.slice(-20).reverse()});});
app.get('/api/admin/users',authenticate,requireAdmin,(req,res)=>{const q=String(req.query.q||'').toLowerCase();const users=Object.values(db.users).filter(u=>!q||JSON.stringify(u).toLowerCase().includes(q)).map(publicUser);res.json({success:true,users});});
app.patch('/api/admin/users/:id',authenticate,requireAdmin,(req,res)=>{const u=db.users[req.params.id];if(!u)return res.status(404).json({success:false,error:'User not found'});const b=req.body||{};if(b.role)u.role=b.role==='admin'?'admin':'user';if(b.balance!==undefined){const n=safeNumber(b.balance);if(n===null)return res.status(400).json({success:false,error:'Invalid balance'});u.balance=n;}if(b.status)u.status=sanitizeText(b.status,30);saveData();res.json({success:true,user:publicUser(u)});});
app.delete('/api/admin/users/:id',authenticate,requireAdmin,(req,res)=>{if(String(req.params.id)===String(req.user.tgId))return res.status(400).json({success:false,error:'You cannot delete your own admin account'});if(!db.users[req.params.id])return res.status(404).json({success:false,error:'User not found'});delete db.users[req.params.id];saveData();res.json({success:true});});
app.get('/api/admin/products',authenticate,requireAdmin,(req,res)=>res.json({success:true,products:db.products}));
app.post('/api/admin/products',authenticate,requireAdmin,(req,res)=>{const b=req.body||{};const price=safeNumber(b.price,0);if(!b.name||price===null)return res.status(400).json({success:false,error:'Name and valid price required'});const p={id:b.id||id('P'),name:sanitizeText(b.name,200),category:sanitizeText(b.category||'app',50),price,pricePerGb:safeNumber(b.pricePerGb,0)||undefined,stock:b.stock??true,isAvailable:b.isAvailable!==false,isHidden:b.isHidden===true,logoUrl:sanitizeText(b.logoUrl||'',500),plans:Array.isArray(b.plans)?b.plans:[],iconClass:sanitizeText(b.iconClass||'fa-solid fa-box',100),bgClass:sanitizeText(b.bgClass||'bg-slate-800',100)};db.products.push(p);saveData();res.status(201).json({success:true,product:p});});
app.patch('/api/admin/products/:id',authenticate,requireAdmin,(req,res)=>{const p=db.products.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({success:false,error:'Product not found'});const b=req.body||{};for(const k of ['name','category','logoUrl','iconClass','bgClass'])if(b[k]!==undefined)p[k]=sanitizeText(b[k],500);for(const k of ['price','pricePerGb'])if(b[k]!==undefined){const n=safeNumber(b[k],0);if(n===null)return res.status(400).json({success:false,error:`Invalid ${k}`});p[k]=n;}for(const k of ['stock','isAvailable','isHidden'])if(b[k]!==undefined)p[k]=!!b[k];if(Array.isArray(b.plans))p.plans=b.plans;saveData();res.json({success:true,product:p});});
app.delete('/api/admin/products/:id',authenticate,requireAdmin,(req,res)=>{const i=db.products.findIndex(p=>p.id===req.params.id);if(i<0)return res.status(404).json({success:false,error:'Product not found'});db.products.splice(i,1);saveData();res.json({success:true});});
app.get('/api/admin/orders',authenticate,requireAdmin,(req,res)=>res.json({success:true,orders:db.orders.slice().reverse()}));
app.patch('/api/admin/orders/:id',authenticate,requireAdmin,(req,res)=>{const o=db.orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({success:false,error:'Order not found'});const status=sanitizeText(req.body?.status,50);if(status)o.status=status;o.updatedAt=now();if(req.body?.note!==undefined)o.adminNote=sanitizeText(req.body.note,500);saveData();res.json({success:true,order:o});});
app.get('/api/admin/withdrawals',authenticate,requireAdmin,(req,res)=>res.json({success:true,withdrawals:db.withdrawals.slice().reverse()}));
app.patch('/api/admin/withdrawals/:id',authenticate,requireAdmin,(req,res)=>{const w=db.withdrawals.find(x=>x.id===req.params.id);if(!w)return res.status(404).json({success:false,error:'Withdrawal not found'});const old=w.status;w.status=sanitizeText(req.body?.status||w.status,30);w.adminNote=sanitizeText(req.body?.note||'',500);if(old==='Pending'&&['Rejected','Cancelled'].includes(w.status)){const u=db.users[w.userId];if(u)u.balance+=Number(w.amount||0);}saveData();res.json({success:true,withdrawal:w});});
app.get('/api/admin/verifications',authenticate,requireAdmin,(req,res)=>res.json({success:true,verifications:db.verifications.slice().reverse()}));
app.patch('/api/admin/verifications/:id',authenticate,requireAdmin,(req,res)=>{const v=db.verifications.find(x=>x.id===req.params.id);if(!v)return res.status(404).json({success:false,error:'Verification not found'});v.status=sanitizeText(req.body?.status||v.status,30);if(req.body?.credit!==undefined){const n=safeNumber(req.body.credit,0);if(n!==null&&v.status==='Approved'&&!v.credited){const u=db.users[v.userId];if(u){u.balance+=n;v.credited=true;v.credit=n;}}}saveData();res.json({success:true,verification:v});});
app.get('/api/admin/reviews',authenticate,requireAdmin,(req,res)=>res.json({success:true,reviews:db.reviews.slice().reverse()}));
app.delete('/api/admin/reviews/:id',authenticate,requireAdmin,(req,res)=>{const i=db.reviews.findIndex(r=>r.id===req.params.id);if(i<0)return res.status(404).json({success:false,error:'Review not found'});db.reviews.splice(i,1);saveData();res.json({success:true});});
app.get('/api/admin/transfers',authenticate,requireAdmin,(req,res)=>res.json({success:true,transfers:db.transfers.slice().reverse()}));
app.get('/api/admin/logs',authenticate,requireAdmin,(req,res)=>res.json({success:true,logs:db.logs.slice().reverse().slice(0,500)}));
app.get('/api/admin/coupons',authenticate,requireAdmin,(req,res)=>res.json({success:true,coupons:db.coupons.slice().reverse()}));
app.post('/api/admin/coupons',authenticate,requireAdmin,(req,res)=>{const b=req.body||{};const code=sanitizeText(b.code||('AYNO-'+crypto.randomBytes(4).toString('hex').toUpperCase()),80).toUpperCase();if(db.coupons.some(c=>c.code===code))return res.status(409).json({success:false,error:'Coupon code already exists'});const c={id:id('C'),code,type:b.type==='percent'?'percent':'fixed',value:safeNumber(b.value,0)||0,maxUses:safeNumber(b.maxUses,0)||0,uses:0,expiresAt:b.expiresAt||null,userId:b.userId?String(b.userId):null};db.coupons.push(c);saveData();res.status(201).json({success:true,coupon:c});});
app.get('/api/admin/settings',authenticate,requireAdmin,(req,res)=>res.json({success:true,settings:db.settings}));
app.patch('/api/admin/settings',authenticate,requireAdmin,(req,res)=>{const b=req.body||{};for(const k of ['maintenance','rewardEnabled','coinSystemEnabled','leaderboardEnabled'])if(b[k]!==undefined)db.settings[k]=!!b[k];for(const k of ['minWithdraw','minAddBalance','coinRateVpn','coinRateProxy','coinRateMail','referralBonus'])if(b[k]!==undefined){const n=safeNumber(b[k],0);if(n!==null)db.settings[k]=n;}if(Array.isArray(b.paymentMethods))db.settings.paymentMethods=b.paymentMethods.map(m=>({...m,id:m.id||id('PM'),name:sanitizeText(m.name,80),number:sanitizeText(m.number,50),logoUrl:sanitizeText(m.logoUrl||'',500),enabled:m.enabled!==false}));saveData();res.json({success:true,settings:db.settings});});
app.post('/api/admin/sms-services',authenticate,requireAdmin,(req,res)=>{db.smsServices=Array.isArray(req.body?.services)?req.body.services:[];saveData();res.json({success:true,services:db.smsServices});});

app.post('/api/logs/error',(req,res)=>{const b=req.body||{};db.logs.push({type:sanitizeText(b.type,50),message:sanitizeText(b.message,500),stack:sanitizeText(b.stack,2000),timestamp:b.timestamp||now()});db.logs=db.logs.slice(-500);saveData();res.json({success:true});});

let bot=null;
if(TELEGRAM_BOT_TOKEN){try{if(WEBHOOK_URL){bot=new TelegramBot(TELEGRAM_BOT_TOKEN);bot.setWebHook(`${WEBHOOK_URL.replace(/\/$/,'')}/bot${TELEGRAM_BOT_TOKEN}`).catch(e=>console.warn('Webhook:',e.message));}else{bot=new TelegramBot(TELEGRAM_BOT_TOKEN,{polling:true});}}catch(e){console.warn('Telegram bot disabled:',e.message);}}
if(bot){bot.onText(/\/start/,msg=>{if(msg.chat?.id){upsertUser({id:msg.from.id,first_name:msg.from.first_name,last_name:msg.from.last_name,username:msg.from.username});bot.sendMessage(msg.chat.id,'Ayno Store is ready. Open the Web App from the configured Telegram button.').catch(()=>{});}});}

app.use((req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({success:false,error:'API endpoint not found',path:req.path});res.sendFile(path.join(__dirname,'index.html'));});
app.use((err,req,res,next)=>{console.error('🔥 Server Error:',err.stack||err);res.status(err.status||500).json({success:false,error:process.env.NODE_ENV==='production'?'Internal server error':err.message});});
const server=app.listen(PORT,HOST,()=>console.log(`Ayno Store production server listening on ${HOST}:${PORT}`));
function shutdown(){server.close(()=>{writeData();process.exit(0);});}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
