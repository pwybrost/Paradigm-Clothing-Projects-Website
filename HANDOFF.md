# Paradigm Clothing Projects: project summary (for a new chat)

Repo: https://github.com/pwybrost/Paradigm-Clothing-Projects-Website · Live: https://prdgm.vercel.app
Stack: static HTML/CSS/JS frontend (`frontend/`) + Express 5 API (`backend/`) on **Neon PostgreSQL**,
deployed on **Vercel** (`api/index.js` = function entry, `vercel.json`). Tailwind v4 (no Preflight).
The detailed plan and rules are in `.kiro/steering/project-plan.md`; setup, API and env vars are in `README.md` and `.env.example`.

## Owner's rules
- Never change the existing design/aesthetic. New screens reuse the same look (black glass panels, monospace
  uppercase labels, blue `#3b82f6`, "terminal" wording, same sounds). Light mode has its own palette in `styles/light.css`.
- Never delete or overwrite the 19 t-shirt photos in `backend/data/images/` (no other copy exists).
- Owner-only features must be enforced on the server. The only admin is `pwybrost@addu.edu.ph`
  (env `ADMIN_EMAILS`). Everyone else is a member.
- Work in batches and report after each one.

## What exists (all merged to main via PR #1, plus PR "perf-and-admin-password")
- **Catalogue:** products, photos (WebP in Neon, plus ~520px card thumbnails), sizes/colours/stock, extra photos,
  categories, sale prices, drops with countdowns, pre-orders, badges, reviews (verified buyers only), restock requests,
  share pages `/p/:id`, live `sitemap.xml`.
- **Accounts:** scrypt hashes, HttpOnly session cookies, login rate limiting, profile (avatar, name once per 30 days,
  bio, size, address), email verification, forgot/reset passcode, phone change by email link.
- **Shopping:** guest browsing, cart (synced to the account across devices/tabs), wishlist, server-priced checkout
  with shipping, discount codes, bundle deal, free-shipping threshold, COD or PayMongo online payment,
  receipts, My Orders, buy again, returns/exchanges.
- **Owner console** (archive page, admin only): edit/add/delete items (deleted copies kept in `deleted_products`),
  arrange order, hide items, P&L tracker with expenses, orders menu with tracking, returns, customers, stock alerts,
  discounts, inbox (contact replies, newsletter), store settings, CSV exports, integrations status.
- **Pages:** index (archive), Login, Signup, Profile, Orders, Receipt, Info (About/FAQ/Shipping/Contact/Terms/Privacy),
  Reset, Confirm, 404.
- **Reliability:** `/api/health` diagnostics; database self-setup on first request; service worker offline copies;
  offline outbox (wishlist, profile, cart, orders...) replayed when back online; duplicate-safe orders.
- **Performance:** compositor-only animated background, off-screen cards skipped, theme switch without transitions,
  thumbnails, lazy images, low-end mode (`localStorage.paradigm_perf = 'full' | 'lite'`).
- **Optional:** Dockerfile + docker-compose with local Postgres. Vercel doesn't use them.

## Status / to do
- Health check showed the database connected (19 products, 19 photos).
- **Email (Resend) and payments (PayMongo) are not configured yet.** Set `RESEND_API_KEY`, `EMAIL_FROM`
  (verified domain), `EMAIL_REPLY_TO`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` (webhook:
  `/api/payments/webhook`, event `checkout_session.payment.paid`), `APP_URL`, `APP_SECRET`, `CRON_SECRET`.
- Owner to review: the Info page text, size-guide numbers (`SIZE_GUIDE` in `frontend/shop.js`), and the real stock
  and unit cost for each item (defaults are 10 per size and ₱0 cost).
- Ideas not built yet: refunds via the PayMongo API, abandoned-cart emails, multiple saved addresses, regional shipping rates.

## Useful commands
- `npm install`, then `npx vercel env pull .env`, then `npm run dev` (http://localhost:3000)
- `npm run db:setup` creates tables and stores missing photos (safe to re-run)
- `npm run admin:set-password -- pwybrost@addu.edu.ph` sets a passcode directly (asks for it, never stored in files)
