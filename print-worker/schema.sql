-- Savourly print worker tables. Run once in Cloudflare → D1 → savourly-orders → Console.
-- Safe to run again: nothing is replaced or deleted.

-- One row per printed card copy (an order line of 3 copies = 3 rows).
CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT UNIQUE NOT NULL,             -- order ref + line + copy, e.g. OID000123-1-2
  order_ref TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  copy_no INTEGER NOT NULL,
  product_id TEXT,
  product_name TEXT,
  style TEXT,
  status TEXT NOT NULL DEFAULT 'queued',    -- queued, proof, sent, printing, dispatched, local_delivery, delivered,
                                            -- returned, cancelled, needs_attention, done_by_hand
  mode TEXT,                                -- 'proof' or 'live' once sent to Stannp
  stannp_id INTEGER,                        -- Stannp mailpiece ID (0 for proofs)
  proof_url TEXT,                           -- Stannp's proof PDF link
  cost REAL,                                -- what Stannp charged (proofs: what it would charge)
  spend_day TEXT,                           -- UK date it was sent, for the daily cap
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs(order_ref);
CREATE INDEX IF NOT EXISTS idx_print_jobs_stannp ON print_jobs(stannp_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_day ON print_jobs(spend_day);

-- Small settings the print worker reports for the order log (mode, cap, last run).
-- 'start' = only orders paid after this moment are ever sent to Stannp.
CREATE TABLE IF NOT EXISTS print_settings (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO print_settings (key, value) VALUES ('start', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Remembers which alert emails were already sent, so each goes out once.
CREATE TABLE IF NOT EXISTS print_alerts (alert_key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
