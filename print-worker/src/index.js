/**
 * Savourly print worker — sends paid recipe cards to Stannp to print and post.
 * -----------------------------------------------------------------------------
 * Separate from checkout on purpose: if this Worker breaks or is switched off,
 * customers can still buy, and orders simply wait as "awaiting print".
 *
 *   Cron (every 5 minutes)   picks up newly paid orders → one job per card copy →
 *                            sends them to Stannp, following the STANNP_MODE switch
 *   POST /stannp-webhook     Stannp → here: printing / dispatched / delivered … status updates
 *
 * THE SWITCH — variable STANNP_MODE (Cloudflare → savourly-print → Settings → Variables):
 *   off    nothing is sent; cards wait as "Waiting"                         (the default)
 *   proof  sent to Stannp with test=true: a proof PDF and the real cost come back, nothing prints, no charge
 *   live   printed and posted for real — but ONLY when STRIPE_IS_LIVE is "yes" (so test-mode
 *          checkouts can never print), and, if LIVE_ONLY_EMAILS is set, only for orders from those emails
 *          (everything else is sent as a proof).
 *
 * Cancel / Refund: the order log (savourly-admin) can cancel a card or refund an order. It marks waiting
 * cards "cancelled" in D1, so this Worker never sends them; a card is claimed ("sending") just before
 * it goes to Stannp, so a cancel and a send can't both happen to the same card. Orders refunded before
 * their cards were queued are skipped (orders.refunded_at, added by admin-worker/refunds.sql).
 *
 * Safety nets: only orders paid after the tables were created are ever sent; a daily spending cap
 * (DAILY_CAP_GBP, default £20, resets at midnight UK time) holds live cards back once reached;
 * failures are marked "Needs attention" in the order log; alert emails go to ALERT_TO.
 *
 * Bindings: DB → savourly-orders (D1); EMAIL (Send email, optional).
 * Secrets:  STANNP_API_KEY, STANNP_WEBHOOK_SECRET, GITHUB_TOKEN (read-only, savourly-reports).
 * Variables: STANNP_MODE, STRIPE_IS_LIVE, LIVE_ONLY_EMAILS, DAILY_CAP_GBP, ALERT_TO, ALERT_FROM, SITE_URL.
 * Tables: print-worker/schema.sql (run once in the D1 console).
 */

const STANNP_API = 'https://api-eu1.stannp.com/v1';
const PRINT_REPO = 'sheltont-99/savourly-reports';
const PRINT_DIR = 'print-files';
const BOX_STYLES = ['The Farmhouse Box', 'The Pantry Box', 'The Heirloom Tin', 'Kraft Wrap', 'Gift Ribbon', 'Keepsake Tin'];
const MAX_JOBS_PER_RUN = 15;      // each job = a GitHub read + a Stannp call; keeps well inside Cloudflare's per-run limit
const MAX_ORDERS_PER_RUN = 50;
const MAX_ATTEMPTS = 3;           // temporary errors are retried on the next runs, then marked "Needs attention"
const EST_LIVE_COST = 1.0;        // £ allowed for the next live card when checking the daily cap
const LIVE_STATUSES = ['printing', 'dispatched', 'local_delivery', 'delivered', 'returned', 'cancelled'];

