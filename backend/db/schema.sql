-- Paradigm schema. Idempotent: runs on every deploy (see backend/scripts/migrate.js).

-- ---------- Catalogue ----------
CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY,
    slug        TEXT        NOT NULL UNIQUE,
    title       TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Image bytes live in their own table so listing products never loads binary data.
CREATE TABLE IF NOT EXISTS product_images (
    product_id        INTEGER     PRIMARY KEY REFERENCES products (id) ON DELETE CASCADE,
    mime_type         TEXT        NOT NULL,
    data              BYTEA       NOT NULL,
    width             INTEGER,
    height            INTEGER,
    byte_size         INTEGER     NOT NULL,
    sha256            TEXT        NOT NULL,
    original_filename TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_active_sort_idx ON products (is_active, sort_order, id);

-- Backend-only record of products the owner deleted (used by the admin tools in a later batch).
-- The seed script never re-creates a product whose id is in this table.
CREATE TABLE IF NOT EXISTS deleted_products (
    id              BIGSERIAL   PRIMARY KEY,
    product_id      INTEGER     NOT NULL,
    product_data    JSONB       NOT NULL,
    image_mime_type TEXT,
    image_data      BYTEA,
    deleted_by      UUID,
    deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deleted_products_product_idx ON deleted_products (product_id);

-- ---------- Accounts ----------
CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL,
    username      TEXT        NOT NULL,
    phone         TEXT        NOT NULL DEFAULT '',
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Emails are unique regardless of letter case.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- Only a SHA-256 hash of the session token is stored; the raw token lives in an HttpOnly cookie.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT        PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ---------- Orders ----------
-- user_id is SET NULL when an account is deleted so sales history stays intact.
CREATE TABLE IF NOT EXISTS orders (
    id             BIGSERIAL   PRIMARY KEY,
    user_id        UUID        REFERENCES users (id) ON DELETE SET NULL,
    customer_email TEXT        NOT NULL,
    customer_name  TEXT        NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled')),
    item_count     INTEGER     NOT NULL CHECK (item_count > 0),
    total          NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);

-- Title and price are copied at purchase time so later product edits don't change past orders.
CREATE TABLE IF NOT EXISTS order_items (
    id         BIGSERIAL   PRIMARY KEY,
    order_id   BIGINT      NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id INTEGER,
    title      TEXT        NOT NULL,
    unit_price NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    quantity   INTEGER     NOT NULL CHECK (quantity > 0),
    line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- ---------- Batch 2: profiles, avatars, wishlist ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_changed_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio              TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS description      TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS size_preference  TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_address JSONB;

CREATE TABLE IF NOT EXISTS user_avatars (
    user_id    UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    mime_type  TEXT        NOT NULL,
    data       BYTEA       NOT NULL,
    byte_size  INTEGER     NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wishlist (
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    product_id INTEGER     NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, product_id)
);

-- ---------- Batch 3: owner tools ----------
-- Unit cost per product (what the owner pays to make it), used by the profit & loss tracker.
ALTER TABLE products    ADD COLUMN IF NOT EXISTS cost      NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0);
-- Cost copied at purchase time, like unit_price, so later cost edits don't rewrite past profit.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE deleted_products ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';

-- Other business costs (shipping, packaging, ads...) for the P&L tracker.
CREATE TABLE IF NOT EXISTS expenses (
    id         BIGSERIAL   PRIMARY KEY,
    label      TEXT        NOT NULL,
    category   TEXT        NOT NULL DEFAULT 'other',
    amount     NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    spent_on   DATE        NOT NULL DEFAULT CURRENT_DATE,
    created_by UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_spent_idx ON expenses (spent_on DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC);

-- ---------- Batch 5: full store features ----------
-- One-time data fixes are recorded here so they never run twice.
CREATE TABLE IF NOT EXISTS schema_flags (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());

ALTER TABLE products ADD COLUMN IF NOT EXISTS category         TEXT    NOT NULL DEFAULT 'Originals';
ALTER TABLE products ADD COLUMN IF NOT EXISTS compare_at_price NUMERIC(10, 2) CHECK (compare_at_price IS NULL OR compare_at_price >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS release_at       TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_preorder   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_limited       BOOLEAN NOT NULL DEFAULT FALSE;

-- Sizes and colours with stock. color '' means the product comes in one colour.
CREATE TABLE IF NOT EXISTS product_variants (
    product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    color      TEXT    NOT NULL DEFAULT '',
    size       TEXT    NOT NULL CHECK (size IN ('XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL')),
    stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    PRIMARY KEY (product_id, color, size)
);

-- Extra photos per product (the main photo stays in product_images).
CREATE TABLE IF NOT EXISTS product_gallery (
    id         BIGSERIAL   PRIMARY KEY,
    product_id INTEGER     NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    position   INTEGER     NOT NULL DEFAULT 0,
    mime_type  TEXT        NOT NULL,
    data       BYTEA       NOT NULL,
    byte_size  INTEGER     NOT NULL,
    sha256     TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_gallery_product_idx ON product_gallery (product_id, position, id);
ALTER TABLE deleted_products ADD COLUMN IF NOT EXISTS gallery JSONB;

-- Orders: shipping, discounts, tracking.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal         NUMERIC(12, 2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_fee     NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount         NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_code    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundle_discount  NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS contact_phone    TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method   TEXT NOT NULL DEFAULT 'cod';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes            TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier          TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number  TEXT NOT NULL DEFAULT '';
UPDATE orders SET subtotal = total WHERE subtotal IS NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS size        TEXT    NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS color       TEXT    NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_preorder BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);

-- Store-wide settings (shipping fee, free-shipping minimum, bundle deal, announcement, social links).
CREATE TABLE IF NOT EXISTS store_settings (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discount_codes (
    code         TEXT        PRIMARY KEY,               -- stored uppercase
    kind         TEXT        NOT NULL CHECK (kind IN ('percent', 'fixed')),
    value        NUMERIC(10, 2) NOT NULL CHECK (value > 0),
    min_subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
    max_uses     INTEGER     CHECK (max_uses IS NULL OR max_uses > 0),
    used_count   INTEGER     NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ,
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Verified-purchase reviews: one per customer per product.
CREATE TABLE IF NOT EXISTS reviews (
    id         BIGSERIAL   PRIMARY KEY,
    product_id INTEGER     NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    rating     SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body       TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, user_id)
);

-- "Notify me when restocked" requests (emails go out once an email provider is set up).
CREATE TABLE IF NOT EXISTS restock_requests (
    product_id INTEGER     NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    size       TEXT        NOT NULL DEFAULT '',
    color      TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, user_id, size, color)
);

CREATE TABLE IF NOT EXISTS return_requests (
    id         BIGSERIAL   PRIMARY KEY,
    order_id   BIGINT      NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    user_id    UUID        REFERENCES users (id) ON DELETE SET NULL,
    kind       TEXT        NOT NULL CHECK (kind IN ('return', 'exchange')),
    reason     TEXT        NOT NULL,
    details    TEXT        NOT NULL DEFAULT '',
    status     TEXT        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'completed')),
    admin_note TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS return_requests_open_idx ON return_requests (order_id) WHERE status IN ('requested', 'approved');

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    email      TEXT        PRIMARY KEY,                 -- stored lowercase
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_messages (
    id         BIGSERIAL   PRIMARY KEY,
    user_id    UUID        REFERENCES users (id) ON DELETE SET NULL,
    name       TEXT        NOT NULL,
    email      TEXT        NOT NULL,
    subject    TEXT        NOT NULL DEFAULT '',
    message    TEXT        NOT NULL,
    is_read    BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Simple shared rate limiter (works across Vercel function instances).
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket     TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limits_bucket_idx ON rate_limits (bucket, created_at);

-- One-time: categorise the original 19 tees and date them to the original photo upload,
-- so they aren't all labelled "New". Fresh databases get this from the seed instead.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'b5_original_catalogue') THEN
        UPDATE products SET category = 'Collabs' WHERE id IN (901, 903, 904, 905, 907, 914, 917, 920);
        UPDATE products SET category = 'JDM' WHERE id = 906;
        UPDATE products SET created_at = '2026-03-30T00:00:00Z' WHERE id BETWEEN 901 AND 922;
        INSERT INTO schema_flags (name) VALUES ('b5_original_catalogue');
    END IF;
END $$;

-- ---------- Batch 4: email + payments ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Accounts that existed before email verification was introduced are treated as verified.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'b4_verify_existing_users') THEN
        UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
        INSERT INTO schema_flags (name) VALUES ('b4_verify_existing_users');
    END IF;
END $$;

-- One-time links sent by email (verify email, reset passcode, confirm phone change). Only hashes are stored.
CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT        PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose    TEXT        NOT NULL CHECK (purpose IN ('verify', 'reset', 'phone')),
    payload    JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id, purpose);

-- Payment tracking. payment_status: unpaid (COD not yet collected), awaiting (online, not paid yet),
-- paid, failed, expired (online order not paid in time and cancelled).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status     TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_session_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at            TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS orders_payment_session_idx ON orders (payment_session_id);
CREATE INDEX IF NOT EXISTS orders_awaiting_idx ON orders (created_at) WHERE payment_status = 'awaiting';
UPDATE orders SET payment_status = 'paid', paid_at = coalesce(paid_at, updated_at)
    WHERE payment_status = 'unpaid' AND status IN ('paid', 'shipped', 'completed');

-- Processed PayMongo webhook events, so a retried delivery is handled once.
CREATE TABLE IF NOT EXISTS payment_events (
    id          TEXT        PRIMARY KEY,
    type        TEXT        NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- When the current online payment attempt started (unpaid orders expire relative to this).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_started_at TIMESTAMPTZ;
