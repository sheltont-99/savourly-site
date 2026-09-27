CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT UNIQUE NOT NULL,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending -> paid  (or 'expired' / 'failed')
  customer_name TEXT,
  customer_email TEXT,
  shipping_address TEXT,
  items_json TEXT NOT NULL,                 -- [{"name":"Kelewele — Funky","price":3.50,"qty":1}, ...]
  subtotal REAL,
  postage REAL,
  total REAL,
  currency TEXT NOT NULL DEFAULT 'gbp',
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
