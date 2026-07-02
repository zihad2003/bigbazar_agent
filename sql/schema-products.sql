-- ============================================
-- Big Bazar Bariarhat — Reconstructed Database Schema
-- Engine: TiDB Serverless (MySQL-compatible)
-- Reconstructed from: functions/api/[[path]].js, functions/api/db.js,
--                      scripts/migrate_csv.js
-- NOTE: No migration/schema file exists in the repo itself — this was
-- rebuilt by reading every INSERT/SELECT/UPDATE statement in the code.
-- Column types/constraints are best-effort inferences; verify against
-- the live DB (e.g. `SHOW CREATE TABLE <name>;`) before relying on this
-- for a fresh deploy.
-- ============================================

-- ============================================
-- products
-- ============================================
CREATE TABLE products (
  id                VARCHAR(36)   NOT NULL PRIMARY KEY,      -- UUID
  serial_no         INT           NULL,                       -- display/sort order
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name              VARCHAR(255)  NOT NULL,
  price             VARCHAR(50)   NOT NULL,                   -- stored as string
  original_price    VARCHAR(50)   NULL,
  description       TEXT          NULL,
  category          VARCHAR(100)  NOT NULL DEFAULT 'Women',   -- incl. Bengali variants
  images            JSON          NULL,                       -- array of URLs
  image_url         VARCHAR(500)  NULL,                       -- legacy/primary image
  video_url         VARCHAR(500)  NULL,
  status            VARCHAR(20)   NOT NULL DEFAULT 'published',
  platform_id       VARCHAR(100)  NULL,
  is_sale           TINYINT(1)    NOT NULL DEFAULT 0,
  is_hot            TINYINT(1)    NOT NULL DEFAULT 0,
  is_new            TINYINT(1)    NOT NULL DEFAULT 0,
  is_sold_out       TINYINT(1)    NOT NULL DEFAULT 0,
  is_deleted        TINYINT(1)    NOT NULL DEFAULT 0,
  is_exclusive      TINYINT(1)    NOT NULL DEFAULT 0,
  available_sizes   JSON          NULL,                       -- array
  available_colors  JSON          NULL,                       -- array
  stock_count       INT           NOT NULL DEFAULT 3,
  INDEX idx_products_status (status),
  INDEX idx_products_category (category),
  INDEX idx_products_created_at (created_at)
);

-- ============================================
-- orders
-- ============================================
CREATE TABLE orders (
  id                    VARCHAR(36)   NOT NULL PRIMARY KEY,   -- UUID
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  product_id            VARCHAR(36)   NOT NULL,
  product_name          VARCHAR(255)  NOT NULL,
  product_price         DECIMAL(10,2) NOT NULL,
  customer_name         VARCHAR(255)  NOT NULL,
  customer_phone        VARCHAR(20)   NOT NULL,
  customer_address      TEXT          NOT NULL,
  customer_note         TEXT          NULL,
  delivery_area         VARCHAR(50)   NOT NULL DEFAULT 'Inside Dhaka',
  delivery_charge       DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_amount          DECIMAL(10,2) NOT NULL,
  last_four_digits      VARCHAR(20)   NOT NULL DEFAULT 'COD', -- bKash/Nagad ref or 'COD'
  status                VARCHAR(20)   NOT NULL DEFAULT 'Pending',
  size                  VARCHAR(20)   NULL,
  color                 VARCHAR(50)   NULL,
  is_advance_paid       TINYINT(1)    NOT NULL DEFAULT 0,
  is_exclusive_order    TINYINT(1)    NOT NULL DEFAULT 0,
  payment_status        VARCHAR(20)   NOT NULL DEFAULT 'Unpaid',
  moderator_reference   VARCHAR(255)  NULL,
  INDEX idx_orders_status (status),
  INDEX idx_orders_customer_phone (customer_phone),
  INDEX idx_orders_created_at (created_at),
  CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ============================================
-- customers
-- ============================================
CREATE TABLE customers (
  id             VARCHAR(36)   NOT NULL PRIMARY KEY,          -- UUID
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name           VARCHAR(255)  NULL,
  email          VARCHAR(255)  NULL,
  mobile         VARCHAR(20)   NOT NULL,
  password_hash  VARCHAR(255)  NOT NULL,                      -- bcrypt
  UNIQUE KEY uq_customers_email (email),
  UNIQUE KEY uq_customers_mobile (mobile)
);

-- ============================================
-- admin_users
-- ============================================
CREATE TABLE admin_users (
  id             VARCHAR(36)   NOT NULL PRIMARY KEY,          -- UUID
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email          VARCHAR(255)  NOT NULL,
  password_hash  VARCHAR(255)  NOT NULL,                      -- bcrypt
  UNIQUE KEY uq_admin_users_email (email)
  -- NOTE: login handler hardcodes name: 'Admin' in the API response —
  -- there is no `name` column being read, so either it doesn't exist
  -- or it exists but is unused. Confirm against live DB.
);

-- ============================================
-- reviews
-- ============================================
CREATE TABLE reviews (
  id             VARCHAR(36)   NOT NULL PRIMARY KEY,          -- UUID
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  product_id     VARCHAR(36)   NOT NULL,
  product_name   VARCHAR(255)  NULL,
  customer_name  VARCHAR(255)  NOT NULL,
  rating         TINYINT       NOT NULL DEFAULT 5,
  comment        TEXT          NULL,
  INDEX idx_reviews_product_id (product_id),
  CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ============================================
-- site_settings
-- ============================================
CREATE TABLE site_settings (
  `key`        VARCHAR(100)  NOT NULL PRIMARY KEY,            -- backtick-quoted (reserved word)
  `value`      JSON          NULL,                             -- JSON-stringified value
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
