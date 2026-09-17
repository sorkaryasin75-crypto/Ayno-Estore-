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
const compression = require('compression');
const AynoStorage = require('./storage');
const SmsBowerProvider = require('./providers/smsbower');
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
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const AUTO_APPROVE_UPLOADS = String(process.env.AUTO_APPROVE_UPLOADS || 'false').toLowerCase() === 'true';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const SMSBOWER_API_KEY = process.env.SMSBOWER_API_KEY || '';
const SMSBOWER_API_URL = process.env.SMSBOWER_API_URL || 'https://smsbower.online';
const smsProvider = new SmsBowerProvider({ apiKey: SMSBOWER_API_KEY, baseUrl: SMSBOWER_API_URL });

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
const storage = new AynoStorage({ dataFile: DATA_FILE, defaults });
function loadData(){
  try {
    if(fs.existsSync(DATA_FILE)) {
      const parsed=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      const merged={...defaults,...parsed};
      for(const k of Object.keys(defaults)) if(merged[k]===undefined) merged[k]=JSON.parse(JSON.stringify(defaults[k]));
      merged.settings={...defaults.settings,...(parsed.settings||{})};
      merged.products=Array.isArray(parsed.products)?parsed.products:JSON.parse(JSON.stringify(defaultProducts));
      return merged;
    }
  } catch(e){ console.error('[storage] Data load failed:',e.message); }
  return JSON.parse(JSON.stringify(defaults));
}
function saveData(){ storage.schedule(db); }

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
const ORDER_TRANSITIONS={Pending:['Processing','Cancelled'],Processing:['PendingProvider','Completed','Failed','Cancelled'],PendingProvider:['Processing','Completed','Failed','Cancelled'],Failed:[],Cancelled:[],Completed:['Delivered'],Delivered:[]};
function canTransition(from,to){return from===to || (ORDER_TRANSITIONS[from]||[]).includes(to);}
function idemKey(req){return String(req.headers['idempotency-key']||req.body?.idempotencyKey||'').trim();}
async function claimIdem(req,res){const key=idemKey(req);if(!key)return true;const ok=await storage.claimIdempotency(key,req.user?.tgId||'anonymous',req.path);if(!ok){res.status(409).json({success:false,error:'Duplicate request: Idempotency-Key already used'});return false;}return true;}
function syncBalance(user,balance){user.balance=Math.round(Number(balance)*100)/100;return user.balance;}
async function walletChange(req,res,{delta,type,refId,meta={}}){try{const r=await storage.atomicChange({tgId:req.dbUser.tgId,delta,type,refId,meta,fallbackBalance:req.dbUser.balance});syncBalance(req.dbUser,r.balance);return r;}catch(e){if(e.code==='INSUFFICIENT_BALANCE'){res.status(400).json({success:false,error:'Insufficient balance'});return null;}throw e;}}
function audit(action,req,targetId,meta={}){db.logs.push({type:'audit',action,actorId:String(req.user?.tgId||req.dbUser?.tgId||''),targetId:targetId?String(targetId):null,route:req.path,meta,timestamp:now()});db.logs=db.logs.slice(-1000);storage.audit({actorId:req.user?.tgId||req.dbUser?.tgId,action,route:req.path,targetId,meta}).catch(e=>console.warn('[audit]',e.message));}