const nowIso = () => new Date().toISOString();
function ukDay(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function styleSlug(style) { return String(style || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
const money = (n) => `£${Number(n || 0).toFixed(2)}`;

function settings(env) {
  const mode = ['off', 'proof', 'live'].includes(String(env.STANNP_MODE || '').trim().toLowerCase())
    ? String(env.STANNP_MODE).trim().toLowerCase() : 'off';
  const cap = Number(env.DAILY_CAP_GBP);
  return {
    mode,
    stripeLive: String(env.STRIPE_IS_LIVE || '').trim().toLowerCase() === 'yes',
    liveOnly: String(env.LIVE_ONLY_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    cap: Number.isFinite(cap) && cap > 0 ? cap : 20,
    size: env.STANNP_SIZE || 'A5-ENV',
    addons: env.STANNP_ADDONS ?? 'STOCK_350_UNCOATED',
  };
}

// What actually happens to one order under the current switch: 'off', 'proof' or 'live'.
function modeForOrder(s, order) {
  if (s.mode !== 'live') return s.mode;
  if (!s.stripeLive) return 'proof';                                     // test-mode checkouts never print
  if (s.liveOnly.length && !s.liveOnly.includes(String(order.customer_email || '').trim().toLowerCase())) return 'proof';
  return 'live';
}

// The checkout form saves the address as "<street>, <city> <postcode>" (index.html). Split it for Stannp.
function parseRecipient(name, address) {
  const n = String(name || '').trim().split(/\s+/).filter(Boolean);
  const m = String(address || '').trim().match(/^(.+),\s*(.+?)\s+([A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2})$/);
  if (!n.length || !m) return null;
  let line1 = m[1].trim(), line2 = '';
  const city = m[2].trim().replace(/,$/, '');
  if (!line1 || !city) return null;
  if (line1.length > 50 && line1.includes(',')) { const i = line1.lastIndexOf(','); line2 = line1.slice(i + 1).trim(); line1 = line1.slice(0, i).trim(); }
  const pc = m[3].toUpperCase().replace(/\s+/g, '');
  return {
    firstname: n[0], lastname: n.slice(1).join(' '),
    address1: line1, address2: line2, city,
    postcode: `${pc.slice(0, -3)} ${pc.slice(-3)}`, country: 'GB',
  };
}

async function getSetting(env, key) {
  const r = await env.DB.prepare(`SELECT value FROM print_settings WHERE key=?`).bind(key).first();
  return r ? r.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO print_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(key, String(value)).run();
}

// ---- Alert emails (each alert key is sent once) ----
async function alertOnce(env, key, subject, text) {
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO print_alerts (alert_key, sent_at) VALUES (?, ?)`).bind(key, nowIso()).run();
  if (!r?.meta?.changes) return false;
  if (!env.EMAIL || !env.ALERT_TO) { console.warn('Alert (no email set up):', subject); return false; }
  try {
    await env.EMAIL.send({
      to: env.ALERT_TO,
      from: env.ALERT_FROM || 'alerts@savourlyco.com',
      subject: `Savourly printing: ${subject}`,
      text: `${text}\n\nOrder log → Printing tab: https://savourly-admin.shelts-tom.workers.dev/?view=printing`,
    });
    return true;
  } catch (e) { console.error('Alert email failed:', e && e.message); return false; }
}

// ---- 1. Turn newly paid orders into one job per card copy ----
async function loadTypes(env) {
  try {
    const res = await fetch(`${String(env.SITE_URL || 'https://savourlyco.com').replace(/\/$/, '')}/products.json`, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (res.ok) return Object.fromEntries((await res.json()).products.map((p) => [p.id, p.type]));
  } catch {}
  return {};
}

async function queueNewOrders(env) {
  const start = await getSetting(env, 'start');
  if (!start) throw new Error('Print tables are not set up: run print-worker/schema.sql in the D1 console.');
  const { results } = await env.DB.prepare(
    `SELECT o.* FROM orders o
     WHERE o.status='paid' AND o.paid_at >= ?
       AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_ref = o.order_ref)
     ORDER BY o.paid_at ASC LIMIT ?`
  ).bind(start, MAX_ORDERS_PER_RUN).all();
  const flagged = [];
  if (!results.length) return flagged;
  const types = await loadTypes(env);
  for (const o of results) {
    if (o.refunded_at) {                                                // refunded from the order log before printing
      await env.DB.prepare(
        `INSERT OR IGNORE INTO print_jobs (job_key, order_ref, line_no, copy_no, status, last_error, created_at) VALUES (?, ?, 0, 0, 'no_cards', ?, ?)`
      ).bind(`${o.order_ref}-0-0`, o.order_ref, 'Refunded before printing — nothing sent.', nowIso()).run();
      continue;
    }
    let items = [];
    try { items = JSON.parse(o.items_json || '[]'); } catch {}
    const stmts = [];
    items.forEach((it, idx) => {
      const isBox = types[it.id] ? types[it.id] === 'box' : BOX_STYLES.includes(it.style);
      if (isBox) return;                                               // boxes are posted by hand
      const qty = Math.max(1, Math.min(50, Number(it.qty) || 1));
      for (let c = 1; c <= qty; c++) {
        const bad = !it.id || !it.style;
        if (bad) flagged.push(`${o.order_ref}-${idx + 1}-${c}: This order line has no product ID or style.`);
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO print_jobs (job_key, order_ref, line_no, copy_no, product_id, product_name, style, status, last_error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(`${o.order_ref}-${idx + 1}-${c}`, o.order_ref, idx + 1, c, it.id || null, it.name || null, it.style || null,
          bad ? 'needs_attention' : 'queued', bad ? 'This order line has no product ID or style.' : null, nowIso()));
      }
    });
    if (!stmts.length) {                                               // nothing to print (e.g. boxes only): remember we looked
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO print_jobs (job_key, order_ref, line_no, copy_no, status, last_error, created_at) VALUES (?, ?, 0, 0, 'no_cards', ?, ?)`
      ).bind(`${o.order_ref}-0-0`, o.order_ref, 'No recipe cards in this order — boxes are posted by hand.', nowIso()));
    }
    await env.DB.batch(stmts);
  }
  return flagged;
}

// ---- 2. Send waiting jobs to Stannp ----
async function fetchPrintFile(env, file) {
  if (!env.GITHUB_TOKEN) return { error: 'The GITHUB_TOKEN secret is missing, so print files can\'t be read.', permanent: true };
  const res = await fetch(`https://api.github.com/repos/${PRINT_REPO}/contents/${PRINT_DIR}/${file}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'savourly-print' },
  });
  if (res.status === 404) return { error: `Print file missing: ${PRINT_DIR}/${file}`, permanent: true };
  if (res.status === 401 || res.status === 403) return { error: `GitHub refused the print file (${res.status}); check GITHUB_TOKEN.`, permanent: true };
  if (!res.ok) return { error: `GitHub said ${res.status} for ${file}`, permanent: false };
  return { bytes: await res.arrayBuffer() };
}

async function sendToStannp(env, s, job, order, recipient, pdfBytes, file, mode) {
  const form = new FormData();
  form.append('test', mode === 'live' ? 'false' : 'true');
  form.append('size', s.size);
  form.append('front', new Blob([pdfBytes], { type: 'application/pdf' }), file);
  form.append('padding', '0');
  form.append('clearzone', 'false');
  form.append('post_unverified', 'false');
  if (s.addons) form.append('addons', s.addons);
  form.append('tags', order.order_ref);
  form.append('idempotency_key', `savourly-${job.job_key}-${mode}`);
  for (const [k, v] of Object.entries(recipient)) if (v) form.append(`recipient[${k}]`, v);

  let res;
  try {
    res = await fetch(`${STANNP_API}/postcards/create`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${env.STANNP_API_KEY}:`)}` },
      body: form,
    });
  } catch (e) { return { error: `Couldn't reach Stannp: ${e && e.message}`, permanent: false }; }
  const body = await res.json().catch(() => null);
  // 409 = Stannp already has this exact request (a retry); it returns the original result.
  if ((res.ok || res.status === 409) && body && body.success && body.data) return { data: body.data };
  const msg = (body && (body.error || body.message)) || `Stannp said ${res.status}`;
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 409;
  return { error: `Stannp: ${String(msg).slice(0, 300)}`, permanent };
}

