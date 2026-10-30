---
inclusion: always
---

# Paradigm Clothing Projects: owner's plan and rules

## Hard rules (always)
- Never change the existing design or aesthetic. New screens must reuse the same look: black/glass panels,
  monospace uppercase labels, wide letter-spacing, accent blue `#3b82f6`, the "terminal" wording style
  ("Execute Order", "Finalize Transmission"), the same hover animations, and the Web Audio click/success/error sounds.
- Never delete or overwrite the product photos in `backend/data/images/`. The owner has no other copy.
  The seed only inserts products/images that are missing, and must skip products the admin deleted.
- Deploy target: Vercel project `prdgm` (https://prdgm.vercel.app) with the Neon integration.
  Database URL comes from `DATABASE_URL` (falls back to `POSTGRES_URL`). Locally it comes from `.env`.
- Admin-only features must be enforced on the server (role check), not just hidden in the UI.
- Work is delivered in batches; finish a batch, report, and wait.

## Batches
### Batch 1 (done)
- Frontend in `frontend/`, backend in `backend/`, Vercel function entry in `api/index.js`, `vercel.json`.
- Old external product API removed; the zip file removed.
- Migrations + photo seeding run automatically on every Vercel build.
- Accounts moved from localStorage to Neon: scrypt password hashes, HttpOnly session cookies, `user`/`admin` roles.
- Real checkout: orders + order items saved in Neon with server-side prices.
- `npm run admin:promote -- you@email.com` makes the owner account an admin.

### Batch 2: user profile (done)
- Profile button + dropdown next to Theme (archive, profile and orders pages): `frontend/ui.js` `mountUserMenu`.
- `Profile.html`: picture upload (cropped to 320x320 in the browser, stored in `user_avatars`),
  First/Last name (once every 30 days, enforced in SQL), bio (160), description (1000), email (read-only),
  phone (read-only; "Change" shows an email-confirmation notice), size preference, shipping address,
  stats, History & Transactions tab (grouped by month, search, sort button, status filters),
  Security tab (change passcode, sign out other devices).
- `Orders.html`: present/past orders with status tracker and cancel (pending only, confirm dialog), wishlist tab.
- Wishlist hearts on archive cards and in the product modal; cart saved in localStorage (`paradigm_cart`).
- Still open from Batch 2: phone change by email confirmation (waiting for an email provider such as Resend).

### Batch 3: owner/admin tools (done)
- `frontend/admin.js` + `styles/admin.css`, only imported by index.html for role `admin`; all `/api/admin/*` routes require admin.
- Owner console bar under the search: New Item, P&L Tracker, Orders Menu, Deleted Records.
- Cards show "✎ EDIT" (owner only) and a "Register New Item" card. Editor: photo (resized in browser to 1600px WebP),
  name, description, price, unit cost, live margin.
- Delete: confirmation dialog + type DELETE; full copy (incl. photo) saved to `deleted_products`; ids never reused; seed never restores.
- P&L: realized sales (paid/shipped/completed), cost of goods (unit_cost snapshot per order line), expenses table,
  net profit, margin, pending revenue, timeline chart, top items, expense log. Ranges 7d/30d/90d/12m/all.
- Orders menu: grouped by customer, search, status filters, expand customer -> orders -> items, update status.

### Batch 4: hardening and payments
- Real payment gateway (PayMongo or Stripe) instead of "pending / pay on delivery" orders.
- Email provider (Resend): phone-change confirmation, password reset, email verification at signup.
- Login rate limiting.
- Stock/inventory and sizes per product.