app.set('trust proxy',1); app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(compression());
const allowedOrigins=(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>{if(!origin||allowedOrigins.length===0||allowedOrigins.includes(origin))return cb(null,true);return cb(new Error('CORS origin denied'));},credentials:false}));
app.use(express.json({limit:'10mb'})); app.use(express.urlencoded({extended:true,limit:'10mb'})); app.use(morgan('tiny'));
const limiter=rateLimit({windowMs:15*60*1000,max:200,standardHeaders:true,legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false});
app.use('/api/',limiter);
app.use(express.static(__dirname,{maxAge:'1h',setHeaders:(res,file)=>{if(/\.(svg|png|jpg|jpeg|webp|ico|css|js)$/.test(file))res.setHeader('Cache-Control','public,max-age=86400');else res.setHeader('Cache-Control','no-cache');}}));
app.use('/uploads',express.static(UPLOAD_DIR,{maxAge:'7d',fallthrough:false}));

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/health',(req,res)=>res.status(200).json({status:'OK',ready:storage.ready,uptime:process.uptime(),timestamp:now(),maintenance:!!db.settings.maintenance,database:storage.enabled?'postgres':'json'}));
app.head('/health',(req,res)=>res.status(200).end());
app.get('/api/health',(req,res)=>res.json({status:'healthy',server:'running',database:storage.enabled?'postgres':'json',timestamp:now(),version:'2.0.0'}));

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
app.get('/api/system-status',(req,res)=>res.json({success:true,version:'3.0.0',database:storage.enabled?'postgresql':'json-fallback',providers:{smsbower:smsProvider.configured()},features:{idempotency:true,walletLedger:storage.enabled,auditLog:storage.enabled,orderStateMachine:true},timestamp:now()}));
app.get('/api/app-data',(req,res)=>res.json({success:true,products:db.products,settings:db.settings,timestamp:now()}));

