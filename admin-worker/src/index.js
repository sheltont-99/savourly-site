/**
 * Savourly admin — your private orders page.
 * This Worker must be protected with Cloudflare Access (the "Protect with
 * Cloudflare Access" switch). Only people you allow can reach it at all.
 * Needs one binding: DB -> savourly-orders.
 */

// Your master product list, published with the website.
const PRODUCTS_URL = 'https://sheltont-99.github.io/savourly-site/products.json';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// An ID with a small copy-to-clipboard button next to it.
function idTag(id) {
  const v = escapeHtml(id);
  return `<span class="idw"><code class="pid">${v}</code><button type="button" class="cp" data-copy="${v}" title="Copy ${v}" aria-label="Copy ${v}"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></span>`;
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
      <div class="top"><strong class="ref">${escapeHtml(o.order_ref)}<button type="button" class="cp" data-copy="${escapeHtml(o.order_ref)}" title="Copy ${escapeHtml(o.order_ref)}" aria-label="Copy ${escapeHtml(o.order_ref)}"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></strong><span class="dim">${escapeHtml(fmtDate(o.created_at))}</span>${badge}</div>
      <ul class="items">${items.map((i) => `<li><span>${i.id ? idTag(i.id) : ''}${escapeHtml(i.style ? `${i.name} — ${i.style}` : i.name)}</span><b>× ${Number(i.qty)}</b></li>`).join('')}</ul>
      <div class="addr"><b>${escapeHtml(o.customer_name)}</b><br>${escapeHtml(o.shipping_address)}<br><span class="dim">${escapeHtml(o.customer_email)}</span></div>
      <div class="foot"><span class="total">£${Number(o.total).toFixed(2)}</span>${stripe}${action}</div>
    </article>`;
  }).join('');

  const empty = view === 'topost' ? 'Nothing waiting to be posted. 🎉' : 'No orders here yet.';
  return shell(view, c, cards || `<div class="empty">${empty}</div>`);
}

function tabs(view, c) {
  const t = (key, label, n) => `<a class="tab ${view === key ? 'on' : ''}" href="/?view=${key}">${label}${n == null ? '' : ` <span>${n}</span>`}</a>`;
  return t('topost', 'To post', c.topost) + t('posted', 'Posted', c.posted) + t('all', 'All', c.all) + t('products', 'Products', c.products);
}

function shell(view, c, body) {
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
  .items li b{white-space:nowrap}
  @media (max-width:480px){.tabs{gap:2px}.tab{padding:9px 9px;font-size:.84rem}.tab span{padding:1px 6px;margin-left:3px}}
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
  .pid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;background:#f3efe6;color:#8A5A2B;border-radius:5px;padding:2px 6px;margin-right:8px;white-space:nowrap}
  .search{width:100%;font:inherit;font-size:16px;padding:11px 14px;border:1px solid #e5dfd2;border-radius:10px;background:#fff}
  .group{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.07);overflow:hidden}
  .group h2{font-size:.95rem;margin:0;padding:12px 16px;background:#f7f3ea}
  .prow{display:grid;grid-template-columns:64px 128px minmax(0,1fr) 80px 80px;gap:16px;align-items:center;padding:12px 22px;border-top:1px solid #f1ede4;font-size:.95rem}
  .prow > span:nth-child(4),.prow > span:nth-child(5){text-align:right}
  .phead{padding-top:8px;padding-bottom:8px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;background:#fcfbf7}
  .hbox{width:20px;height:20px;border:2px solid #cfc6b3;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:#fff;margin-left:10px}
  .hbox.on{background:#8b93a1;border-color:#8b93a1}
  .v-products main{max-width:1100px}
  @media (max-width:600px){.prow{grid-template-columns:44px 108px minmax(0,1fr) 44px 46px;gap:8px;padding:10px 12px;font-size:.88rem}.phead{font-size:.6rem;letter-spacing:.02em}.hbox{margin-left:10px}}
  .prow .sold{color:#6b7280;font-size:.82rem}
  .prow .sold b{color:#166534}
  .prow.is-hidden > span:not(.hbox),.prow.is-hidden .pid{opacity:.55}
  .hint{margin:0;color:#6b7280;font-size:.85rem}
  .idw{display:inline-flex;align-items:center;gap:2px;white-space:nowrap;vertical-align:middle}
  .idw .pid{margin-right:0}
  .cp{border:0;background:none;padding:3px;margin:0 6px 0 0;border-radius:5px;cursor:pointer;color:#b3a78e;display:inline-flex;vertical-align:middle}
  .cp:hover{background:#f3efe6;color:#8A5A2B}
  .cp svg,.ic{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .ic{width:13px;height:13px;vertical-align:-2px;color:#8A5A2B}
  .cp.ok{color:#166534}
  .cp.ok svg{display:none}
  .cp.ok::after{content:'✓';font-size:.8rem;font-weight:700;line-height:15px;width:15px;text-align:center}
  .ref{display:inline-flex;align-items:center;gap:2px}
  .group h2{display:flex;align-items:center;gap:10px}
  .group h2 .pid{font-size:.75rem}
  .hid{font-size:.72rem;font-weight:600;background:#f3f4f6;color:#6b7280;border-radius:99px;padding:2px 8px;margin-left:6px}
  /* Orders views: wide, one thin row per order on bigger screens */
  .v-orders main{max-width:1280px}
  @media (min-width:900px){
    .v-orders main{gap:8px}
    .v-orders .order{display:grid;grid-template-columns:150px minmax(0,1fr) 280px 190px;gap:24px;align-items:center;padding:10px 18px}
    .v-orders .top{flex-direction:column;align-items:flex-start;gap:2px}
    .v-orders .pill{margin-left:0}
    .v-orders .items{margin:0;border-top:0}
    .v-orders .items li{padding:3px 0;border-bottom:0;font-size:.9rem}
    .v-orders .addr{font-size:.85rem;line-height:1.35}
    .v-orders .foot{margin-top:0;justify-content:flex-end;gap:10px 14px}
    .v-orders .foot form{margin-left:0}
    .v-orders .btn,.v-orders .btn-ghost{padding:8px 12px;font-size:.85rem}
  }
</style></head><body class="${view === 'products' ? 'v-products' : 'v-orders'}">
<header><h1>Savourly orders</h1><nav class="tabs">${tabs(view, c)}</nav></header>
<main>${body}</main>
<script>
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.cp'); if (!b) return;
    const text = b.dataset.copy;
    try { await navigator.clipboard.writeText(text); }
    catch (_) { const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    b.classList.add('ok'); b.title = 'Copied'; setTimeout(() => { b.classList.remove('ok'); b.title = 'Copy ' + text; }, 1200);
  });
</script>
</body></html>`, { headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' } });
}

async function productsPage(env) {
  const [catRes, c, soldRes] = await Promise.all([
    fetch(PRODUCTS_URL, { cf: { cacheTtl: 30, cacheEverything: true } }).catch(() => null),
    counts(env),
    env.DB.prepare(
      `SELECT json_extract(j.value,'$.id') AS id, SUM(json_extract(j.value,'$.qty')) AS sold
       FROM orders o, json_each(o.items_json) j WHERE o.status='paid' GROUP BY 1`
    ).all(),
  ]);
  if (!catRes || !catRes.ok) return shell('products', c, '<div class="empty">Could not load the product list.</div>');
  const cat = await catRes.json();
  const hiddenCount = cat.products.filter((p) => p.hidden).length;
  const sold = Object.fromEntries(soldRes.results.filter((r) => r.id).map((r) => [r.id, r.sold]));
  c.products = cat.products.length;

  const chefName = Object.fromEntries((cat.chefs || []).map((ch) => [ch.id, ch.name]));
  const groups = new Map();
  (cat.chefs || []).forEach((ch) => groups.set(ch.id, []));
  cat.products.forEach((p) => {
    const key = p.chefId || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const body = `<input class="search" id="q" placeholder="Search by ID, recipe or chef…" autocomplete="off">
    <p class="hint"><b>Hidden</b> ✓ = not showing on the website (${hiddenCount} hidden). To hide or show a product, ask Claude with its ID. Tap <svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg> to copy an ID.</p>` +
    [...groups].filter(([, list]) => list.length).map(([chefId, list]) => `<section class="group"><h2>${chefId ? `${escapeHtml(chefName[chefId] || 'Unknown chef')} ${idTag(chefId)}` : 'Recipe boxes'}</h2>
      <div class="prow phead"><span>Hidden</span><span>ID</span><span>Product</span><span>Price</span><span>Sold</span></div>` +
      list.map((p) => `<div class="prow${p.hidden ? ' is-hidden' : ''}" data-q="${escapeHtml(`${p.id} ${p.name} ${chefId} ${chefName[chefId] || 'recipe boxes'}`.toLowerCase())}">
        <span class="hbox${p.hidden ? ' on' : ''}" role="img" aria-label="${p.hidden ? 'Hidden' : 'On site'}" title="${p.hidden ? 'Hidden from the website' : 'Showing on the website'}">${p.hidden ? '✓' : ''}</span>
        ${idTag(p.id)}<span>${escapeHtml(p.name)}${p.hidden ? ' <span class="hid">Hidden</span>' : ''}</span><span>£${Number(p.price).toFixed(2)}</span>
        <span class="sold">${sold[p.id] ? `<b>${sold[p.id]} sold</b>` : '0 sold'}</span></div>`).join('') +
      `</section>`).join('') +
    `<script>
      const q = document.getElementById('q');
      q.addEventListener('input', () => {
        const v = q.value.trim().toLowerCase();
        document.querySelectorAll('.prow[data-q]').forEach(r => r.style.display = r.dataset.q.includes(v) ? '' : 'none');
        document.querySelectorAll('.group').forEach(g => g.style.display = [...g.querySelectorAll('.prow[data-q]')].some(r => r.style.display !== 'none') ? '' : 'none');
      });
    </script>`;
  return shell('products', c, body);
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
    if (request.method === 'GET' && url.pathname === '/') {
      const view = url.searchParams.get('view') || 'topost';
      return view === 'products' ? productsPage(env) : page(env, view);
    }
    return new Response('Not found', { status: 404 });
  },
};
