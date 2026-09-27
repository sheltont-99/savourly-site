/**
 * Savourly checkout worker
 * ------------------------
 * Three routes:
 *   POST /api/create-checkout-session   site -> here: cart -> Stripe Checkout Session (redirect URL back)
 *   POST /api/stripe-webhook            Stripe -> here: marks the matching order "paid"
 *   GET  /orders                        you -> here: password-protected HTML dashboard of every order
 *   GET  /api/orders.json               you -> here: same data as JSON (for exporting / scripts)
 *
 * No Stripe Product/Price objects are ever created — every recipe card + style
 * combination is sent to Stripe as one-off `price_data` at checkout time, so the
 * number of distinct designs on the site is unlimited and never touches Stripe's
 * catalog. The order's own item list is stored here, in D1, keyed by an order_ref
 * you can also see for that payment inside Stripe's dashboard.
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

// ---- Pricing is decided HERE, never trusted from the browser ----
// The browser only tells us *what* is in the cart; anyone can edit that request,
// so every price is looked up server-side. Keep these in step with index.html.
const PRICING = {
  currency: 'gbp',
  postage: 1.49,
  card: { price: 1.99, styles: ['Classic', 'Funky', 'Fine Dining'] },
  box: {
    styles: ['Kraft Wrap', 'Gift Ribbon', 'Keepsake Tin'],
    prices: { 'Starter Box': 12.00, "Chef's Choice Box": 18.00, "Collector's Box": 29.00 },
  },
  maxQtyPerLine: 50,
};

// Cart item names look like "Kelewele — Funky" or "Starter Box — Gift Ribbon".
// Returns the trusted server-side unit price, or null if the item isn't valid.
function priceFor(name) {
  if (typeof name !== 'string') return null;
  const sep = name.lastIndexOf(' — ');
  if (sep < 1) return null;
  const base = name.slice(0, sep).trim();
  const style = name.slice(sep + 3).trim();
  if (base in PRICING.box.prices) {
    return PRICING.box.styles.includes(style) ? PRICING.box.prices[base] : null;
  }
  return PRICING.card.styles.includes(style) && base.length <= 120 ? PRICING.card.price : null;
}

function orderRef() {
  const rand = crypto.randomUUID().split('-')[0];
  return 'SV-' + rand.toUpperCase();
}

// Stripe's API takes application/x-www-form-urlencoded with bracket notation
// for nested objects/arrays. This flattens a JS object into that form.
function toFormParams(obj, prefix = '') {
  const params = new URLSearchParams();
  function walk(value, path) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (typeof value === 'object') {
      Object.entries(value).forEach(([k, v]) => walk(v, path ? `${path}[${k}]` : k));
    } else {
      params.append(path, String(value));
    }
  }
  walk(obj, prefix);
  return params;
}

async function stripeRequest(env, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Stripe API error (${res.status})`);
  }
  return data;
}

async function handleCreateCheckoutSession(request, env) {
  const body = await request.json();
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const customer = body.customer || {};
  if (rawItems.length === 0 || rawItems.length > 100) return json({ error: 'Cart is empty or too large.' }, 400);

  // Rebuild every line with a trusted price; reject anything unrecognised.
  const items = [];
  for (const i of rawItems) {
    const price = priceFor(i?.name);
    const qty = Number(i?.qty);
    if (price === null || !Number.isInteger(qty) || qty < 1 || qty > PRICING.maxQtyPerLine) {
      return json({ error: `Unrecognised cart item: ${String(i?.name).slice(0, 80)}` }, 400);
    }
    items.push({ name: i.name, price, qty });
  }

  const postage = PRICING.postage;
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const total = subtotal + postage;
  const ref = orderRef();

  const lineItems = items.map((i) => ({
    price_data: {
      currency: 'gbp',
      unit_amount: Math.round(i.price * 100),
      product_data: { name: i.name }, // <- this is what you'll see against the payment in Stripe
    },
    quantity: i.qty,
  }));
  lineItems.push({
    price_data: { currency: 'gbp', unit_amount: Math.round(postage * 100), product_data: { name: 'Postage' } },
    quantity: 1,
  });

  const siteUrl = env.SITE_URL.replace(/\/$/, '');
  const session = await stripeRequest(env, 'checkout/sessions', toFormParams({
    mode: 'payment',
    'line_items': lineItems,
    success_url: `${siteUrl}/#order-success?ref=${ref}`,
    cancel_url: `${siteUrl}/#cart`,
    customer_email: customer.email || undefined,
    metadata: { order_ref: ref },
  }));

  await env.DB.prepare(
    `INSERT INTO orders (order_ref, stripe_session_id, status, customer_name, customer_email, shipping_address, items_json, subtotal, postage, total, currency, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 'gbp', ?)`
  ).bind(
    ref,
    session.id,
    String(customer.name || '').slice(0, 200) || null,
    String(customer.email || '').slice(0, 200) || null,
    String(customer.address || '').slice(0, 500) || null,
    JSON.stringify(items),
    subtotal,
    postage,
    total,
    new Date().toISOString()
  ).run();

  return json({ url: session.url, order_ref: ref });
}

async function verifyStripeSignature(request, env) {
  const sig = request.headers.get('stripe-signature') || '';
  const rawBody = await request.text();
  const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return { valid: false, rawBody };

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Reject events more than 5 minutes old (replay protection), compare in constant time.
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  let diff = hex.length ^ expected.length;
  for (let i = 0; i < Math.min(hex.length, expected.length); i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return { valid: fresh && diff === 0, rawBody };
}

async function handleWebhook(request, env) {
  const { valid, rawBody } = await verifyStripeSignature(request, env);
  if (!valid) return json({ error: 'Invalid signature' }, 400);

  const event = JSON.parse(rawBody);

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const ref = session.metadata?.order_ref;
    if (ref) {
      await env.DB.prepare(
        `UPDATE orders SET status='paid', stripe_payment_intent=?, paid_at=? WHERE order_ref=?`
      ).bind(session.payment_intent || null, new Date().toISOString(), ref).run();
    }
  }
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const ref = session.metadata?.order_ref;
    if (ref) {
      await env.DB.prepare(`UPDATE orders SET status='expired' WHERE order_ref=?`).bind(ref).run();
    }
  }

  return json({ received: true });
}

function checkAuth(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  const decoded = atob(auth.slice(6));
  const [, password] = decoded.split(':');
  return password === env.ADMIN_PASSWORD;
}

function unauthorized() {
  return new Response('Auth required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Savourly orders"' } });
}

async function fetchOrders(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 500`).all();
  return results.map((r) => ({ ...r, items: JSON.parse(r.items_json) }));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function handleOrdersPage(env) {
  const orders = await fetchOrders(env);
  const rows = orders.map((o) => `
    <tr>
      <td>${escapeHtml(o.order_ref)}</td>
      <td>${escapeHtml(o.created_at?.slice(0, 16).replace('T', ' '))}</td>
      <td><span class="pill pill-${o.status}">${escapeHtml(o.status)}</span></td>
      <td>${escapeHtml(o.customer_name)}<br><span class="dim">${escapeHtml(o.customer_email)}</span></td>
      <td>${escapeHtml(o.shipping_address)}</td>
      <td>${o.items.map((i) => `${escapeHtml(i.name)}${i.qty > 1 ? ' × ' + i.qty : ''}`).join('<br>')}</td>
      <td>£${Number(o.total).toFixed(2)}</td>
      <td>${o.stripe_payment_intent
        ? `<a href="https://dashboard.stripe.com/test/payments/${encodeURIComponent(o.stripe_payment_intent)}" target="_blank" rel="noopener">${escapeHtml(o.stripe_payment_intent)}</a>`
        : (o.stripe_session_id ? `<a href="https://dashboard.stripe.com/test/checkout/sessions/${encodeURIComponent(o.stripe_session_id)}" target="_blank" rel="noopener">session</a>` : '—')}</td>
    </tr>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Savourly orders</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#faf7f0;color:#20293a;padding:24px;}
    h1{font-size:1.4rem;margin-bottom:4px;}
    .sub{color:#6b7280;font-size:0.9rem;margin-bottom:20px;}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    th,td{padding:10px 12px;text-align:left;font-size:0.85rem;border-bottom:1px solid #eee;vertical-align:top;}
    th{background:#f3efe6;font-weight:600;}
    .dim{color:#9ca3af;font-size:0.78rem;}
    .pill{padding:2px 8px;border-radius:99px;font-size:0.75rem;font-weight:600;}
    .pill-paid{background:#dcfce7;color:#166534;}
    .pill-pending{background:#fef3c7;color:#92400e;}
    .pill-expired,.pill-failed{background:#fee2e2;color:#991b1b;}
    a{color:#8A5A2B;}
  </style></head><body>
  <h1>Savourly orders</h1>
  <div class="sub">${orders.length} order${orders.length === 1 ? '' : 's'} · newest first · <a href="/api/orders.json">JSON</a></div>
  <div style="overflow-x:auto"><table><thead><tr><th>Ref</th><th>Date</th><th>Status</th><th>Customer</th><th>Post to</th><th>Items</th><th>Total</th><th>Stripe</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="8">No orders yet.</td></tr>'}</tbody></table></div>
  </body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsPreflight();

    if (url.pathname === '/api/create-checkout-session' && request.method === 'POST') {
      try {
        return await handleCreateCheckoutSession(request, env);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      try {
        return await handleWebhook(request, env);
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    }

    if (url.pathname === '/orders' && request.method === 'GET') {
      if (!checkAuth(request, env)) return unauthorized();
      return handleOrdersPage(env);
    }

    if (url.pathname === '/api/orders.json' && request.method === 'GET') {
      if (!checkAuth(request, env)) return unauthorized();
      return json(await fetchOrders(env));
    }

    return new Response('Not found', { status: 404 });
  },
};