app.get('/api/orders',authenticate,(req,res)=>res.json({success:true,orders:userOrders(req.dbUser.tgId)}));
app.post('/api/orders',authenticate,(req,res)=>{
  const b=req.body||{}; const price=safeNumber(b.price); if(!b.item||price===null||!b.method||!b.trxId)return res.status(400).json({success:false,error:'Missing or invalid order fields'});
  const trx=sanitizeText(b.trxId,100); if(!/^[a-zA-Z0-9_\-#/.]+$/.test(trx))return res.status(400).json({success:false,error:'Invalid transaction ID'});
  const order={id:b.id||id('AYN'),userId:String(req.dbUser.tgId),tgId:String(req.dbUser.tgId),item:sanitizeText(b.item,300),price,method:sanitizeText(b.method,80),trxId:trx,status:'Pending',category:b.category||'',externalType:b.externalType||'',createdAt:now(),updatedAt:now()};
  db.orders.push(order); saveData(); res.status(201).json({success:true,order});
});
app.delete('/api/orders/:id',authenticate,(req,res)=>{const i=db.orders.findIndex(o=>o.id===req.params.id&&String(o.userId)===String(req.dbUser.tgId));if(i<0)return res.status(404).json({success:false,error:'Order not found'});if(['Completed','Delivered'].includes(db.orders[i].status))return res.status(400).json({success:false,error:'Completed orders cannot be deleted'});db.orders.splice(i,1);saveData();res.json({success:true});});

const uploadStorage=multer.diskStorage({destination:UPLOAD_DIR,filename:(req,file,cb)=>cb(null,Date.now()+'-'+crypto.randomBytes(8).toString('hex')+path.extname(file.originalname).toLowerCase())});
const upload=multer({storage:uploadStorage,limits:{fileSize:5*1024*1024},fileFilter:(req,file,cb)=>{const ok=['.png','.jpg','.jpeg','.webp'].includes(path.extname(file.originalname).toLowerCase());cb(ok?null:new Error('Only JPEG, PNG and WebP images are allowed'),ok);}});
app.post('/api/verify-screenshot',authenticate,upload.single('screenshot'),async(req,res)=>{if(!req.file)return res.status(400).json({success:false,error:'No screenshot uploaded'});const v={id:id('V'),userId:String(req.dbUser.tgId),filename:req.file.filename,originalName:req.file.originalname,path:'/uploads/'+req.file.filename,status:AUTO_APPROVE_UPLOADS?'Approved':'Manual_Review',createdAt:now()};db.verifications.push(v);if(AUTO_APPROVE_UPLOADS){const credit=Number(process.env.AUTO_APPROVE_CREDIT||0);if(credit>0){const r=await walletChange(req,res,{delta:credit,type:'verification_credit',refId:v.id});if(!r)return;}}saveData();res.json({success:true,status:v.status,newBalance:req.dbUser.balance,verification:v});});
app.post('/api/user/avatar',authenticate,upload.single('avatar'),(req,res)=>{if(!req.file)return res.status(400).json({success:false,error:'No avatar uploaded'});req.dbUser.photoUrl='/uploads/'+req.file.filename;saveData();res.json({success:true,photoUrl:req.dbUser.photoUrl,user:publicUser(req.dbUser)});});

function findOrder(id1,uid){return db.orders.find(o=>(o.id===id1||o.externalOrderId===id1)&&String(o.userId)===String(uid));}
app.post('/api/buy-external',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;const b=req.body||{};const price=safeNumber(b.price);if(!b.externalId||price===null)return res.status(400).json({success:false,error:'externalId and valid price are required'});const order={id:id('EXT'),userId:String(req.dbUser.tgId),tgId:String(req.dbUser.tgId),item:sanitizeText(b.itemName||b.externalId,300),price,method:'Wallet',status:'PendingProvider',category:b.externalType||'external',externalType:b.externalType||'',externalId:String(b.externalId),service:sanitizeText(b.service,100),country:sanitizeText(b.country,50),providerId:sanitizeText(b.providerId,100),createdAt:now(),updatedAt:now()};const w=await walletChange(req,res,{delta:-price,type:'external_purchase',refId:order.id,meta:{externalId:order.externalId,providerId:order.providerId}});if(!w)return;
  if(order.providerId.toLowerCase()==='smsbower' || order.providerId.toLowerCase()==='smsbower.online'){
    if(!smsProvider.configured()){await walletChange(req,res,{delta:price,type:'provider_refund',refId:order.id,meta:{reason:'provider_not_configured'}});return res.status(503).json({success:false,error:'SMS provider is not configured'});}
    try{
      const providerResult=await smsProvider.getNumber({service:order.service,country:order.country});
      order.providerRaw=providerResult.raw;
      const m=String(providerResult.raw).match(/^ACCESS_NUMBER:([^:]+):(.+)$/);
      if(m){order.activationId=m[1];order.number=m[2];order.status='Processing';}
      else {order.status='Failed';await walletChange(req,res,{delta:price,type:'provider_refund',refId:order.id,meta:{reason:'provider_rejected',raw:providerResult.raw}});}
    }catch(e){order.status='Failed';await walletChange(req,res,{delta:price,type:'provider_refund',refId:order.id,meta:{reason:'provider_error'}});order.providerError=process.env.NODE_ENV==='production'?'Provider request failed':e.message;}
  }
  db.orders.push(order);saveData();audit('wallet_purchase',req,order.id,{amount:price,externalId:order.externalId,status:order.status});res.status(order.status==='Failed'?502:201).json({success:order.status!=='Failed',order,user:publicUser(req.dbUser),providerConfigured:smsProvider.configured()});});
app.post('/api/get-otp',authenticate,async(req,res)=>{const o=findOrder(req.body?.orderId,req.dbUser.tgId);if(!o)return res.status(404).json({success:false,error:'Order not found'});if(!smsProvider.configured())return res.status(503).json({success:false,status:o.status,error:'SMS provider is not configured'});const activationId=req.body?.activationId||o.activationId||o.externalId;if(!activationId)return res.status(400).json({success:false,error:'activationId is required'});try{const result=await smsProvider.getStatus({activationId});o.providerStatus=result.raw;o.updatedAt=now();saveData();return res.json({success:true,status:o.status,providerStatus:result.raw});}catch(e){return res.status(502).json({success:false,status:o.status,error:'SMS provider request failed',detail:process.env.NODE_ENV==='production'?undefined:e.message});}});
app.post('/api/cancel-order',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;const o=findOrder(req.body?.internalOrderId||req.body?.orderId,req.dbUser.tgId);if(!o)return res.status(404).json({success:false,error:'Order not found'});if(!canTransition(o.status,'Cancelled'))return res.status(400).json({success:false,error:`Order cannot transition from ${o.status} to Cancelled`});o.status='Cancelled';if(o.method==='Wallet'){const w=await walletChange(req,res,{delta:Number(o.price||0),type:'order_refund',refId:o.id});if(!w)return;}o.updatedAt=now();saveData();audit('order_cancelled',req,o.id,{refund:o.method==='Wallet'?Number(o.price||0):0});res.json({success:true,order:o,newBalance:req.dbUser.balance});});
app.post('/api/complete-order',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;const o=findOrder(req.body?.internalOrderId||req.body?.orderId,req.dbUser.tgId);if(!o)return res.status(404).json({success:false,error:'Order not found'});if(!canTransition(o.status,'Completed'))return res.status(400).json({success:false,error:`Order cannot transition from ${o.status} to Completed`});o.status='Completed';o.updatedAt=now();saveData();audit('order_completed',req,o.id);res.json({success:true,order:o});});

