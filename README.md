# Ayno Store V3

Production-oriented Ayno Store build based on V2. V3 focuses on the remaining high-risk areas identified in the project audit: financial consistency, duplicate-request protection, order state control, Telegram webhook hardening, provider adapters, auditability, and Railway/PostgreSQL deployment hygiene.

## V3 changes
- PostgreSQL financial wallet ledger with row-level locking (`FOR UPDATE`).
- Atomic wallet debit/credit and atomic two-user transfer.
- Withdrawal holds and refund-on-rejection use the ledger when PostgreSQL is enabled.
- Idempotency-Key protection for important state-changing requests.
- Order state machine prevents arbitrary status jumps.
- `/api/ledger` exposes the authenticated user's ledger history when PostgreSQL is enabled.
- `/api/system-status` exposes non-secret runtime capability status.
- Telegram webhook can use `TELEGRAM_WEBHOOK_SECRET`.
- SMSBower adapter performs real provider HTTP requests when configured; it never reports fake success when credentials are absent.
- Admin withdrawal handling is safer and audited.
- V3 static smoke test is included.
- `data.json` is ignored by Git so runtime fallback data is not accidentally committed.

## Railway setup
1. Deploy this folder from GitHub.
2. Add a PostgreSQL service and connect its `DATABASE_URL` to this service.
3. Set a strong `JWT_SECRET` (32+ random characters).
4. Set `ADMIN_TELEGRAM_IDS` to the Telegram numeric IDs of administrators.
5. Set `TELEGRAM_BOT_TOKEN`.
6. Set `WEBHOOK_URL` to the public Railway URL if using webhook mode.
7. Optionally set `TELEGRAM_WEBHOOK_SECRET`.
8. Set provider credentials only when the corresponding provider account is actually available.
9. Use `/health` as the Railway healthcheck.

Railway injects `PORT`; do not hard-code a production `PORT` environment variable unless you have a specific reason.

## Database migration behavior
On first PostgreSQL startup V3 creates its tables automatically. Existing balances from `data.json` are copied into `ayno_wallets` once using the `ayno_meta` migration flag. After that, the PostgreSQL wallet ledger is authoritative for financial mutations.

## Important provider behavior
The project contains endpoint coverage and provider adapters, but provider fulfillment still requires valid third-party credentials and the exact service/country IDs used by the provider. V3 intentionally returns an explicit configuration/provider error instead of pretending a purchase or OTP was completed.

## Test
```bash
npm install
npm test
npm start
```

## Production note
A real production launch still requires a live Railway deployment test, Telegram Web App authentication test, PostgreSQL connection test, and real provider credential tests. Those cannot be truthfully marked as passed from static source inspection alone.