async function spentToday(env, day) {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(cost),0) AS spent, COUNT(*) AS n FROM print_jobs WHERE mode='live' AND spend_day=? AND status != 'cancelled'`).bind(day).first();
  return { spent: Number(r?.spent || 0), count: Number(r?.n || 0) };
}

async function processQueue(env, s) {
  const out = { sent: 0, proofs: 0, flagged: [], capHit: false };
  if (s.mode === 'off') return out;
  if (!env.STANNP_API_KEY) {
    await alertOnce(env, `nokey-${ukDay()}`, 'Stannp key missing', 'STANNP_MODE is on, but the STANNP_API_KEY secret is missing, so nothing can be sent. Add the secret in Cloudflare → savourly-print → Settings → Variables and Secrets.');
    return out;
  }
  const { results: jobs } = await env.DB.prepare(
    `SELECT j.*, o.customer_name, o.customer_email, o.shipping_address, o.status AS order_status
     FROM print_jobs j JOIN orders o ON o.order_ref = j.order_ref
     WHERE j.status='queued' ORDER BY j.id ASC LIMIT ?`
  ).bind(MAX_JOBS_PER_RUN).all();
  const files = new Map();
  const day = ukDay();
  let { spent } = await spentToday(env, day);

  for (const job of jobs) {
    const order = job;
    const flag = async (msg, attempts = job.attempts) => {
      await env.DB.prepare(`UPDATE print_jobs SET status='needs_attention', attempts=?, last_error=?, updated_at=? WHERE id=? AND status IN ('queued','sending')`).bind(attempts, msg, nowIso(), job.id).run();
      out.flagged.push(`${job.job_key} (${job.product_id || '?'} ${job.style || ''}): ${msg}`);
    };
    if (order.order_status !== 'paid') { await flag(`The order is now "${order.order_status}", not paid.`); continue; }
    const mode = modeForOrder(s, order);
    if (mode === 'off') continue;
    if (mode === 'live' && spent + EST_LIVE_COST > s.cap) { out.capHit = true; continue; } // waits until midnight

    const recipient = parseRecipient(order.customer_name, order.shipping_address);
    if (!recipient) { await flag(`Couldn't read the name or address ("${String(order.shipping_address || '').slice(0, 120)}"). Check it, then Retry.`); continue; }

    // Claim the card. If the order log cancelled it a moment ago, this changes nothing and we skip it.
    const claim = await env.DB.prepare(`UPDATE print_jobs SET status='sending', updated_at=? WHERE id=? AND status='queued'`).bind(nowIso(), job.id).run();
    if (!claim?.meta?.changes) continue;

    const file = `${job.product_id}-${styleSlug(job.style)}.pdf`;
    if (!files.has(file)) files.set(file, await fetchPrintFile(env, file));
    const pf = files.get(file);
    const result = pf.error ? pf : await sendToStannp(env, s, job, order, recipient, pf.bytes, file, mode);

    if (result.error) {
      const attempts = job.attempts + 1;
      if (result.permanent || attempts >= MAX_ATTEMPTS) await flag(result.error, attempts);
      else await env.DB.prepare(`UPDATE print_jobs SET status='queued', attempts=?, last_error=?, updated_at=? WHERE id=?`).bind(attempts, result.error, nowIso(), job.id).run();
      continue;
    }
    const d = result.data;
    const cost = Number(d.cost) || 0;
    await env.DB.prepare(
      `UPDATE print_jobs SET status=?, mode=?, stannp_id=?, proof_url=?, cost=?, spend_day=?, attempts=?, last_error=NULL, sent_at=?, updated_at=? WHERE id=?`
    ).bind(mode === 'live' ? 'sent' : 'proof', mode, Number(d.id) || 0, d.pdf || null, cost, day, job.attempts + 1, nowIso(), nowIso(), job.id).run();
    if (mode === 'live') { spent += cost; out.sent++; } else out.proofs++;
  }
  return { ...out, spent };
}

