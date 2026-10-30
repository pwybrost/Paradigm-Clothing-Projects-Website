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
