/**
 * Savourly admin — your private orders page.
 * This Worker must be protected with Cloudflare Access (the "Protect with
 * Cloudflare Access" switch). Only people you allow can reach it at all.
 * Needs one binding: DB -> savourly-orders.
 */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const VIEWS = {
  topost: { label: 'To post', where: "status='paid' AND posted_at IS NULL", order: 'created_at ASC' },
  posted: { label: 'Posted', where: "status='paid' AND posted_at IS NOT NULL", order: 'posted_at DESC' },
  all: { label: 'All', where: '1=1', order: 'created_at DESC' },
};

async function counts(env) {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='paid' AND posted_at IS NULL THEN 1 ELSE 0 END) AS topost,
       SUM(CASE WHEN status='paid' AND posted_at IS NOT NULL THEN 1 ELSE 0 END) AS posted,
       COUNT(*) AS allc
     FROM orders`
  ).first();
  return { topost: row?.topost || 0, posted: row?.posted || 0, all: row?.allc || 0 };
}

async function page(env, view) {
  const v = VIEWS[view] || VIEWS.topost;
  const { results } = await env.DB.prepare(`SELECT * FROM orders WHERE ${v.where} ORDER BY ${v.order} LIMIT 500`).all();
  const c = await counts(env);

  const cards = results.map((o) => {
    const items = JSON.parse(o.items_json || '[]');
    const posted = !!o.posted_at;
    const paid = o.status === 'paid';
    const stripe = o.stripe_payment_intent
      ? `<a href="https://dashboard.stripe.com/test/payments/${encodeURIComponent(o.stripe_payment_intent)}" target="_blank" rel="noopener">View in Stripe ↗</a>`
      : '';
    const action = paid
      ? `<form method="post" action="/${posted ? 'unpost' : 'post'}">
           <input type="hidden" name="ref" value="${escapeHtml(o.order_ref)}">
           <input type="hidden" name="view" value="${escapeHtml(view)}">
           <button class="${posted ? 'btn-ghost' : 'btn'}">${posted ? 'Undo posted' : 'Mark as posted'}</button>
         </form>`
      : '';
    const badge = !paid
      ? `<span class="pill pill-${escapeHtml(o.status)}">${o.status === 'pending' ? 'Not paid' : escapeHtml(o.status)}</span>`
      : posted ? `<span class="pill pill-posted">Posted ${escapeHtml(fmtDate(o.posted_at))}</span>` : `<span class="pill pill-paid">Paid</span>`;

    return `<article class="order">
      <div class="top"><strong>${escapeHtml(o.order_ref)}</strong><span class="dim">${escapeHtml(fmtDate(o.created_at))}</span>${badge}</div>
      <ul class="items">${items.map((i) => `<li><span>${escapeHtml(i.name)}</span><b>× ${Number(i.qty)}</b></li>`).join('')}</ul>
      <div class="addr"><b>${escapeHtml(o.customer_name)}</b><br>${escapeHtml(o.shipping_address)}<br><span class="dim">${escapeHtml(o.customer_email)}</span></div>
      <div class="foot"><span class="total">£${Number(o.total).toFixed(2)}</span>${stripe}${action}</div>
    </article>`;
  }).join('');

  const tab = (key) => `<a class="tab ${view === key ? 'on' : ''}" href="/?view=${key}">${VIEWS[key].label} <span>${c[key === 'all' ? 'all' : key]}</span></a>`;
  const empty = view === 'topost' ? 'Nothing waiting to be posted. 🎉' : 'No orders here yet.';

  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Savourly orders">
<meta name="theme-color" content="#faf7f0">
<title>Savourly orders</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#faf7f0;color:#20293a}
  header{position:sticky;top:0;background:#faf7f0;padding:18px 16px 0;border-bottom:1px solid #ebe5d8;z-index:1}
  h1{margin:0 0 12px;font-size:1.3rem}
  .tabs{display:flex;gap:6px;overflow-x:auto}
  .tab{padding:9px 14px;border-radius:10px 10px 0 0;text-decoration:none;color:#6b7280;font-weight:600;font-size:.92rem;white-space:nowrap}
  .tab span{background:#ebe5d8;border-radius:99px;padding:1px 8px;margin-left:4px;font-size:.78rem}
  .tab.on{color:#20293a;background:#fff;box-shadow:0 -1px 0 #ebe5d8 inset}
  .tab.on span{background:#B8862B;color:#fff}
  main{max-width:760px;margin:0 auto;padding:16px;display:grid;gap:12px}
  .order{background:#fff;border-radius:12px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
  .top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .dim{color:#9ca3af;font-size:.82rem}
  .items{list-style:none;margin:12px 0;padding:0;border-top:1px solid #f1ede4}
  .items li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #f1ede4;font-size:.95rem}
  .addr{font-size:.92rem;line-height:1.45}
  .foot{display:flex;align-items:center;gap:14px;margin-top:12px;flex-wrap:wrap}
  .foot form{margin-left:auto}
  .total{font-weight:700}
  .foot a{color:#8A5A2B;font-size:.85rem}
  .btn,.btn-ghost{font:inherit;font-weight:600;border-radius:9px;padding:10px 16px;cursor:pointer;border:0}
  .btn{background:#B8862B;color:#fff}
  .btn-ghost{background:#f3efe6;color:#6b7280}
  .pill{padding:3px 9px;border-radius:99px;font-size:.75rem;font-weight:600;margin-left:auto}
  .pill-paid{background:#fef3c7;color:#92400e}
  .pill-posted{background:#dcfce7;color:#166534}
  .pill-pending,.pill-expired{background:#f3f4f6;color:#6b7280}
  .empty{text-align:center;color:#9ca3af;padding:48px 0}
</style></head><body>
<header><h1>Savourly orders</h1><nav class="tabs">${tab('topost')}${tab('posted')}${tab('all')}</nav></header>
<main>${cards || `<div class="empty">${empty}</div>`}</main>
</body></html>`, { headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' } });
}

async function setPosted(request, env, posted) {
  // Only accept form posts coming from this page itself.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  const form = await request.formData();
  const ref = String(form.get('ref') || '');
  const view = VIEWS[form.get('view')] ? form.get('view') : 'topost';
  await env.DB.prepare(`UPDATE orders SET posted_at=? WHERE order_ref=? AND status='paid'`)
    .bind(posted ? new Date().toISOString() : null, ref).run();
  return Response.redirect(new URL(`/?view=${view}`, request.url).toString(), 303);
}

export default {
  async fetch(request, env) {
    // Seatbelt: Cloudflare Access adds this header to every request it lets through.
    // If Access is ever switched off by mistake, the page refuses to show anything.
    if (!request.headers.get('cf-access-jwt-assertion')) {
      return new Response('This page must be protected with Cloudflare Access. Turn it on in the Worker settings.', { status: 403 });
    }
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/post') return setPosted(request, env, true);
    if (request.method === 'POST' && url.pathname === '/unpost') return setPosted(request, env, false);
    if (request.method === 'GET' && url.pathname === '/') return page(env, url.searchParams.get('view') || 'topost');
    return new Response('Not found', { status: 404 });
  },
};
