-- Savourly: adds refund tracking to orders, for the Refund button in the order log.
-- Run ONCE in Cloudflare → D1 → savourly-orders → Console (paste all three lines → Execute).
-- If it says "duplicate column name", it has already been run; nothing else to do.
ALTER TABLE orders ADD COLUMN refunded_amount REAL;
ALTER TABLE orders ADD COLUMN refunded_at TEXT;
ALTER TABLE orders ADD COLUMN stripe_refund_id TEXT;