app.get('/api/ledger',authenticate,async(req,res)=>{
  if(!storage.pool) return res.json({success:true,ledger:[],message:'PostgreSQL ledger is disabled; JSON fallback is active'});
  try {
    const r=await storage.pool.query('SELECT id,amount,direction,type,ref_id AS "refId",balance_after AS "balanceAfter",meta,created_at AS "createdAt" FROM ayno_wallet_ledger WHERE tg_id=$1 ORDER BY created_at DESC LIMIT 200',[String(req.dbUser.tgId)]);
    res.json({success:true,ledger:r.rows});
  } catch(e) { res.status(500).json({success:false,error:'Ledger unavailable'}); }
});

app.get('/api/reviews/:productId',(req,res)=>res.json({success:true,reviews:db.reviews.filter(r=>String(r.productId)===String(req.params.productId))}));
app.post('/api/reviews',authenticate,(req,res)=>{const b=req.body||{};const rating=Math.max(1,Math.min(5,Number(b.rating)||0));if(!b.productId||!rating)return res.status(400).json({success:false,error:'Product and rating required'});const r={id:id('R'),productId:String(b.productId),userId:String(req.dbUser.tgId),userName:sanitizeText(req.dbUser.firstName,80),rating,comment:sanitizeText(b.comment,500),date:now()};db.reviews.push(r);saveData();res.status(201).json({success:true,review:r});});

app.post('/api/withdraw',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;const b=req.body||{};const amount=safeNumber(b.amount,1);if(amount===null||amount<Number(db.settings.minWithdraw||50))return res.status(400).json({success:false,error:`Minimum withdrawal is ${db.settings.minWithdraw||50}`});if(!b.accountNumber)return res.status(400).json({success:false,error:'Account number required'});const w={id:id('W'),userId:String(req.dbUser.tgId),amount,type:sanitizeText(b.type,40),method:sanitizeText(b.method,60),accountNumber:sanitizeText(b.accountNumber,50),status:'Pending',createdAt:now()};const r=await walletChange(req,res,{delta:-amount,type:'withdrawal_hold',refId:w.id,meta:{method:w.method,accountNumber:w.accountNumber}});if(!r)return;db.withdrawals.push(w);saveData();audit('withdrawal_created',req,w.id,{amount,method:w.method});res.json({success:true,withdrawal:w,newBalance:req.dbUser.balance});});
app.post('/api/transfer',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;const amount=safeNumber(req.body?.amount,1),receiver=String(req.body?.receiverTgId||'');if(!receiver||amount===null)return res.status(400).json({success:false,error:'Receiver and amount required'});const r=db.users[receiver];if(!r)return res.status(404).json({success:false,error:'Receiver not found'});if(String(r.tgId)===String(req.dbUser.tgId))return res.status(400).json({success:false,error:'Cannot transfer to yourself'});try{const t={id:id('T'),senderTgId:String(req.dbUser.tgId),receiverTgId:receiver,amount,createdAt:now()};const result=await storage.atomicTransfer({fromId:req.dbUser.tgId,toId:receiver,amount,fromFallback:req.dbUser.balance,toFallback:r.balance,refId:t.id,meta:{route:req.path}});syncBalance(req.dbUser,result.fromBalance);syncBalance(r,result.toBalance);db.transfers.push(t);saveData();audit('wallet_transfer',req,t.id,{amount,receiver});res.json({success:true,transfer:t,newBalance:req.dbUser.balance});}catch(e){if(e.code==='INSUFFICIENT_BALANCE')return res.status(400).json({success:false,error:'Insufficient balance'});throw e;}});
app.get('/api/users/search',authenticate,(req,res)=>{const q=String(req.query.q||'').toLowerCase().replace('@','');const users=Object.values(db.users).filter(u=>String(u.username||'').toLowerCase().includes(q)&&String(u.tgId)!==String(req.dbUser.tgId)).slice(0,10).map(publicUser);res.json({success:true,users});});

