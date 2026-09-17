# Ayno Store — Production Repair Build

This build repairs the supplied frontend/backend contract and adds a secure Telegram-admin management API plus `admin.html`.

## What was repaired
- Added the missing `/api/*` routes used by the supplied `index.html` instead of leaving them as 404s.
- Added secure Telegram Web App `initData` validation for `/api/auth/telegram`.
- Added admin authorization based on `ADMIN_TELEGRAM_IDS` and the persisted user role.
- Added product CRUD, user management, order management, withdrawal management, verification management and settings APIs.
- Added `admin.html` and connected it to the backend.
- Added local SVG logo assets so the storefront does not depend on missing local files or third-party image hosts for the main product/payment/service logos.
- Fixed the syntax error in `resilience-utils.js`.
- Fixed browser-side `process.env.REACT_APP_API_URL` usage in `api-handler.js`.
- Added JSON persistence with atomic temp-file replacement.
- Kept external providers configurable; unsupported providers return controlled JSON errors instead of silently creating fake successful transactions.

## Production configuration
Copy `.env.example` to `.env` and set at minimum:
- `JWT_SECRET`
- `ADMIN_TELEGRAM_IDS`
- `TELEGRAM_BOT_TOKEN` if Telegram authentication/bot features are used
- payment numbers
- provider API keys when external providers are actually connected

## Start
```bash
npm install
npm start
```

## Important
The supplied project did not contain working provider credentials or provider adapters for SMS/mail/external fulfillment. This repair therefore does **not** pretend those providers are connected. `/api/buy-external`, `/api/get-otp`, and `/api/mail/inbox` expose controlled integration points; real fulfillment requires the corresponding provider credentials/API contract.
