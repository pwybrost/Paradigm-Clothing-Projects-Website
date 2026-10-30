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

### Batch 2: user profile (next)
- Profile icon next to the Theme button on the dashboard (right side) opening a profile page.
- Profile: profile picture upload, First name + Last name (editable once every 30 days), bio/description,
  email shown (read-only), phone number change only after email confirmation (needs an email provider, e.g. Resend).
- History/transactions tab: past and current purchases grouped by order, search bar, sort/organize button.
- "My Orders" page with orders and a wishlist (heart button on product cards).
- Extra shop profile ideas: saved shipping addresses, size preferences, change password, order status badges,
  recently viewed items.

### Batch 3: owner/admin tools
- Edit button on product cards (admin only): edit picture, name, description, price.
- Delete/omit with a confirmation dialog; deleted rows copied to `deleted_products` (backend-only record).
- Add new products.
- Profit and loss tracker (button on dashboard, full-screen panel): revenue, cost (needs a product cost field), profit by period.
- Orders menu: list of users and their orders; click to expand details; update order status.

### Batch 4: hardening and payments
- Real payment gateway (PayMongo or Stripe) instead of "pending / pay on delivery" orders.
- Password reset by email, login rate limiting, email verification at signup.
- Stock/inventory and sizes per product.
