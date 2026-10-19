/**
 * Savourly admin — your private orders page.
 * This Worker must be protected with Cloudflare Access (the "Protect with
 * Cloudflare Access" switch). Only people you allow can reach it at all.
 * Needs one binding: DB -> savourly-orders.
 * Cancel / Refund buttons (optional): secrets STANNP_API_KEY (same key as savourly-print) and
 * STRIPE_SECRET_KEY (a restricted Stripe key with Refunds: Write), plus admin-worker/refunds.sql run once.
 */

// Your master product list, published with the website.
const PRODUCTS_URL = 'https://sheltont-99.github.io/savourly-site/products.json';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Print-ready PDFs are PRIVATE: they live in the private repo savourly-reports, folder print-files/,
// one per product and style: print-files/<ID>-<style>.pdf, e.g. print-files/PR00007-fine-dining.pdf
// (boxes: -the-farmhouse-box, -the-pantry-box, -the-heirloom-tin). The PDF link opens /pdf/<file> on this page,
// which fetches the file from GitHub with GITHUB_TOKEN, so only people who can log in here can open it.
// Links in the page go to /print/<file> first: a small page with Back, Share / Print, Save and Open buttons,
// because phone browsers often show a bare PDF with no toolbar and no way to share or print it.
const PRINT_DIR = 'print-files';
function styleSlug(style) { return String(style || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function pdfFile(id, style) { return `${id}-${styleSlug(style)}.pdf`; }
function pdfLink(id, style) {
  if (!id || !style) return '';
  const file = pdfFile(id, style);
  return `<a class="pdf" href="/print/${encodeURIComponent(file)}" title="Open ${escapeHtml(PRINT_DIR + '/' + file)}">PDF</a>`;
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

const BOX_STYLES = ['The Farmhouse Box', 'The Pantry Box', 'The Heirloom Tin', 'Kraft Wrap', 'Gift Ribbon', 'Keepsake Tin']; // old names kept so earlier orders still read as boxes

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
      ...(init.headers || {}),
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

// ============================================================================
// Orders tab: the one place for orders. Each order shows what Stannp is doing with
// each of its printed cards (from the savourly-print Worker's print_jobs table),
// with Cancel card / Retry / Done by hand, Refund, and Mark as posted for anything
// posted by hand (recipe boxes, orders from before printing was set up, proof-only cards).
// ============================================================================
const NOT_FULLY_REFUNDED = "(refunded_amount IS NULL OR refunded_amount < total - 0.005)";
let refundColsSeen = false;
async function hasRefundCols(env) {
  if (refundColsSeen) return true;
  try { await env.DB.prepare(`SELECT refunded_amount, refunded_at, stripe_refund_id FROM orders LIMIT 1`).first(); refundColsSeen = true; } catch {}
  return refundColsSeen;
}

const PRINT_STATUS = {
  queued: ['Waiting to print', 'pending'], sending: ['Sending…', 'pending'], proof: ['Proof only', 'proof'],
  sent: ['Sent to Stannp', 'paid'], printing: ['Printing', 'paid'], dispatched: ['Posted', 'posted'],
  local_delivery: ['Out for delivery', 'posted'], delivered: ['Delivered', 'posted'], returned: ['Returned', 'bad'],
  cancelled: ['Cancelled', 'pending'], needs_attention: ['Needs attention', 'bad'], done_by_hand: ['Done by hand', 'posted'],
};
// How far along a printed card is; an order is only as far along as its slowest card.
const STEP = { queued: 0, sending: 1, sent: 2, printing: 3, dispatched: 4, local_delivery: 5, delivered: 6, done_by_hand: 6 };
const STEP_LABEL = [['Waiting to print', 'pending'], ['Waiting to print', 'pending'], ['Sent to Stannp', 'paid'], ['Printing', 'paid'], ['Posted', 'posted'], ['Out for delivery', 'posted'], ['Delivered', 'posted']];
const FILTERS = [['all', 'All'], ['action', 'Needs action'], ['progress', 'Printing'], ['posted', 'Posted'], ['refunded', 'Refunded'], ['unpaid', 'Not paid']];
const filterKey = (f) => (FILTERS.some(([k]) => k === f) ? f : 'all');
const isBoxItem = (it, types) => (types[it.id] ? types[it.id] === 'box' : BOX_STYLES.includes(it.style));

async function loadOrders(env) {
  const [{ results }, refunds] = await Promise.all([
    env.DB.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 500`).all(),
    hasRefundCols(env),
  ]);
  let jobs = [], printReady = true, printStatus = {}, start = null;
  try {
    jobs = (await env.DB.prepare(
      `SELECT * FROM print_jobs WHERE order_ref IN (SELECT order_ref FROM orders ORDER BY created_at DESC LIMIT 500) ORDER BY line_no, copy_no`
    ).all()).results;
    const st = await env.DB.prepare(`SELECT key, value FROM print_settings WHERE key IN ('status','start')`).all();
    for (const r of st.results) { if (r.key === 'status') printStatus = JSON.parse(r.value || '{}'); else start = r.value; }
  } catch { printReady = false; } // print tables not set up yet: everything is posted by hand
  let types = {};
  try {
    const res = await fetch(PRODUCTS_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (res.ok) types = Object.fromEntries((await res.json()).products.map((p) => [p.id, p.type]));
  } catch {}
  const byRef = new Map();
  for (const j of jobs) { if (!byRef.has(j.order_ref)) byRef.set(j.order_ref, []); byRef.get(j.order_ref).push(j); }
  const orders = results.map((o) => describeOrder(o, byRef.get(o.order_ref) || [], types, printReady, start));
  return { orders, printReady, printStatus, refunds };
}

// Works out, for one order: its cards' print jobs per line, what (if anything) is posted by hand,
// one overall status and which filter it belongs to.
function describeOrder(o, allJobs, types, printReady, start) {
  let items = [];
  try { items = JSON.parse(o.items_json || '[]'); } catch {}
  const paid = o.status === 'paid';
  const jobs = allJobs.filter((j) => j.status !== 'no_cards');
  const refunded = pence(o.refunded_amount);
  const fullyRefunded = refunded > 0 && refunded >= pence(o.total);
  const active = jobs.filter((j) => j.status !== 'cancelled');
  const stannp = active.filter((j) => j.status !== 'proof');               // cards Stannp is (or will be) printing for real
  const proofOnly = active.length > 0 && stannp.length === 0;
  const hasCards = items.some((it) => !isBoxItem(it, types));
  const beforePrinting = !printReady || !start || (o.paid_at && o.paid_at < start);
  const cardsByHand = paid && hasCards && (beforePrinting || proofOnly);
  const boxes = items.some((it) => isBoxItem(it, types));
  const byHand = paid && (boxes || cardsByHand);                           // something to post yourself
  const handPending = byHand && !o.posted_at && !fullyRefunded;

  let status;
  if (!paid) status = [o.status === 'pending' ? 'Not paid' : o.status === 'expired' ? 'Checkout abandoned' : o.status, 'pending', 'unpaid'];
  else if (fullyRefunded) status = ['Refunded', 'refunded', 'refunded'];
  else if (jobs.some((j) => j.status === 'needs_attention')) status = ['Needs attention', 'bad', 'action'];
  else if (jobs.some((j) => j.status === 'returned')) status = ['Returned to sender', 'bad', 'action'];
  else if (handPending) status = [proofOnly && !boxes ? 'Proof only: post by hand' : stannp.length ? 'Box to post by hand' : 'To post by hand', 'paid', 'action'];
  else if (stannp.length) {
    const step = Math.min(...stannp.map((j) => STEP[j.status] ?? 0));
    const [label, cls] = STEP_LABEL[step];
    status = [label, cls, step >= 4 ? 'posted' : 'progress'];
  } else if (byHand && o.posted_at) status = [`Posted ${fmtDate(o.posted_at)}`, 'posted', 'posted'];
  else if (jobs.length && !active.length) status = ['Cards cancelled', 'pending', 'all'];
  else if (hasCards) status = ['Waiting to print', 'pending', 'progress'];   // paid since printing started; picked up within 5 minutes
  else status = ['Paid', 'paid', 'action'];
  return { o, items, jobs, paid, refunded, fullyRefunded, byHand, cardsByHand, handPending, status, types };
}

async function counts(env, data) {
  const d = data || await loadOrders(env).catch(() => ({ orders: [] }));
  const n = { all: 0 };
  for (const x of d.orders) { if (x.paid) n.all++; n[x.status[2]] = (n[x.status[2]] || 0) + 1; }
  return { action: n.action || 0, n };
}

function jobRow(j, f) {
  const [label, cls] = PRINT_STATUS[j.status] || [j.status, 'pending'];
  const buttons = [
    j.status === 'needs_attention' ? `<button class="btn btn-xs" name="do" value="retry">Retry</button><button class="btn-ghost btn-xs" name="do" value="hand">Done by hand</button>` : '',
    canCancel(j) ? `<button class="btn-ghost btn-xs btn-stop" name="do" value="cancel" onclick="return confirm('Cancel this card${j.status === 'sent' ? ' in Stannp' : ''}? It won\\'t be printed or posted.')">Cancel card</button>` : '',
  ].join('');
  const meta = [
    j.mode ? `${j.mode === 'live' ? 'Live' : 'Proof'}${j.cost != null ? ` £${Number(j.cost).toFixed(2)}` : ''}` : '',
    /^https:\/\//.test(j.proof_url || '') ? `<a href="${escapeHtml(j.proof_url)}" target="_blank" rel="noopener">proof ↗</a>` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="job">
      <span class="pill pill-${cls}">${escapeHtml(label)}</span>${meta ? `<span class="dim">${meta}</span>` : ''}
      ${buttons ? `<form method="post" action="/printjob" class="jbtns"><input type="hidden" name="id" value="${Number(j.id)}"><input type="hidden" name="f" value="${escapeHtml(f)}">${buttons}</form>` : ''}
      ${j.status === 'sending' ? '<span class="dim">refresh in a minute to cancel</span>' : ''}
      ${j.last_error ? `<div class="${j.status === 'cancelled' ? 'pnote' : 'perr'}">${escapeHtml(j.last_error)}</div>` : ''}
    </div>`;
}

function orderCard(x, f) {
  const { o, items, jobs, paid, refunded, fullyRefunded, byHand, cardsByHand, status, types } = x;
  const ref = escapeHtml(o.order_ref);
  const lines = items.map((it, idx) => {
    const lineJobs = jobs.filter((j) => j.line_no === idx + 1);
    const box = isBoxItem(it, types);
    const copies = lineJobs.length > 1;
    const handPill = (todo, done) => `<div class="job"><span class="pill pill-${o.posted_at ? 'posted' : 'hand'}">${o.posted_at ? done : todo}</span></div>`;
    const printInfo = !paid ? ''
      : box ? handPill('Box: post by hand', 'Box: posted by hand')
      : lineJobs.length ? lineJobs.map((j) => (copies ? `<div class="copy">Copy ${Number(j.copy_no)}</div>` : '') + jobRow(j, f)).join('')
      : cardsByHand ? handPill('Post by hand', 'Posted by hand')
      : '<div class="job"><span class="pill pill-pending">Waiting to print</span></div>';
    return `<li><div class="iline"><span>${it.id ? idTag(it.id) : ''}${escapeHtml(it.style ? `${it.name} — ${it.style}` : it.name)}${pdfLink(it.id, it.style)}</span><b>× ${Number(it.qty)}</b></div>${printInfo}</li>`;
  }).join('');
  const stripe = o.stripe_payment_intent
    ? `<a href="https://dashboard.stripe.com/test/payments/${encodeURIComponent(o.stripe_payment_intent)}" target="_blank" rel="noopener">View in Stripe ↗</a>` : '';
  const refundBtn = paid && o.stripe_payment_intent && !fullyRefunded
    ? `<a class="btn-ghost btn-sm" href="/refund?ref=${encodeURIComponent(o.order_ref)}&amp;f=${escapeHtml(f)}">Refund</a>` : '';
  const postBtn = paid && byHand && !(fullyRefunded && !o.posted_at)
    ? `<form method="post" action="/${o.posted_at ? 'unpost' : 'post'}"><input type="hidden" name="ref" value="${ref}"><input type="hidden" name="f" value="${escapeHtml(f)}">
         <button class="${o.posted_at ? 'btn-ghost btn-sm' : 'btn btn-sm'}">${o.posted_at ? 'Undo posted' : 'Mark as posted'}</button></form>` : '';
  const refundBadge = refunded ? `<span class="pill pill-refunded">${fullyRefunded ? 'Refunded' : `Refunded ${gbp(refunded)}`}</span>` : '';
  return `<article class="order" id="o-${ref}">
      <div class="top"><strong class="ref">${ref}<button type="button" class="cp" data-copy="${ref}" title="Copy ${ref}" aria-label="Copy ${ref}"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></strong><span class="dim">${escapeHtml(fmtDate(o.created_at))}</span><span class="pill pill-${status[1]}">${escapeHtml(status[0])}</span>${status[1] === 'refunded' ? '' : refundBadge}</div>
      <ul class="items">${lines}</ul>
      <div class="addr"><b>${escapeHtml(o.customer_name)}</b><br>${escapeHtml(o.shipping_address)}<br><span class="dim">${escapeHtml(o.customer_email)}</span></div>
      <div class="foot"><span class="total">£${Number(o.total).toFixed(2)}</span>${stripe}${refundBtn}${postBtn}</div>
    </article>`;
}

async function ordersPage(env, url) {
  const data = await loadOrders(env);
  const c = await counts(env, data);
  const f = filterKey(url.searchParams.get('f'));
  const s = data.printStatus || {};
  const flashOk = url.searchParams.get('done'), flashErr = url.searchParams.get('err');
  const lastRun = s.lastRun ? new Date(s.lastRun) : null;
  const modeLabel = { off: 'Off: nothing is sent to Stannp', proof: 'Proof only: nothing prints', live: s.stripeLive ? (s.liveOnly ? 'Live for listed emails only (others get proofs)' : 'Live: cards print and post') : 'Live, but Stripe is in test mode: proofs only' }[s.mode] || 'Not run yet';
  const attention = data.orders.filter((x) => x.status[0] === 'Needs attention').length;
  const banners = [
    flashOk ? `<div class="flash ok">${escapeHtml(flashOk)}</div>` : '',
    flashErr ? `<div class="flash bad">${escapeHtml(flashErr)}</div>` : '',
    data.printReady && (!lastRun || Date.now() - lastRun.getTime() > 20 * 60000)
      ? `<div class="flash bad">The print Worker hasn't run ${lastRun ? `since ${escapeHtml(fmtDate(s.lastRun))}` : 'yet'}. Check savourly-print has its Cron Trigger (every 5 minutes).</div>` : '',
    s.capHit ? `<div class="flash bad">Daily print cap reached: £${Number(s.spent).toFixed(2)} of £${Number(s.cap).toFixed(2)} today. Live cards wait until midnight.</div>` : '',
    attention ? `<div class="flash bad">${plural(attention, 'order needs', 'orders need')} attention: <a href="/?view=orders&amp;f=action">see Needs action</a>.</div>` : '',
    s.mode && s.mode !== 'off' && s.keyReady === false ? `<div class="flash bad">STANNP_MODE is on but savourly-print has no STANNP_API_KEY.</div>` : '',
  ].join('');
  const panel = data.printReady
    ? `<div class="pstat"><b>Stannp:</b> ${escapeHtml(modeLabel)}${s.mode === 'live' ? ` · today £${Number(s.spent || 0).toFixed(2)} of £${Number(s.cap || 20).toFixed(2)}` : ''} <span class="dim">· checked ${lastRun ? escapeHtml(fmtDate(s.lastRun)) : 'never'}</span></div>`
    : `<div class="pstat"><b>Stannp printing isn't set up yet</b>, so everything is posted by hand. <span class="dim">See SETUP.md → Printing with Stannp.</span></div>`;
  const chips = `<nav class="chips">${FILTERS.map(([k, label]) => {
    const n = k === 'all' ? c.n.all : c.n[k] || 0;
    return `<a class="chip ${f === k ? 'on' : ''} ${k === 'action' && n ? 'warn' : ''}" href="/?view=orders&amp;f=${k}">${label} <span>${n}</span></a>`;
  }).join('')}</nav>`;
  const shown = data.orders.filter((x) => (f === 'all' ? x.paid : x.status[2] === f));
  const empty = { all: 'No paid orders yet.', action: 'Nothing needs you right now. 🎉', progress: 'Nothing is printing right now.', posted: 'Nothing posted yet.', refunded: 'No refunds.', unpaid: 'No unpaid checkouts.' }[f];
  return shell('orders', c, banners + panel + chips + (shown.map((x) => orderCard(x, f)).join('') || `<div class="empty">${empty}</div>`));
}

// ---- Cancelling a card ----
// Waiting cards (and ones that need attention) are cancelled here in D1, so savourly-print never sends them.
// Cards already sent live are cancelled in Stannp, which only works before Stannp starts printing.
const STANNP_API = 'https://api-eu1.stannp.com/v1';
function canCancel(j) {
  return j.status === 'queued' || j.status === 'needs_attention' || (j.status === 'sent' && j.mode === 'live' && Number(j.stannp_id) > 0);
}
async function stannpCancel(env, stannpId) {
  if (!env.STANNP_API_KEY) return { error: "The STANNP_API_KEY secret isn't set on savourly-admin, so it can't reach Stannp. Add it (the same key as savourly-print), or cancel in Stannp's dashboard." };
  try {
    const res = await fetch(`${STANNP_API}/postcards/cancel`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${env.STANNP_API_KEY}:`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: String(stannpId) }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.success) return { ok: true };
    return { error: `Stannp wouldn't cancel it, so it has probably started printing (${String((body && (body.error || body.message)) || `Stannp said ${res.status}`).slice(0, 200)}).` };
  } catch (e) { return { error: `Couldn't reach Stannp: ${e && e.message}. Try again, or cancel in Stannp's dashboard.` }; }
}
// Returns { done: true } or { error } for one print job row.
async function cancelJob(env, j, why) {
  const now = new Date().toISOString();
  if (j.status === 'queued' || j.status === 'needs_attention') {
    const r = await env.DB.prepare(`UPDATE print_jobs SET status='cancelled', last_error=?, updated_at=? WHERE id=? AND status IN ('queued','needs_attention')`)
      .bind(`${why} before it was sent to Stannp (${fmtDate(now)}).`, now, j.id).run();
    if (r?.meta?.changes) return { done: true };
    const fresh = await env.DB.prepare(`SELECT * FROM print_jobs WHERE id=?`).bind(j.id).first();
    if (fresh && fresh.status === 'sending') return { error: 'It was being sent to Stannp at that moment. Refresh in a minute and cancel it again.' };
    if (fresh && canCancel(fresh)) return cancelJob(env, fresh, why);
    return { error: 'It had already moved on, so nothing changed.' };
  }
  if (j.status === 'sent' && j.mode === 'live' && Number(j.stannp_id) > 0) {
    const r = await stannpCancel(env, Number(j.stannp_id));
    if (r.error) return r;
    await env.DB.prepare(`UPDATE print_jobs SET status='cancelled', last_error=?, updated_at=? WHERE id=?`)
      .bind(`${why} in Stannp (${fmtDate(now)}).`, now, j.id).run();
    return { done: true };
  }
  if (j.status === 'sending') return { error: 'It is being sent to Stannp right now. Refresh in a minute and cancel it again.' };
  return { error: "It can't be cancelled any more (it's already printing or posted)." };
}

async function printJobAction(request, env) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  const form = await request.formData();
  const id = Number(form.get('id'));
  const action = form.get('do');
  if (!Number.isInteger(id) || !['retry', 'hand', 'cancel'].includes(action)) return new Response('Bad request', { status: 400 });
  const f = filterKey(form.get('f'));
  const back = (key, msg) => Response.redirect(new URL(`/?view=orders&f=${f}&${key}=${encodeURIComponent(msg)}`, request.url).toString(), 303);
  if (action === 'cancel') {
    const j = await env.DB.prepare(`SELECT * FROM print_jobs WHERE id=?`).bind(id).first();
    if (!j) return back('err', 'That card no longer exists.');
    const r = await cancelJob(env, j, 'Cancelled by you');
    return r.done ? back('done', `Cancelled: ${j.order_ref} card ${j.line_no} copy ${j.copy_no} won't be printed.`) : back('err', `Couldn't cancel ${j.order_ref} card ${j.line_no} copy ${j.copy_no}: ${r.error}`);
  }
  const r = action === 'retry'
    ? await env.DB.prepare(`UPDATE print_jobs SET status='queued', attempts=0, last_error=NULL, updated_at=? WHERE id=? AND status='needs_attention'`).bind(new Date().toISOString(), id).run()
    : await env.DB.prepare(`UPDATE print_jobs SET status='done_by_hand', updated_at=? WHERE id=? AND status='needs_attention'`).bind(new Date().toISOString(), id).run();
  const msg = !r?.meta?.changes ? 'Nothing changed (it was already handled).' : action === 'retry' ? 'Queued again: it will be sent within 5 minutes.' : 'Marked as done by hand.';
  return back('done', msg);
}

// ============================================================================
// Refunds: the Refund button on an order opens /refund?ref=…, a confirm page.
// Confirming cancels the order's cards that haven't printed (optional) and then
// refunds the card payment in Stripe (secret STRIPE_SECRET_KEY). Refunds made in
// Stripe's own dashboard are NOT seen here and don't cancel any cards.
// ============================================================================
const REFUND_SQL = 'ALTER TABLE orders ADD COLUMN refunded_amount REAL; ALTER TABLE orders ADD COLUMN refunded_at TEXT; ALTER TABLE orders ADD COLUMN stripe_refund_id TEXT;';
const pence = (n) => Math.round(Number(n || 0) * 100);
const gbp = (p) => `£${(p / 100).toFixed(2)}`;
const TOO_LATE = ['printing', 'dispatched', 'local_delivery', 'delivered', 'returned'];

async function orderJobs(env, ref) {
  try { return (await env.DB.prepare(`SELECT * FROM print_jobs WHERE order_ref=? AND status != 'no_cards' ORDER BY line_no, copy_no`).bind(ref).all()).results; }
  catch { return []; } // print tables not set up yet
}
function jobSummary(jobs) {
  return {
    stoppable: jobs.filter(canCancel),
    sending: jobs.filter((j) => j.status === 'sending'),
    tooLate: jobs.filter((j) => TOO_LATE.includes(j.status) || (j.status === 'sent' && !canCancel(j))),
  };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function refundPage(env, url) {
  const c = await counts(env);
  const ref = String(url.searchParams.get('ref') || '');
  const f = filterKey(url.searchParams.get('f'));
  const view = 'orders';
  const o = await env.DB.prepare(`SELECT * FROM orders WHERE order_ref=?`).bind(ref).first();
  const box = (inner) => shell(view, c, `<section class="group pad refund">${inner}<p><a href="/?view=orders&amp;f=${f}">← Back to orders</a></p></section>`);
  if (!o) return box(`<h2 class="plain">Order not found</h2>`);
  if (o.status !== 'paid' || !o.stripe_payment_intent) return box(`<h2 class="plain">${escapeHtml(ref)} can't be refunded here</h2><p>It isn't a paid order with a Stripe payment.</p>`);
  const remaining = pence(o.total) - pence(o.refunded_amount);
  if (remaining <= 0) return box(`<h2 class="plain">${escapeHtml(ref)} is already fully refunded</h2>`);
  const setup = [
    !env.STRIPE_SECRET_KEY ? `<div class="flash bad">The STRIPE_SECRET_KEY secret isn't set on savourly-admin yet, so refunds can't be made (see SETUP.md → Cancel and refund buttons).</div>` : '',
    !(await hasRefundCols(env)) ? `<div class="flash bad">One-time setup missing: run <code>admin-worker/refunds.sql</code> in Cloudflare → D1 → savourly-orders → Console.</div>` : '',
  ].join('');
  const { stoppable, sending, tooLate } = jobSummary(await orderJobs(env, ref));
  const items = JSON.parse(o.items_json || '[]');
  const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const already = pence(o.refunded_amount) ? `<p class="hint">Already refunded: ${gbp(pence(o.refunded_amount))}.</p>` : '';
  const cards = [
    stoppable.length ? `<li><b>${plural(stoppable.length, 'card hasn’t', 'cards haven’t')} printed yet</b> and can be cancelled.</li>` : '',
    sending.length ? `<li>${plural(sending.length, 'card is', 'cards are')} being sent to Stannp right now. Cancel ${sending.length === 1 ? 'it' : 'them'} from the Printing tab in a minute.</li>` : '',
    tooLate.length ? `<li>${plural(tooLate.length, 'card has', 'cards have')} already started printing or been posted, so ${tooLate.length === 1 ? 'it' : 'they'} will still arrive.</li>` : '',
  ].join('');
  return shell(view, c, setup + `<section class="group pad refund">
    <h2 class="plain">Refund ${escapeHtml(ref)}</h2>
    <p><b>${escapeHtml(o.customer_name)}</b> · ${escapeHtml(o.customer_email)} · paid ${gbp(pence(o.total))}</p>
    <ul class="items">${items.map((i) => `<li><span>${i.id ? idTag(i.id) : ''}${escapeHtml(i.style ? `${i.name} — ${i.style}` : i.name)}</span><b>× ${Number(i.qty)}</b></li>`).join('')}</ul>
    ${already}
    <form method="post" action="/refund" id="rf">
      <input type="hidden" name="ref" value="${escapeHtml(ref)}"><input type="hidden" name="f" value="${escapeHtml(f)}"><input type="hidden" name="token" value="${token}">
      <label class="fld">Amount to refund (£)<input type="number" name="amount" id="amt" step="0.01" min="0.01" max="${(remaining / 100).toFixed(2)}" value="${(remaining / 100).toFixed(2)}" inputmode="decimal" required></label>
      <p class="hint">Full amount left: ${gbp(remaining)}. Lower it for a partial refund.</p>
      ${stoppable.length ? `<label class="chk"><input type="checkbox" name="cancel" value="1" checked> Cancel the ${plural(stoppable.length, 'card', 'cards')} that ${stoppable.length === 1 ? 'hasn’t' : 'haven’t'} printed yet</label>` : ''}
      ${cards ? `<ul class="notes">${cards}</ul>` : '<p class="hint">No cards for this order have gone to Stannp.</p>'}
      <div class="pj"><button class="btn btn-stop" id="go">Refund ${gbp(remaining)}</button><a class="btn-ghost" href="/?view=orders&amp;f=${f}">Back</a></div>
      <p class="hint">The money goes back to the customer's card through Stripe (usually 5–10 days to show). This can't be undone.</p>
    </form>
    <script>
      const WHO = ${JSON.stringify(String(o.customer_name || 'the customer')).replace(/</g, '\\u003c')};
      const amt = document.getElementById('amt'), go = document.getElementById('go');
      const label = () => 'Refund £' + (Number(amt.value) || 0).toFixed(2);
      amt.addEventListener('input', () => { go.textContent = label(); });
      document.getElementById('rf').addEventListener('submit', (e) => {
        if (!confirm(label() + ' to ' + WHO + "? This can't be undone.")) { e.preventDefault(); return; }
        go.disabled = true; go.textContent = 'Refunding…';
      });
    </script>
  </section>`);
}

async function refundAction(request, env) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  const form = await request.formData();
  const ref = String(form.get('ref') || '');
  const f = filterKey(form.get('f'));
  const token = String(form.get('token') || '');
  const back = (key, msg) => Response.redirect(new URL(`/?view=orders&f=${f}&${key}=${encodeURIComponent(msg)}`, request.url).toString(), 303);
  if (!/^[a-f0-9]{24}$/.test(token)) return new Response('Bad request', { status: 400 });

  const o = await env.DB.prepare(`SELECT * FROM orders WHERE order_ref=?`).bind(ref).first();
  if (!o || o.status !== 'paid' || !o.stripe_payment_intent) return back('err', `${ref} can't be refunded here: it isn't a paid Stripe order.`);
  if (!env.STRIPE_SECRET_KEY) return back('err', "Refund not made: the STRIPE_SECRET_KEY secret isn't set on savourly-admin.");
  if (!(await hasRefundCols(env))) return back('err', `Refund not made: run admin-worker/refunds.sql in the D1 console first (${REFUND_SQL}).`);
  const remaining = pence(o.total) - pence(o.refunded_amount);
  const amount = pence(form.get('amount'));
  if (!(amount > 0)) return back('err', 'Refund not made: enter an amount above £0.');
  if (amount > remaining) return back('err', `Refund not made: the most that can be refunded on ${ref} is ${gbp(remaining)}.`);

  // 1. Stop cards first: the window to cancel in Stannp is short.
  const notes = [];
  if (form.get('cancel') === '1') {
    const { stoppable } = jobSummary(await orderJobs(env, ref));
    let ok = 0; const failed = [];
    for (const j of stoppable) {
      const r = await cancelJob(env, j, 'Cancelled with the refund');
      if (r.done) ok++; else failed.push(`card ${j.line_no} copy ${j.copy_no}: ${r.error}`);
    }
    if (ok) notes.push(`Cancelled ${plural(ok, 'card', 'cards')}.`);
    if (failed.length) notes.push(`Couldn't cancel ${failed.join('; ')}`);
  }
  // 2. Refund in Stripe. The token makes a double-tap or resend refund only once.
  let res, body;
  try {
    res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `savourly-refund-${ref}-${token}` },
      body: new URLSearchParams({ payment_intent: o.stripe_payment_intent, amount: String(amount), reason: 'requested_by_customer', 'metadata[order_ref]': ref }),
    });
    body = await res.json().catch(() => null);
  } catch (e) { body = { error: { message: `Couldn't reach Stripe: ${e && e.message}` } }; }
  if (!res || !res.ok || !body || !body.id || body.status === 'failed' || body.status === 'canceled') {
    const why = (body && body.error && body.error.message) || (body && body.status ? `the refund was ${body.status}` : `Stripe said ${res ? res.status : 'nothing'}`);
    return back('err', `Refund NOT made on ${ref}: ${String(why).slice(0, 250)}. ${notes.join(' ')}`.trim());
  }
  // 3. Record it (once per Stripe refund, even if this form is sent again).
  await env.DB.prepare(
    `UPDATE orders SET refunded_amount = ROUND(COALESCE(refunded_amount,0) + ?, 2), refunded_at=?, stripe_refund_id=?
     WHERE order_ref=? AND (stripe_refund_id IS NULL OR instr(stripe_refund_id, ?) = 0)`
  ).bind(amount / 100, new Date().toISOString(), o.stripe_refund_id ? `${o.stripe_refund_id},${body.id}` : body.id, ref, body.id).run();
  const left = remaining - amount;
  return back('done', `Refunded ${gbp(amount)} on ${ref}${left > 0 ? ` (${gbp(left)} left)` : ''}. ${notes.join(' ')}`.trim());
}

function tabs(view, c) {
  const t = (key, label, n, cls = '') => `<a class="tab ${view === key ? 'on' : ''}" href="/?view=${key}">${label}${n == null ? '' : ` <span class="${cls}">${n}</span>`}</a>`;
  return t('orders', 'Orders', c.action || null, 'bad') + t('products', 'Products', c.products) + t('reports', 'Reports');
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
  .pdfs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .pdfs .pdf{margin-left:0;font-weight:600;white-space:nowrap}
  .pdf.off{color:#b8b0a2;border-style:dashed;cursor:default}
  .pdf.off:hover{background:none;color:#b8b0a2;border-color:#d9cfbb}
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
  .pill-proof{background:#e0e7ff;color:#3730a3}
  .pill-bad,.tab.on span.bad{background:#fee2e2;color:#991b1b}
  .pjob .pmain{margin:10px 0 6px;font-size:.95rem}
  .pjob .pmeta{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:.85rem}
  .pjob .pmeta a{color:#8A5A2B}
  .perr{margin-top:8px;padding:8px 10px;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:.85rem}
  .pj{display:flex;gap:8px;margin-top:10px}
  .pj .btn,.pj .btn-ghost{padding:8px 12px;font-size:.85rem}
  .btn-stop{color:#991b1b}
  .btn.btn-stop{background:#b91c1c;color:#fff}
  .btn-sm{padding:8px 12px;font-size:.85rem;text-decoration:none;color:#6b7280 !important}
  .pill-refunded{background:#fee2e2;color:#991b1b}
  .top .pill + .pill{margin-left:0}
  .pnote{margin-top:8px;color:#6b7280;font-size:.85rem}
  .refund .fld{display:grid;gap:6px;margin-top:14px;font-weight:600;font-size:.92rem}
  .refund .fld input{font:inherit;font-size:16px;padding:10px 12px;border:1px solid #e5dfd2;border-radius:10px;max-width:200px}
  .refund .chk{display:flex;gap:8px;align-items:center;margin-top:14px;font-size:.92rem}
  .refund .notes{margin:10px 0 0;padding-left:20px;font-size:.9rem;line-height:1.5}
  .refund .pj{margin-top:16px;align-items:center}
  .refund .pj a{text-decoration:none}
  /* Orders tab */
  .pstat{font-size:.88rem;color:#20293a;padding:2px 2px 0}
  .chips{display:flex;gap:6px;flex-wrap:wrap}
  .chip{padding:6px 12px;border-radius:99px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06);text-decoration:none;color:#6b7280;font-size:.85rem;font-weight:600;white-space:nowrap}
  .chip span{background:#f3efe6;border-radius:99px;padding:0 7px;margin-left:3px;font-size:.75rem}
  .chip.on{background:#20293a;color:#fff}
  .chip.on span{background:rgba(255,255,255,.2)}
  .chip.warn span{background:#fee2e2;color:#991b1b}
  .tab span.bad{background:#fee2e2;color:#991b1b}
  .order .items li{display:block}
  .iline{display:flex;justify-content:space-between;gap:12px}
  .iline b{white-space:nowrap}
  .job{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:6px 0 2px;font-size:.82rem}
  .job .pill{margin-left:0}
  .job .perr,.job .pnote{flex-basis:100%;margin-top:2px}
  .copy{font-size:.75rem;color:#9ca3af;margin-top:6px}
  .jbtns{display:inline-flex;gap:6px;margin:0}
  .btn-xs{padding:5px 10px !important;font-size:.78rem !important;border-radius:7px}
  .pill-hand{background:#fff7ed;color:#9a3412}
  .foot form{margin:0}
  .foot .btn-sm{display:inline-block}
  .btn.btn-sm{color:#fff !important}
  /* Orders views: wide, one thin row per order on bigger screens */
  .v-orders main{max-width:1280px}
  @media (min-width:900px){
    .v-orders main{gap:8px}
    .v-orders .order{display:grid;grid-template-columns:170px minmax(0,1fr) 250px 200px;gap:24px;align-items:center;padding:12px 18px}
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

// Names of the files in print-files/ (a Set), or null if they can't be listed (no token / GitHub error).
async function printFileNames(env) {
  if (!env.GITHUB_TOKEN) return null;
  try {
    const root = await gh(env, '/contents/');
    if (!root.ok) return null;
    const dir = (await root.json()).find((e) => e.name === PRINT_DIR && e.type === 'dir');
    if (!dir) return new Set();
    const tree = await gh(env, `/git/trees/${dir.sha}`);
    if (!tree.ok) return null;
    return new Set((await tree.json()).tree.filter((e) => e.type === 'blob').map((e) => e.path));
  } catch { return null; }
}

// Styles still being designed: shown on the Products tab as placeholders so their print files can be
// added ahead of launch. They are NOT in products.json, so customers can't order them yet.
const UPCOMING_STYLES = { card: ['Chef Special'] };

// One small tag per style: a link when the file exists, faded when it hasn't been added yet.
function pdfTags(id, styles, files) {
  if (!styles || !styles.length) return '';
  return `<span class="pdfs">` + styles.map((st) => {
    const file = pdfFile(id, st);
    if (files && !files.has(file)) return `<span class="pdf off" title="Not added yet: ${escapeHtml(PRINT_DIR + '/' + file)}">${escapeHtml(st)}</span>`;
    return `<a class="pdf" href="/print/${encodeURIComponent(file)}" title="Open ${escapeHtml(PRINT_DIR + '/' + file)}">${escapeHtml(st)}</a>`;
  }).join('') + `</span>`;
}

async function productsPage(env) {
  const [catRes, c, soldRes, files] = await Promise.all([
    fetch(PRODUCTS_URL, { cf: { cacheTtl: 30, cacheEverything: true } }).catch(() => null),
    counts(env),
    env.DB.prepare(
      `SELECT json_extract(j.value,'$.id') AS id, SUM(json_extract(j.value,'$.qty')) AS sold
       FROM orders o, json_each(o.items_json) j WHERE o.status='paid' GROUP BY 1`
    ).all(),
    printFileNames(env),
  ]);
  if (!catRes || !catRes.ok) return shell('products', c, '<div class="empty">Could not load the product list.</div>');
  const cat = await catRes.json();
  const hiddenChefs = new Set((cat.chefs || []).filter((ch) => ch.hidden).map((ch) => ch.id));
  cat.products.forEach((p) => { if (hiddenChefs.has(p.chefId)) p.hidden = true; }); // a hidden chef hides all their cards
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
    <p class="hint"><b>Hidden</b> ✓ = not showing on the website (${hiddenCount} hidden). To hide or show a product or a whole chef (with all their cards), ask Claude with its ID. Tap a style under a product to open its print PDF (faded = not added yet). Tap <svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg> to copy an ID.</p>` +
    [...groups].filter(([, list]) => list.length).map(([chefId, list]) => `<section class="group"><h2>${chefId ? `${escapeHtml(chefName[chefId] || 'Unknown chef')} ${idTag(chefId)}${hiddenChefs.has(chefId) ? ' <span class="hid">Chef hidden</span>' : ''}` : 'Recipe boxes'}</h2>
      <div class="prow phead"><span>Hidden</span><span>ID</span><span>Product</span><span>Price</span><span>Sold</span></div>` +
      list.map((p) => `<div class="prow${p.hidden ? ' is-hidden' : ''}" data-q="${escapeHtml(`${p.id} ${p.name} ${chefId} ${chefName[chefId] || 'recipe boxes'}`.toLowerCase())}">
        <span class="hbox${p.hidden ? ' on' : ''}" role="img" aria-label="${p.hidden ? 'Hidden' : 'On site'}" title="${p.hidden ? 'Hidden from the website' : 'Showing on the website'}">${p.hidden ? '✓' : ''}</span>
        ${idTag(p.id)}<span>${escapeHtml(p.name)}${p.hidden ? ' <span class="hid">Hidden</span>' : ''}${pdfTags(p.id, [...((cat.styles || {})[p.type] || []), ...(UPCOMING_STYLES[p.type] || []).filter((st) => !((cat.styles || {})[p.type] || []).includes(st))], files)}</span><span>£${Number(p.price).toFixed(2)}</span>
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
  const f = filterKey(form.get('f'));
  await env.DB.prepare(`UPDATE orders SET posted_at=? WHERE order_ref=? AND status='paid'`)
    .bind(posted ? new Date().toISOString() : null, ref).run();
  return Response.redirect(new URL(`/?view=orders&f=${f}#o-${encodeURIComponent(ref)}`, request.url).toString(), 303);
}

// Streams a print PDF from the private repo. Only reachable through Cloudflare Access (see fetch()).
async function printPdf(env, file, download) {
  const note = (title, msg, status) => new Response(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;padding:2rem;max-width:40rem"><h1 style="font-size:1.2rem">${escapeHtml(title)}</h1><p>${msg}</p></body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  if (!env.GITHUB_TOKEN) return note('PDFs not set up', 'This page needs the <b>GITHUB_TOKEN</b> secret (the same one the weekly report uses) to open print files.', 503);
  const res = await gh(env, `/contents/${PRINT_DIR}/${file}`, { headers: { Accept: 'application/vnd.github.raw' } });
  if (res.status === 404) return note('Print file not added yet', `There's no <b>${escapeHtml(PRINT_DIR + '/' + file)}</b> in the private ${escapeHtml(REPORTS_REPO)} repo yet. Send it to Claude with the product ID and style.`, 404);
  if (!res.ok) return note("Couldn't open the print file", `GitHub said ${res.status}. Check the GITHUB_TOKEN secret still works and can read ${escapeHtml(REPORTS_REPO)}.`, 502);
  return new Response(res.body, { headers: {
    'content-type': 'application/pdf',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${file}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  } });
}

// The page a PDF link opens: big phone-friendly buttons around the file.
// Share / Print uses the phone's own share sheet (which includes Print); computers print the preview instead.
function printPage(file) {
  const f = escapeHtml(file);
  const src = `/pdf/${encodeURIComponent(file)}`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${f} · Savourly</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#faf7f0;color:#20293a}
  header{position:sticky;top:0;background:#faf7f0;border-bottom:1px solid #e6dfd0;padding:12px 16px;z-index:1}
  .top{display:flex;align-items:center;gap:12px;max-width:900px;margin:0 auto}
  .back{font-size:1rem;font-weight:600;color:#8A5A2B;text-decoration:none;padding:8px 0;white-space:nowrap}
  .name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;color:#5b6475;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .btns{display:flex;flex-wrap:wrap;gap:8px;max-width:900px;margin:10px auto 0}
  .btn{flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 14px;border-radius:10px;border:1px solid #d9cfbb;background:#fff;color:#20293a;font:inherit;font-weight:600;font-size:.95rem;text-decoration:none;cursor:pointer;white-space:nowrap}
  .btn.main{background:#20293a;border-color:#20293a;color:#fff}
  .btn[disabled]{opacity:.5}
  .msg{max-width:900px;margin:8px auto 0;font-size:.9rem;color:#8a2b2b;min-height:0}
  .msg:empty{display:none}
  main{max-width:900px;margin:0 auto;padding:12px 16px 24px}
  iframe{display:block;width:100%;height:calc(100vh - 170px);min-height:420px;border:1px solid #e6dfd0;border-radius:8px;background:#fff}
  .tip{font-size:.8rem;color:#5b6475;margin:8px 0 0}
</style></head><body>
<header>
  <div class="top"><a class="back" id="back" href="/">← Back</a><span class="name">${f}</span></div>
  <div class="btns">
    <button class="btn main" id="share" type="button" disabled>Loading…</button>
    <a class="btn" href="${src}?download=1" download="${f}">Save</a>
    <a class="btn" href="${src}" target="_blank" rel="noopener">Open</a>
  </div>
  <div class="msg" id="msg" role="status"></div>
</header>
<main>
  <iframe id="doc" src="${src}" title="${f}"></iframe>
  <p class="tip">On a phone the preview may show only the first page; Share / Print, Save and Open all use the full file.</p>
</main>
<script>
  const FILE = ${JSON.stringify(file)}, SRC = ${JSON.stringify(src)};
  const btn = document.getElementById('share'), msg = document.getElementById('msg');
  document.getElementById('back').addEventListener('click', (e) => {
    if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) { e.preventDefault(); history.back(); }
  });
  let pdfFile = null;
  // Fetch the file up front: phones only open the share sheet straight from a tap, with no waiting in between.
  fetch(SRC, { credentials: 'same-origin' }).then(async (r) => {
    if (!r.ok) throw new Error(r.status === 404 ? "This print file hasn't been added yet." : "Couldn't load the print file (" + r.status + ").");
    pdfFile = new File([await r.blob()], FILE, { type: 'application/pdf' });
    const canShare = navigator.canShare && navigator.canShare({ files: [pdfFile] });
    btn.textContent = canShare ? 'Share / Print' : 'Print';
    btn.disabled = false;
  }).catch((e) => { btn.textContent = 'Share / Print'; msg.textContent = e.message; });
  btn.addEventListener('click', () => {
    msg.textContent = '';
    if (pdfFile && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      navigator.share({ files: [pdfFile], title: FILE }).catch((e) => { if (e.name !== 'AbortError') msg.textContent = "Couldn't open sharing. Try Save, then share it from Files."; });
      return;
    }
    try { document.getElementById('doc').contentWindow.focus(); document.getElementById('doc').contentWindow.print(); }
    catch { window.open(SRC, '_blank'); }
  });
</script>
</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-frame-options': 'SAMEORIGIN' } });
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
    if (request.method === 'POST' && url.pathname === '/printjob') return printJobAction(request, env);
    if (request.method === 'GET' && url.pathname === '/refund') return refundPage(env, url);
    if (request.method === 'POST' && url.pathname === '/refund') return refundAction(request, env);
    const pdf = url.pathname.match(/^\/pdf\/(PR\d{5}-[a-z0-9]+(?:-[a-z0-9]+)*\.pdf)$/);
    if (request.method === 'GET' && pdf) return printPdf(env, pdf[1], url.searchParams.get('download') === '1');
    const printView = url.pathname.match(/^\/print\/(PR\d{5}-[a-z0-9]+(?:-[a-z0-9]+)*\.pdf)$/);
    if (request.method === 'GET' && printView) return printPage(printView[1]);
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
      const view = url.searchParams.get('view') || 'orders';
      if (view === 'products') return productsPage(env);
      if (view === 'reports') return reportsPage(env, url);
      const old = { topost: 'action', posted: 'posted', all: 'all', printing: 'all' }[view]; // old bookmarks
      if (old) return Response.redirect(new URL(`/?view=orders&f=${old}`, url).toString(), 302);
      return ordersPage(env, url);
    }
    return new Response('Not found', { status: 404 });
  },

  // Runs on the Worker's Cron Trigger (set to Mondays) — saves last week's report to GitHub.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(saveReport(env, 'last').catch((e) => console.error('Weekly report failed:', e.message)));
  },
};
