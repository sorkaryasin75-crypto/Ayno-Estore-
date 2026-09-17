const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

class AynoStorage {
  constructor({ dataFile, defaults }) {
    this.dataFile = dataFile;
    this.defaults = defaults;
    this.pool = null;
    this.enabled = Boolean(process.env.DATABASE_URL);
    this.ready = false;
    this.saveTimer = null;
    this.saveInFlight = null;
    this.idempotencyMemory = new Set();
  }
  cloneDefaults() { return JSON.parse(JSON.stringify(this.defaults)); }
  loadFile() {
    try {
      if (!fs.existsSync(this.dataFile)) return this.cloneDefaults();
      return this.merge(JSON.parse(fs.readFileSync(this.dataFile, 'utf8')));
    } catch (e) { console.error('[storage] JSON load failed:', e.message); return this.cloneDefaults(); }
  }
  merge(parsed) {
    const merged = { ...this.defaults, ...(parsed || {}) };
    for (const k of Object.keys(this.defaults)) if (merged[k] === undefined) merged[k] = this.cloneDefaults()[k];
    merged.settings = { ...this.defaults.settings, ...((parsed || {}).settings || {}) };
    merged.products = Array.isArray(parsed?.products) ? parsed.products : this.cloneDefaults().products;
    return merged;
  }
  writeFile(data) {
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const tmp = this.dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.dataFile);
    } catch (e) { console.error('[storage] JSON save failed:', e.message); }
  }
  async init() {
    if (!this.enabled) { this.ready = true; return this.loadFile(); }
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number(process.env.DB_POOL_MAX || 10), idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000, keepAlive: true,
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ayno_state (id SMALLINT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS ayno_wallets (tg_id TEXT PRIMARY KEY, balance NUMERIC(18,2) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS ayno_wallet_ledger (
        id TEXT PRIMARY KEY, tg_id TEXT NOT NULL, amount NUMERIC(18,2) NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
        type TEXT NOT NULL, ref_id TEXT, balance_after NUMERIC(18,2) NOT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ayno_ledger_user_time ON ayno_wallet_ledger(tg_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS ayno_idempotency (
        idem_key TEXT NOT NULL, user_id TEXT NOT NULL, route TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(idem_key, user_id, route)
      );
      CREATE TABLE IF NOT EXISTS ayno_audit_logs (
        id BIGSERIAL PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, route TEXT,
        target_id TEXT, meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ayno_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const result = await this.pool.query('SELECT data FROM ayno_state WHERE id = 1');
    let data;
    if (result.rowCount) data = this.merge(result.rows[0].data);
    else {
      data = this.loadFile();
      await this.pool.query('INSERT INTO ayno_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(data)]);
    }
    await this.migrateWallets(data.users || {});
    this.ready = true;
    console.log('[storage] PostgreSQL persistence + financial ledger ready');
    return data;
  }
  async migrateWallets(users) {
    const flag = await this.pool.query("SELECT 1 FROM ayno_meta WHERE key='wallet_migration_v3'");
    if (flag.rowCount) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of Object.values(users)) {
        if (!u?.tgId) continue;
        await client.query(
          'INSERT INTO ayno_wallets(tg_id,balance) VALUES($1,$2) ON CONFLICT(tg_id) DO NOTHING',
          [String(u.tgId), Number(u.balance || 0)]
        );
      }
      await client.query("INSERT INTO ayno_meta(key,value) VALUES('wallet_migration_v3','done') ON CONFLICT DO NOTHING");
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  schedule(data) {
    if (!this.enabled || !this.pool) { this.writeFile(data); return; }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(data).catch(e => console.error('[storage] PostgreSQL save failed:', e.message)), 150);
  }
  async persist(data) {
    if (!this.pool) return;
    this.saveInFlight = this.pool.query(
      `INSERT INTO ayno_state(id,data,updated_at) VALUES(1,$1::jsonb,NOW())
       ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`, [JSON.stringify(data)]
    );
    await this.saveInFlight; this.saveInFlight = null;
  }
  async flush(data) { clearTimeout(this.saveTimer); if (this.enabled && this.pool) await this.persist(data); else this.writeFile(data); }
  async claimIdempotency(key, userId, route) {
    if (!key) return true;
    const clean = String(key).trim().slice(0, 200);
    if (!clean) return true;
    if (!this.enabled || !this.pool) {
      const k = `${clean}:${String(userId)}:${route}`;
      if (this.idempotencyMemory.has(k)) return false;
      this.idempotencyMemory.add(k); if (this.idempotencyMemory.size > 10000) this.idempotencyMemory.clear(); return true;
    }
    const r = await this.pool.query(
      'INSERT INTO ayno_idempotency(idem_key,user_id,route) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING idem_key',
      [clean, String(userId), route]
    );
    return r.rowCount === 1;
  }
  async audit({ actorId, action, route, targetId, meta = {} }) {
    if (!this.enabled || !this.pool) return;
    await this.pool.query('INSERT INTO ayno_audit_logs(actor_id,action,route,target_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)', [actorId ? String(actorId) : null, action, route || null, targetId ? String(targetId) : null, JSON.stringify(meta)]);
  }
  async ensureWallet(client, tgId, fallbackBalance = 0) {
    await client.query('INSERT INTO ayno_wallets(tg_id,balance) VALUES($1,$2) ON CONFLICT(tg_id) DO NOTHING', [String(tgId), Number(fallbackBalance || 0)]);
  }
  async atomicChange({ tgId, delta, type, refId = null, meta = {}, fallbackBalance = 0 }) {
    if (!this.enabled || !this.pool) return { balance: Number(fallbackBalance) + Number(delta), persisted: false };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureWallet(client, tgId, fallbackBalance);
      const row = await client.query('SELECT balance FROM ayno_wallets WHERE tg_id=$1 FOR UPDATE', [String(tgId)]);
      let balance = Number(row.rows[0].balance);
      const change = Number(delta);
      if (!Number.isFinite(change)) throw new Error('Invalid wallet delta');
      const next = Math.round((balance + change) * 100) / 100;
      if (next < -0.000001) { const e = new Error('Insufficient balance'); e.code = 'INSUFFICIENT_BALANCE'; throw e; }
      balance = next;
      await client.query('UPDATE ayno_wallets SET balance=$2,updated_at=NOW() WHERE tg_id=$1', [String(tgId), balance]);
      await client.query('INSERT INTO ayno_wallet_ledger(id,tg_id,amount,direction,type,ref_id,balance_after,meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [crypto.randomUUID(), String(tgId), Math.abs(change), change >= 0 ? 'credit' : 'debit', type, refId ? String(refId) : null, balance, JSON.stringify(meta)]);
      await client.query('COMMIT');
      return { balance, persisted: true };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async atomicTransfer({ fromId, toId, amount, fromFallback = 0, toFallback = 0, refId, meta = {} }) {
    if (!this.enabled || !this.pool) return { fromBalance: Number(fromFallback) - Number(amount), toBalance: Number(toFallback) + Number(amount), persisted: false };
    const a = String(fromId), b = String(toId), n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid transfer amount');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureWallet(client, a, fromFallback); await this.ensureWallet(client, b, toFallback);
      const ids = [a,b].sort();
      const rows = await client.query('SELECT tg_id,balance FROM ayno_wallets WHERE tg_id=ANY($1) ORDER BY tg_id FOR UPDATE', [ids]);
      const balances = Object.fromEntries(rows.rows.map(x => [x.tg_id, Number(x.balance)]));
      if ((balances[a] || 0) < n) { const e = new Error('Insufficient balance'); e.code = 'INSUFFICIENT_BALANCE'; throw e; }
      balances[a] = Math.round((balances[a]-n)*100)/100; balances[b] = Math.round((balances[b]+n)*100)/100;
      await client.query('UPDATE ayno_wallets SET balance=$2,updated_at=NOW() WHERE tg_id=$1', [a,balances[a]]);
      await client.query('UPDATE ayno_wallets SET balance=$2,updated_at=NOW() WHERE tg_id=$1', [b,balances[b]]);
      await client.query('INSERT INTO ayno_wallet_ledger(id,tg_id,amount,direction,type,ref_id,balance_after,meta) VALUES($1,$2,$3,\'debit\',$4,$5,$6,$7::jsonb)', [crypto.randomUUID(),a,n,'transfer',refId||null,balances[a],JSON.stringify(meta)]);
      await client.query('INSERT INTO ayno_wallet_ledger(id,tg_id,amount,direction,type,ref_id,balance_after,meta) VALUES($1,$2,$3,\'credit\',$4,$5,$6,$7::jsonb)', [crypto.randomUUID(),b,n,'transfer',refId||null,balances[b],JSON.stringify(meta)]);
      await client.query('COMMIT');
      return { fromBalance: balances[a], toBalance: balances[b], persisted: true };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async close() { if (this.pool) await this.pool.end(); this.pool = null; }
}
module.exports = AynoStorage;
