-- Paradigm product catalogue. Safe to run repeatedly.

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