app.post('/api/user/notifications/ack',authenticate,(req,res)=>{req.dbUser.webNotifications=[];saveData();res.json({success:true});});
app.post('/api/user/vpn-expiry/ack',authenticate,(req,res)=>{res.json({success:true});});
app.get('/api/user/backup-key',authenticate,(req,res)=>res.json({success:true,backupKey:req.dbUser.backupKey}));

app.post('/api/reward/claim',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;if(!db.settings.rewardEnabled)return res.status(400).json({success:false,error:'Reward disabled'});if(req.dbUser.rewardClaimed)return res.status(400).json({success:false,error:'Reward already claimed'});req.dbUser.rewardClaimed=true;const coupon={id:id('C'),code:'WELCOME-'+crypto.randomBytes(3).toString('hex').toUpperCase(),type:'fixed',value:5,userId:String(req.dbUser.tgId),expiresAt:new Date(Date.now()+7*86400000).toISOString()};db.coupons.push(coupon);saveData();audit('reward_claimed',req,coupon.id);res.json({success:true,coupon,discountFixed:5});});
app.post('/api/reward/ignore',authenticate,(req,res)=>{req.dbUser.rewardIgnored=true;saveData();res.json({success:true});});
app.post('/api/loyalty/checkin',authenticate,(req,res)=>{const day=new Date().toISOString().slice(0,10);if(req.dbUser.lastCheckin===day)return res.status(400).json({success:false,error:'Already checked in today'});req.dbUser.lastCheckin=day;req.dbUser.loyaltyPoints=(req.dbUser.loyaltyPoints||0)+10;saveData();res.json({success:true,pointsEarned:10,loyaltyPoints:req.dbUser.loyaltyPoints});});
app.post('/api/loyalty/redeem',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;const points=Math.floor(Number(req.body?.points)||0);if(points<1000||points>Number(req.dbUser.loyaltyPoints||0))return res.status(400).json({success:false,error:'Invalid points amount'});const amount=points/1000;req.dbUser.loyaltyPoints-=points;const r=await walletChange(req,res,{delta:amount,type:'loyalty_redeem',refId:id('LP'),meta:{points}});if(!r)return;saveData();res.json({success:true,amountAdded:amount,newBalance:req.dbUser.balance,remainingPoints:req.dbUser.loyaltyPoints});});
app.post('/api/loyalty/scratch',authenticate,async(req,res)=>{if(!(await claimIdem(req,res)))return;const reward=5;const r=await walletChange(req,res,{delta:reward,type:'loyalty_scratch',refId:id('SCR')});if(!r)return;saveData();res.json({success:true,reward,amountAdded:reward,newBalance:req.dbUser.balance});});
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
app.patch('/api/admin/orders/:id',authenticate,requireAdmin,async(req,res)=>{if(!(await claimIdem(req,res)))return;const o=db.orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({success:false,error:'Order not found'});const status=sanitizeText(req.body?.status,50);if(status&&!canTransition(o.status,status))return res.status(400).json({success:false,error:`Invalid order transition ${o.status} -> ${status}`});if(status)o.status=status;o.updatedAt=now();if(req.body?.note!==undefined)o.adminNote=sanitizeText(req.body.note,500);saveData();audit('order_status_changed',req,o.id,{status});res.json({success:true,order:o});});
app.get('/api/admin/withdrawals',authenticate,requireAdmin,(req,res)=>res.json({success:true,withdrawals:db.withdrawals.slice().reverse()}));
app.patch('/api/admin/withdrawals/:id',authenticate,requireAdmin,async(req,res)=>{if(!(await claimIdem(req,res)))return;const w=db.withdrawals.find(x=>x.id===req.params.id);if(!w)return res.status(404).json({success:false,error:'Withdrawal not found'});const old=w.status;const next=sanitizeText(req.body?.status||w.status,30);const allowed=['Pending','Processing','Paid','Rejected','Cancelled'];if(!allowed.includes(next))return res.status(400).json({success:false,error:'Invalid withdrawal status'});w.status=next;w.adminNote=sanitizeText(req.body?.note||'',500);if(old==='Pending'&&['Rejected','Cancelled'].includes(next)){const u=db.users[w.userId];if(u){const r=await storage.atomicChange({tgId:u.tgId,delta:Number(w.amount||0),type:'withdrawal_refund',refId:w.id,fallbackBalance:u.balance});syncBalance(u,r.balance);}}w.updatedAt=now();saveData();audit('withdrawal_status_changed',req,w.id,{from:old,to:next});res.json({success:true,withdrawal:w});});
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
if(TELEGRAM_BOT_TOKEN && WEBHOOK_URL){
  app.post('/telegram/webhook', express.json({limit:'256kb'}), (req,res)=>{
    try { if(TELEGRAM_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token']!==TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(403); if (bot) bot.processUpdate(req.body); res.sendStatus(200); }
    catch (e) { console.error('[telegram] webhook error:', e.message); res.sendStatus(200); }
  });
}
if(TELEGRAM_BOT_TOKEN){
  try {
    if(WEBHOOK_URL){
      bot=new TelegramBot(TELEGRAM_BOT_TOKEN);
      const webhookEndpoint=`${WEBHOOK_URL.replace(/\/$/,'')}/telegram/webhook`;
      bot.setWebHook(webhookEndpoint, TELEGRAM_WEBHOOK_SECRET ? {secret_token: TELEGRAM_WEBHOOK_SECRET, drop_pending_updates: false} : {drop_pending_updates: false}).then(()=>console.log('[telegram] Webhook:',webhookEndpoint)).catch(e=>console.warn('[telegram] Webhook setup:',e.message));
    } else {
      bot=new TelegramBot(TELEGRAM_BOT_TOKEN,{polling:{params:{timeout:25},autoStart:true}});
    }
  } catch(e) { console.warn('[telegram] bot disabled:',e.message); }
}
if(bot){bot.onText(/\/start/,msg=>{if(msg.chat?.id){upsertUser({id:msg.from.id,first_name:msg.from.first_name,last_name:msg.from.last_name,username:msg.from.username});bot.sendMessage(msg.chat.id,'Ayno Store is ready. Open the Web App from the configured Telegram button.').catch(()=>{});}});}

app.use((req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({success:false,error:'API endpoint not found',path:req.path});res.sendFile(path.join(__dirname,'index.html'));});
app.use((err,req,res,next)=>{console.error('🔥 Server Error:',err.stack||err);res.status(err.status||500).json({success:false,error:process.env.NODE_ENV==='production'?'Internal server error':err.message});});
let server;
let shuttingDown=false;
async function start(){
  try {
    db=await storage.init();
    server=app.listen(PORT,HOST,()=>console.log(`Ayno Store production server listening on ${HOST}:${PORT}`));
    server.keepAliveTimeout=65000;
    server.headersTimeout=66000;
  } catch(e) { console.error('[startup] Fatal:',e.stack||e); process.exit(1); }
}
async function shutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;
  console.log(`[shutdown] Received ${signal}`);
  const force=setTimeout(()=>{console.error('[shutdown] Forced exit');process.exit(1)},10000);
  force.unref();
  try {
    if(bot){try{if(typeof bot.stopPolling==='function')await bot.stopPolling();}catch(e){console.warn('[telegram] stop warning:',e.message);}}
    if(server) await new Promise(resolve=>server.close(()=>resolve()));
    await storage.flush(db);
    await storage.close();
    clearTimeout(force);
    console.log('[shutdown] Clean shutdown complete');
    process.exit(0);
  } catch(e) { console.error('[shutdown] Error:',e.stack||e); clearTimeout(force); process.exit(1); }
}
process.once('SIGTERM',()=>shutdown('SIGTERM'));
process.once('SIGINT',()=>shutdown('SIGINT'));
start();