async function runOnce(env) {
  const s = settings(env);
  const day = ukDay();
  // A run that stopped mid-send leaves a card "sending"; put it back after 10 minutes.
  // Stannp's idempotency key means a resend can never post the same card twice.
  await env.DB.prepare(`UPDATE print_jobs SET status='queued', updated_at=? WHERE status='sending' AND updated_at < ?`)
    .bind(nowIso(), new Date(Date.now() - 10 * 60000).toISOString()).run();
  const queueFlagged = await queueNewOrders(env);
  const out = await processQueue(env, s);
  out.flagged.unshift(...queueFlagged);
  const spent = out.spent ?? (await spentToday(env, day)).spent;

  if (out.flagged.length) {
    await alertOnce(env, `attention-${out.flagged.join('|').slice(0, 400)}`, `${out.flagged.length} card${out.flagged.length === 1 ? ' needs' : 's need'} attention`,
      `These cards couldn't be sent to Stannp and are waiting in the order log:\n\n${out.flagged.map((f) => `• ${f}`).join('\n')}\n\nFix the problem, then press Retry on the Printing tab (or mark them done by hand).`);
  }
  if (out.capHit) {
    const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE status='queued'`).first();
    await alertOnce(env, `cap-${day}`, `daily cap of ${money(s.cap)} reached — printing paused`,
      `Today's live printing has reached ${money(spent)} of the ${money(s.cap)} daily cap, so live cards are paused until midnight (UK time).\n${n} card${n === 1 ? '' : 's'} waiting.\n\nIf this is expected, raise DAILY_CAP_GBP in Cloudflare → savourly-print → Settings → Variables; if not, set STANNP_MODE to off and check the Printing tab.`);
  } else if (spent >= 0.8 * s.cap) {
    await alertOnce(env, `warn-${day}`, `80% of today's cap used`, `Live printing today has reached ${money(spent)} of the ${money(s.cap)} daily cap. If that's more than you expect, set STANNP_MODE to off and check the Printing tab.`);
  }

  // What the order log shows at the top of the Printing tab.
  await setSetting(env, 'status', JSON.stringify({
    mode: s.mode, stripeLive: s.stripeLive, liveOnly: s.liveOnly.length > 0, cap: s.cap, spent, day,
    capHit: out.capHit, emailReady: !!(env.EMAIL && env.ALERT_TO), keyReady: !!env.STANNP_API_KEY, lastRun: nowIso(),
  }));
  return out;
}

