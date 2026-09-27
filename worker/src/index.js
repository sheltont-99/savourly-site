/**
 * Savourly checkout worker (public — your website and Stripe talk to it)
 * ------------------------
 *   POST /api/create-checkout-session   site -> here: cart -> Stripe Checkout Session (redirect URL back)
 *   POST /api/stripe-webhook            Stripe -> here: marks the matching order "paid"
 * Orders are viewed in the separate, Access-protected admin worker (../admin-worker).
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

// ---- Prices come from your master product list, never from the browser ----
// The browser only says *which* product IDs and styles are in the cart. Every
// price is looked up in products.json on your own site (cached for a minute).
async function loadCatalog(env) {
  const siteUrl = env.SITE_URL.replace(/\/$/, '');
  const res = await fetch(`${siteUrl}/products.json`, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error('Could not load product list');
  const data = await res.json();
  return {
    postage: data.postage,
    styles: data.styles,
    byId: Object.fromEntries(data.products.map((p) => [p.id, p])),
  };
}

const MAX_QTY_PER_LINE = 50;

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

  // Rebuild every line from the product list; reject anything unrecognised.
  const catalog = await loadCatalog(env);
  const items = [];
  for (const i of rawItems) {
    const p = catalog.byId[i?.id];
    const qty = Number(i?.qty);
    const styleOk = p && (catalog.styles[p.type] || []).includes(i?.style);
    if (!p || !styleOk || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      return json({ error: `Unrecognised cart item: ${String(i?.id).slice(0, 40)}` }, 400);
    }
    items.push({ id: p.id, name: p.name, style: i.style, chef: p.chef || null, price: p.price, qty });
  }

  const postage = catalog.postage;
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const total = subtotal + postage;
  const ref = orderRef();

  const lineItems = items.map((i) => ({
    price_data: {
      currency: 'gbp',
      unit_amount: Math.round(i.price * 100),
      product_data: { name: `${i.id} · ${i.name} — ${i.style}` }, // what you see against the payment in Stripe
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


    return new Response('Not found', { status: 404 });
  },
};
