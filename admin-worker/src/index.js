/**
 * Savourly admin — your private orders page.
 * This Worker must be protected with Cloudflare Access (the "Protect with
 * Cloudflare Access" switch). Only people you allow can reach it at all.
 * Needs one binding: DB -> savourly-orders.
 */

// Your master product list, published with the website.
const PRODUCTS_URL = 'https://sheltont-99.github.io/savourly-site/products.json';

// With a GITHUB_TOKEN secret, the Products tab reads/writes products.json in the repo directly,
// so the "On site" tick boxes can hide/unhide products. Without it, the tab is read-only.
const REPO = 'sheltont-99/savourly-site';
const FILE = 'products.json';

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'savourly-admin',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}
// Returns { cat, sha } — sha is null when read from the public site instead of GitHub.
async function loadCatalog(env) {
  if (env.GITHUB_TOKEN) {
    const res = await github(env, `contents/${FILE}?ref=main`);
    if (res.ok) {
      const j = await res.json();
      return { cat: JSON.parse(b64ToUtf8(j.content)), sha: j.sha };
    }
  }
  const res = await fetch(PRODUCTS_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!res.ok) throw new Error('Could not load the product list');
  return { cat: await res.json(), sha: null };
}

async function setVisibility(request, env) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  if (!env.GITHUB_TOKEN) return Response.json({ error: 'No GITHUB_TOKEN secret set on savourly-admin.' }, { status: 400 });
  const { id, visible } = await request.json();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cat, sha } = await loadCatalog(env);
    if (!sha) return Response.json({ error: 'Could not read products.json from GitHub — check the token.' }, { status: 502 });
    const p = cat.products.find((x) => x.id === id);
    if (!p) return Response.json({ error: `No product ${id}` }, { status: 404 });
    if (!!p.hidden === !visible) return Response.json({ ok: true, unchanged: true });
    if (visible) delete p.hidden; else p.hidden = true;
    const res = await github(env, `contents/${FILE}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `${visible ? 'Show' : 'Hide'} ${id} ${p.name} (from order log)`,
        content: utf8ToB64(JSON.stringify(cat, null, 2) + '\n'),
        sha,
        branch: 'main',
      }),
    });
    if (res.ok) return Response.json({ ok: true });
    if (res.status !== 409) {
      const e = await res.json().catch(() => ({}));
      return Response.json({ error: e.message || `GitHub said ${res.status}` }, { status: 502 });
    }
    // 409 = someone else changed the file a moment ago; reload and try once more
  }
  return Response.json({ error: 'The product list changed at the same time — please try again.' }, { status: 409 });
}

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
      <ul class="items">${items.map((i) => `<li><span>${i.id ? `<code class="pid">${escapeHtml(i.id)}</code>` : ''}${escapeHtml(i.style ? `${i.name} — ${i.style}` : i.name)}</span><b>× ${Number(i.qty)}</b></li>`).join('')}</ul>
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
  .prow{display:grid;grid-template-columns:auto auto 1fr auto auto;gap:12px;align-items:center;padding:10px 16px;border-top:1px solid #f1ede4;font-size:.92rem}
  .prow .sold{color:#6b7280;font-size:.82rem;min-width:52px;text-align:right}
  .prow .sold b{color:#166534}
  .live{display:flex;align-items:center;cursor:pointer}
  .live input{width:20px;height:20px;accent-color:#B8862B;cursor:pointer;margin:0}
  .prow.is-hidden > span,.prow.is-hidden .pid{opacity:.55}
  .prow.saving{opacity:.5}
  .hint{margin:0;color:#6b7280;font-size:.85rem}
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
</body></html>`, { headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' } });
}

async function productsPage(env) {
  const [catResult, c, soldRes] = await Promise.all([
    loadCatalog(env).catch(() => null),
    counts(env),
    env.DB.prepare(
      `SELECT json_extract(j.value,'$.id') AS id, SUM(json_extract(j.value,'$.qty')) AS sold
       FROM orders o, json_each(o.items_json) j WHERE o.status='paid' GROUP BY 1`
    ).all(),
  ]);
  if (!catResult) return shell('products', c, '<div class="empty">Could not load the product list.</div>');
  const { cat, sha } = catResult;
  const editable = !!sha;
  const sold = Object.fromEntries(soldRes.results.filter((r) => r.id).map((r) => [r.id, r.sold]));
  c.products = cat.products.length;

  const groups = {};
  cat.products.forEach((p) => { (groups[p.chef || 'Recipe boxes'] ||= []).push(p); });
  const body = `<input class="search" id="q" placeholder="Search by ID, recipe or chef…" autocomplete="off">
    <p class="hint">${editable
      ? '<b>On site</b>: ticked products show on the website. Untick to hide one — the site updates within about 2 minutes.'
      : 'Tick boxes are read-only until a <b>GITHUB_TOKEN</b> secret is added to savourly-admin.'}</p>` +
    Object.entries(groups).map(([chef, list]) => `<section class="group"><h2>${escapeHtml(chef)}</h2>` +
      list.map((p) => `<div class="prow${p.hidden ? ' is-hidden' : ''}" data-q="${escapeHtml(`${p.id} ${p.name} ${chef}`.toLowerCase())}">
        <label class="live" title="Show on website"><input type="checkbox" data-id="${escapeHtml(p.id)}" ${p.hidden ? '' : 'checked'} ${editable ? '' : 'disabled'}></label>
        <code class="pid">${escapeHtml(p.id)}</code><span>${escapeHtml(p.name)}${p.hidden ? ' <span class="hid">Hidden</span>' : ''}</span><span>£${Number(p.price).toFixed(2)}</span>
        <span class="sold">${sold[p.id] ? `<b>${sold[p.id]} sold</b>` : '0 sold'}</span></div>`).join('') +
      `</section>`).join('') +
    `<script>
      const q = document.getElementById('q');
      q.addEventListener('input', () => {
        const v = q.value.trim().toLowerCase();
        document.querySelectorAll('.prow').forEach(r => r.style.display = r.dataset.q.includes(v) ? '' : 'none');
        document.querySelectorAll('.group').forEach(g => g.style.display = [...g.querySelectorAll('.prow')].some(r => r.style.display !== 'none') ? '' : 'none');
      });
      document.querySelectorAll('.live input').forEach(box => box.addEventListener('change', async () => {
        const row = box.closest('.prow'), visible = box.checked;
        box.disabled = true; row.classList.add('saving');
        try {
          const res = await fetch('/visibility', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: box.dataset.id, visible }) });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'Save failed');
          row.classList.toggle('is-hidden', !visible);
          const tag = row.querySelector('.hid');
          if (!visible && !tag) row.children[2].insertAdjacentHTML('beforeend', ' <span class="hid">Hidden</span>');
          if (visible && tag) tag.remove();
        } catch (e) {
          box.checked = !visible;
          alert('Could not update ' + box.dataset.id + ': ' + e.message);
        } finally { box.disabled = false; row.classList.remove('saving'); }
      }));
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
    if (request.method === 'POST' && url.pathname === '/visibility') return setVisibility(request, env);
    if (request.method === 'GET' && url.pathname === '/') {
      const view = url.searchParams.get('view') || 'topost';
      return view === 'products' ? productsPage(env) : page(env, view);
    }
    return new Response('Not found', { status: 404 });
  },
};