// ---- Stannp status webhook ----
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function validStannpSignature(env, rawBody, header) {
  if (!env.STANNP_WEBHOOK_SECRET || !header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STANNP_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = btoa(String.fromCharCode(...mac));
  const got = header.trim().replace(/^sha256=/i, '');
  return timingSafeEqual(got.toLowerCase(), hex) || timingSafeEqual(got, b64); // Stannp's docs don't say hex or base64
}

async function handleStannpWebhook(request, env) {
  const raw = await request.text();
  if (!(await validStannpSignature(env, raw, request.headers.get('x-stannp-signature')))) return new Response('Invalid signature', { status: 401 });
  let event;
  try { event = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  if (event.event === 'mailpiece_status' && Array.isArray(event.mailpieces)) {
    const returned = [];
    for (const m of event.mailpieces.slice(0, 50)) {
      const id = Number(m && m.id), status = String((m && m.status) || '').toLowerCase();
      if (!id || !LIVE_STATUSES.includes(status)) continue;
      await env.DB.prepare(`UPDATE print_jobs SET status=?, updated_at=? WHERE stannp_id=? AND mode='live'`).bind(status, nowIso(), id).run();
      if (status === 'returned') returned.push(id);
    }
    if (returned.length) {
      await alertOnce(env, `returned-${returned.join(',')}`, `${returned.length} card${returned.length === 1 ? ' was' : 's were'} returned`,
        `Royal Mail returned Stannp mailpiece${returned.length === 1 ? '' : 's'} ${returned.join(', ')}. Check the address in the order log and contact the customer.`);
    }
  }
  return new Response('ok'); // test_url and anything else: just say OK
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/stannp-webhook') {
      try { return await handleStannpWebhook(request, env); }
      catch (e) { console.error('Stannp webhook error:', e && e.message); return new Response('error', { status: 500 }); }
    }
    return new Response('Not found', { status: 404 });
  },

  // Cron Trigger (every 5 minutes).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env).catch((e) => console.error('Print run failed:', e && e.message)));
  },
};
