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

// Print-ready PDFs sit in the website's images folder, one per product and style:
// images/<ID>-<style>.pdf, e.g. images/PR00007-fine-dining.pdf (boxes: -kraft-wrap, -gift-ribbon, -keepsake-tin)
const SITE_URL = 'https://sheltont-99.github.io/savourly-site';
function styleSlug(style) { return String(style || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function pdfPath(id, style) { return `images/${id}-${styleSlug(style)}.pdf`; }
function pdfLink(id, style) {
  if (!id || !style) return '';
  const path = pdfPath(id, style);
  return `<a class="pdf" href="${SITE_URL}/${encodeURI(path)}" target="_blank" rel="noopener" title="Open ${escapeHtml(path)}">PDF</a>`;
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

// ============================================================================
// Weekly Excel report
// Every Monday (Cron Trigger) the Worker builds last week's report and saves it
// into a PRIVATE GitHub repo (secret GITHUB_TOKEN, scoped to that repo only).
// It refuses to save if that repo is public, because reports hold customer
// names, emails and addresses. The Reports tab also lets you download any time.
// ============================================================================

const REPORTS_REPO = 'sheltont-99/savourly-reports';

const BOX_STYLES = ['Kraft Wrap', 'Gift Ribbon', 'Keepsake Tin'];

// ---- London dates ----
function londonParts(date) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  return Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
}
function londonOffsetMin(date) {
  try {
    const n = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(date).find((x) => x.type === 'timeZoneName').value;
    const m = n.match(/GMT([+-])(\d+)(?::(\d+))?/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  } catch { return 0; }
}
// UTC instant of 00:00 London time on the given calendar day (month 1-12; day may overflow)
function londonMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  return new Date(guess - londonOffsetMin(new Date(guess)) * 60000);
}
function londonDay(date) { const p = londonParts(date); return { y: +p.year, m: +p.month, d: +p.day }; }
function fmtLondon(iso) {
  if (!iso) return '';
  const p = londonParts(new Date(iso));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function fmtDay(date) {
  return date.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' });
}
// range: 'last' = previous Mon–Sun, 'this' = this Monday until now, 'all' = everything
function reportRange(range, now = new Date()) {
  const { y, m, d } = londonDay(now);
  const dow = (['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(londonParts(now).weekday) + 7) % 7;
  const thisMon = londonMidnight(y, m, d - dow);
  if (range === 'this') return { from: thisMon, to: now, label: `${fmtDay(thisMon)} – ${fmtDay(now)} (so far)`, file: `this-week-${londonParts(thisMon).year}-${londonParts(thisMon).month}-${londonParts(thisMon).day}` };
  if (range === 'all') return { from: null, to: now, label: `All orders to ${fmtDay(now)}`, file: 'all-orders' };
  const lastMon = londonMidnight(y, m, d - dow - 7);
  const lastSun = new Date(thisMon.getTime() - 1);
  const a = londonParts(lastMon), b = londonParts(lastSun);
  return { from: lastMon, to: thisMon, label: `${fmtDay(lastMon)} – ${fmtDay(lastSun)}`, file: `${a.year}-${a.month}-${a.day}-to-${b.year}-${b.month}-${b.day}` };
}

async function reportData(env, range) {
  const r = reportRange(range);
  const sql = r.from
    ? env.DB.prepare(`SELECT * FROM orders WHERE status='paid' AND created_at >= ? AND created_at < ? ORDER BY created_at ASC`).bind(r.from.toISOString(), r.to.toISOString())
    : env.DB.prepare(`SELECT * FROM orders WHERE status='paid' ORDER BY created_at ASC`);
  const { results } = await sql.all();
  let types = {};
  try {
    const res = await fetch(PRODUCTS_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (res.ok) types = Object.fromEntries((await res.json()).products.map((p) => [p.id, p.type]));
  } catch {}
  const orders = results.map((o) => ({ ...o, items: JSON.parse(o.items_json || '[]') }));
  return { ...r, orders, types };
}

// ---- Minimal .xlsx writer (no libraries): stored zip + SpreadsheetML ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [name, text] of files) {
    const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0)];
    const local = new Uint8Array([...u32(0x04034b50), ...common]);
    chunks.push(local, nameB, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nameB);
    offset += local.length + nameB.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const all = [...chunks, ...central, end], out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
const xmlEsc = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// Styles: 0 normal, 1 header, 2 £, 3 bold label, 4 bold £, 5 title, 6 integer
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;£&quot;#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="14"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3EFE6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFCFC6B3"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
// A cell is a string/number, or { v, s, f } (value, style, formula with cached value v)
function sheetXml(rows, widths, freezeHeader) {
  const body = rows.map((row, r) => `<row r="${r + 1}">` + row.map((cell, c) => {
    if (cell === null || cell === undefined || cell === '') return '';
    const o = typeof cell === 'object' ? cell : { v: cell };
    const ref = colName(c) + (r + 1), st = o.s ? ` s="${o.s}"` : '';
    if (o.f) return `<c r="${ref}"${st}${typeof o.v === 'number' ? '' : ' t="str"'}><f>${xmlEsc(o.f)}</f><v>${xmlEsc(o.v)}</v></c>`;
    if (typeof o.v === 'number') return `<c r="${ref}"${st}><v>${o.v}</v></c>`;
    return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(o.v)}</t></is></c>`;
  }).join('') + `</row>`).join('');
  const views = freezeHeader ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  // Prints landscape, fitted to one page wide
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${views}${cols}<sheetData>${body}</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}
function buildXlsx(sheets) {
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES_XML],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths, s.freeze)]),
  ];
  return zipStore(files);
}

function buildReport({ label, orders, types }) {
  const round = (n) => Math.round(n * 100) / 100;
  const typeOf = (i) => types[i.id] === 'box' || (!types[i.id] && BOX_STYLES.includes(i.style)) ? 'Box' : 'Card';
  const nameOf = (i) => (i.style ? i.name : String(i.name).replace(/ — [^—]+$/, ''));
  const styleOf = (i) => i.style || ((String(i.name).match(/ — ([^—]+)$/) || [])[1] || '');

  // Orders sheet
  const H = (t) => ({ v: t, s: 1 });
  const oRows = [['Order ref', 'Date (UK)', 'Status', 'Posted on', 'Customer', 'Email', 'Delivery address', 'Items', 'Subtotal', 'Postage', 'Total', 'Stripe payment'].map(H)];
  orders.forEach((o) => oRows.push([
    o.order_ref, fmtLondon(o.created_at), o.posted_at ? 'Posted' : 'To post', fmtLondon(o.posted_at),
    o.customer_name || '', o.customer_email || '', o.shipping_address || '',
    o.items.map((i) => `${i.id ? i.id + ' ' : ''}${nameOf(i)} — ${styleOf(i)} × ${i.qty}`).join('; '),
    { v: round(Number(o.subtotal) || 0), s: 2 }, { v: round(Number(o.postage) || 0), s: 2 }, { v: round(Number(o.total) || 0), s: 2 },
    o.stripe_payment_intent || '',
  ]));
  const oLast = Math.max(oRows.length, 2);

  // Items sheet (one row per line, with a formula line total)
  const iRows = [['Order ref', 'Date (UK)', 'Product ID', 'Product', 'Chef ID', 'Chef', 'Type', 'Style', 'Qty', 'Unit price', 'Line total'].map(H)];
  orders.forEach((o) => o.items.forEach((i) => {
    const r = iRows.length + 1, qty = Number(i.qty) || 0, price = round(Number(i.price) || 0);
    iRows.push([o.order_ref, fmtLondon(o.created_at), i.id || '', nameOf(i), i.chefId || '', i.chef || '', typeOf(i), styleOf(i),
      { v: qty, s: 6 }, { v: price, s: 2 }, { f: `I${r}*J${r}`, v: round(qty * price), s: 2 }]);
  }));
  const iLast = Math.max(iRows.length, 2);

  // Summary sheet (formulas point at the other sheets; cached values let previews show numbers)
  const items = iRows.slice(1);
  const qtyWhere = (t) => items.filter((r) => r[6] === t).reduce((n, r) => n + r[8].v, 0);
  const sumCol = (k) => round(oRows.slice(1).reduce((n, r) => n + r[k].v, 0));
  const toPost = oRows.slice(1).filter((r) => r[2] === 'To post').length;
  const sRows = [
    [{ v: 'Savourly orders report', s: 5 }],
    [{ v: label }],
    [],
    [{ v: 'Paid orders', s: 3 }, { f: `COUNTA(Orders!A2:A${oLast})`, v: orders.length, s: 6 }],
    [{ v: 'Still to post', s: 3 }, { f: `COUNTIF(Orders!C2:C${oLast},"To post")`, v: toPost, s: 6 }],
    [{ v: 'Cards sold', s: 3 }, { f: `SUMIFS(Items!I2:I${iLast},Items!G2:G${iLast},"Card")`, v: qtyWhere('Card'), s: 6 }],
    [{ v: 'Boxes sold', s: 3 }, { f: `SUMIFS(Items!I2:I${iLast},Items!G2:G${iLast},"Box")`, v: qtyWhere('Box'), s: 6 }],
    [{ v: 'Products subtotal', s: 3 }, { f: `SUM(Orders!I2:I${oLast})`, v: sumCol(8), s: 2 }],
    [{ v: 'Postage collected', s: 3 }, { f: `SUM(Orders!J2:J${oLast})`, v: sumCol(9), s: 2 }],
    [{ v: 'Total taken', s: 3 }, { f: `SUM(Orders!K2:K${oLast})`, v: sumCol(10), s: 4 }],
    [],
    [{ v: 'Only paid orders are included. Totals are before Stripe fees.' }],
    [],
    ['Product ID', 'Product', 'Chef', 'Qty sold', 'Sales'].map(H),
  ];
  const byId = new Map();
  items.forEach((r) => { if (!r[2]) return; const e = byId.get(r[2]) || { id: r[2], name: r[3], chef: r[5], qty: 0, sales: 0 }; e.qty += r[8].v; e.sales += r[10].v; byId.set(r[2], e); });
  [...byId.values()].sort((a, b) => b.qty - a.qty || b.sales - a.sales).forEach((e) => {
    const r = sRows.length + 1;
    sRows.push([e.id, e.name, e.chef || '', { f: `SUMIFS(Items!I2:I${iLast},Items!C2:C${iLast},A${r})`, v: e.qty, s: 6 }, { f: `SUMIFS(Items!K2:K${iLast},Items!C2:C${iLast},A${r})`, v: round(e.sales), s: 2 }]);
  });
  if (!byId.size) sRows.push([{ v: 'No paid orders in this period.' }]);

  return buildXlsx([
    { name: 'Summary', rows: sRows, widths: [22, 34, 20, 12, 12] },
    { name: 'Orders', rows: oRows, widths: [14, 17, 10, 17, 22, 28, 40, 60, 11, 10, 11, 30], freeze: true },
    { name: 'Items', rows: iRows, widths: [14, 17, 11, 30, 11, 18, 8, 13, 6, 11, 11], freeze: true },
  ]);
}

function toBase64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); }

async function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPORTS_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'savourly-admin',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

// Saves the report as reports/<year>/<from>_to_<to>.xlsx in the private repo.
async function saveReport(env, range = 'last') {
  if (!env.GITHUB_TOKEN) throw new Error('Saving to GitHub is not set up yet (the GITHUB_TOKEN secret is missing).');
  const repoRes = await gh(env, '');
  if (!repoRes.ok) throw new Error(`Can't reach the ${REPORTS_REPO} repo (GitHub said ${repoRes.status}). Check it exists and the token has access to it.`);
  const repo = await repoRes.json();
  if (!repo.private) throw new Error(`${REPORTS_REPO} is PUBLIC, so the report was not saved (it contains customer details). Make the repo private first.`);

  const data = await reportData(env, range);
  const year = data.file.slice(0, 4).match(/^\d{4}$/) ? data.file.slice(0, 4) : String(new Date().getUTCFullYear());
  const path = `reports/${year}/${data.file.replace(/-to-/, '_to_')}.xlsx`;
  const existing = await gh(env, `/contents/${path}`);
  const sha = existing.ok ? (await existing.json()).sha : undefined;
  const put = await gh(env, `/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Orders report ${data.label} (${data.orders.length} paid order${data.orders.length === 1 ? '' : 's'})`,
      content: toBase64(buildReport(data)),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) { const e = await put.json().catch(() => ({})); throw new Error(e.message || `GitHub said ${put.status}`); }
  return { path, url: `https://github.com/${REPORTS_REPO}/blob/main/${path}`, count: data.orders.length };
}

async function reportsPage(env, url) {
  const c = await counts(env);
  const ready = !!env.GITHUB_TOKEN;
  const saved = url.searchParams.get('saved'), err = url.searchParams.get('err');
  const folder = `https://github.com/${REPORTS_REPO}/tree/main/reports`;
  const last = reportRange('last'), now = reportRange('this');
  const body = `
    ${saved ? `<div class="flash ok">Saved to GitHub: <a href="https://github.com/${REPORTS_REPO}/blob/main/${escapeHtml(saved)}" target="_blank" rel="noopener">${escapeHtml(saved)}</a></div>` : ''}
    ${err ? `<div class="flash bad">${escapeHtml(err)}</div>` : ''}
    <section class="group pad">
      <h2 class="plain">Download an Excel report</h2>
      <p class="hint">Paid orders only, with three sheets: Summary (totals and best sellers), Orders and Items.</p>
      <div class="dl">
        <a class="btn" href="/report.xlsx?range=last">Last week<small>${escapeHtml(last.label)}</small></a>
        <a class="btn-ghost dlb" href="/report.xlsx?range=this">This week so far<small>${escapeHtml(now.label.replace(' (so far)', ''))}</small></a>
        <a class="btn-ghost dlb" href="/report.xlsx?range=all">All orders<small>everything to date</small></a>
      </div>
    </section>
    <section class="group pad">
      <h2 class="plain">Weekly copy saved to GitHub</h2>
      ${ready
        ? `<p><span class="pill pill-posted">On</span> Every Monday morning last week's report is saved to your private repo, in <a href="${folder}" target="_blank" rel="noopener">${escapeHtml(REPORTS_REPO)} → reports</a>, one file per week (if the Cron Trigger is set).</p>
           <form method="post" action="/report/save"><button class="btn">Save last week's report to GitHub now</button></form>`
        : `<p><span class="pill pill-pending">Not set up</span> Create the private repo <b>${escapeHtml(REPORTS_REPO)}</b>, add a <b>GITHUB_TOKEN</b> secret to this Worker and a Monday Cron Trigger (see SETUP.md).</p>`}
    </section>`;
  return shell('reports', c, body);
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
      <ul class="items">${items.map((i) => `<li><span>${i.id ? idTag(i.id) : ''}${escapeHtml(i.style ? `${i.name} — ${i.style}` : i.name)}${pdfLink(i.id, i.style)}</span><b>× ${Number(i.qty)}</b></li>`).join('')}</ul>
      <div class="addr"><b>${escapeHtml(o.customer_name)}</b><br>${escapeHtml(o.shipping_address)}<br><span class="dim">${escapeHtml(o.customer_email)}</span></div>
      <div class="foot"><span class="total">£${Number(o.total).toFixed(2)}</span>${stripe}${action}</div>
    </article>`;
  }).join('');

  const empty = view === 'topost' ? 'Nothing waiting to be posted. 🎉' : 'No orders here yet.';
  return shell(view, c, cards || `<div class="empty">${empty}</div>`);
}

function tabs(view, c) {
  const t = (key, label, n) => `<a class="tab ${view === key ? 'on' : ''}" href="/?view=${key}">${label}${n == null ? '' : ` <span>${n}</span>`}</a>`;
  return t('topost', 'To post', c.topost) + t('posted', 'Posted', c.posted) + t('all', 'All', c.all) + t('products', 'Products', c.products) + t('reports', 'Reports');
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
  @media (max-width:480px){header{padding-left:10px;padding-right:10px}.tabs{gap:0}.tab{padding:9px 7px;font-size:.8rem}.tab span{padding:1px 5px;margin-left:3px;font-size:.7rem}}
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
  .pdf{display:inline-block;margin-left:8px;padding:1px 7px;border:1px solid #d9cfbb;border-radius:5px;font-size:.72rem;font-weight:700;letter-spacing:.03em;color:#8A5A2B;text-decoration:none;vertical-align:1px}
  .pdf:hover{background:#8A5A2B;color:#fff;border-color:#8A5A2B}
  .group h2{display:flex;align-items:center;gap:10px}
  .group h2 .pid{font-size:.75rem}
  .pad{padding:18px 22px}
  .pad p{margin:8px 0 0;font-size:.92rem}
  .group h2.plain{background:none;padding:0;margin:0 0 4px}
  .dl{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .dl a{text-decoration:none;display:inline-flex;flex-direction:column;gap:2px}
  .dl small{font-weight:400;font-size:.75rem;opacity:.85}
  .dlb{color:#20293a !important}
  .pad form{margin-top:14px}
  .flash{padding:12px 16px;border-radius:10px;font-size:.92rem}
  .flash.ok{background:#dcfce7;color:#166534}
  .flash.bad{background:#fee2e2;color:#991b1b}
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
</style></head><body class="${view === 'products' || view === 'reports' ? 'v-products' : 'v-orders'}">
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
    if (request.method === 'GET' && url.pathname === '/report.xlsx') {
      const range = ['last', 'this', 'all'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : 'last';
      const data = await reportData(env, range);
      return new Response(buildReport(data), { headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="Savourly orders ${data.file}.xlsx"`,
        'cache-control': 'no-store',
      } });
    }
    if (request.method === 'POST' && url.pathname === '/report/save') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
      try { const r = await saveReport(env, 'last'); return Response.redirect(new URL('/?view=reports&saved=' + encodeURIComponent(r.path), url).toString(), 303); }
      catch (e) { return Response.redirect(new URL('/?view=reports&err=' + encodeURIComponent(e.message), url).toString(), 303); }
    }
    if (request.method === 'GET' && url.pathname === '/') {
      const view = url.searchParams.get('view') || 'topost';
      if (view === 'products') return productsPage(env);
      if (view === 'reports') return reportsPage(env, url);
      return page(env, view);
    }
    return new Response('Not found', { status: 404 });
  },

  // Runs on the Worker's Cron Trigger (set to Mondays) — saves last week's report to GitHub.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(saveReport(env, 'last').catch((e) => console.error('Weekly report failed:', e.message)));
  },
};
