# Savourly: how everything fits together

This repo is public. Nothing here is secret; keys and passwords live only in Cloudflare.

## The pieces

```
 Customer ──► Website (GitHub Pages) ──"Pay"───────────► savourly-checkout (Cloudflare Worker)
                  │  reads products.json                       │  reads products.json for prices
                  │                                            │  writes order to D1 (pending)
                  │                                            ▼
                  │                                   Stripe hosted payment page
                  │                                            │  webhook: "paid"
                  ◄──────── back to site, "Order confirmed" ───┤
                                                               ▼
 You ──email login (Cloudflare Access)──► savourly-admin ──► D1 database "savourly-orders"
                                               │  Products tab reads products.json (view only)
                                               │  Printing tab reads the print jobs
                                                                     ▲
                 savourly-print (every 5 min) ── reads paid orders ──┘── sends cards ──► Stannp (print + post)
                                    ▲                                                      │
                                    └──────────── status webhook (printing, posted…) ◄─────┘
```

| Piece | Where | What it does |
|---|---|---|
| Website | `index.html` in this repo → https://savourlyco.com (GitHub Pages with a custom domain; `CNAME` file in this repo; the old https://sheltont-99.github.io/savourly-site/ address redirects there) | Shop, chef pages, cart, checkout form. Builds every card from `products.json`. |
| Product list | `products.json` (+ photos in `images/`) | The only place products live: IDs, names, chefs, prices, descriptions, hidden flags, postage. |
| Checkout | Cloudflare Worker **savourly-checkout** → https://savourly-checkout.shelts-tom.workers.dev (shows "Not found" in a browser; that's normal) | Prices the cart from `products.json`, creates the Stripe payment page, saves the order, marks it paid when Stripe confirms. Must stay public. |
| Order log | Cloudflare Worker **savourly-admin** → https://savourly-admin.shelts-tom.workers.dev | Your private page: To post / Posted / All (each paid order has a **Refund** button) / Printing (each card not yet printed has a **Cancel card** button) / Products (IDs, prices, sales, Hidden column, a print-PDF button per style; view only) / Reports (Excel downloads, weekly email). Locked with Cloudflare Access (email one-time code). |
| Database | Cloudflare D1 **savourly-orders** | Every order: ref, customer, address, items (product ID, name, style, qty, price), totals, paid/posted times. |
| Payments | Stripe (currently **test mode / sandbox**) | Takes the money; holds card details; sends "paid" webhooks. |
| Printing | Cloudflare Worker **savourly-print** → https://savourly-print.shelts-tom.workers.dev (shows "Not found"; that's normal) | Every 5 minutes, sends newly paid recipe cards to Stannp to print and post, following the off / proof / live switch. Separate from checkout: if it's off or broken, orders are still taken. See *Printing with Stannp*. |

## Domain: savourlyco.com

- Bought 28 Sep 2026 through **Cloudflare Registrar** (auto-renew on; privacy and transfer lock included). savourly.co.uk belongs to someone else.
- **Cloudflare → savourlyco.com → DNS** (all **DNS only**, grey cloud, so GitHub can issue the HTTPS certificate):
  | Type | Name | Content |
  |---|---|---|
  | A | `@` | `185.199.108.153` |
  | A | `@` | `185.199.109.153` |
  | A | `@` | `185.199.110.153` |
  | A | `@` | `185.199.111.153` |
  | CNAME | `www` | `sheltont-99.github.io` |
- **GitHub → savourly-site → Settings → Pages**: custom domain `savourlyco.com` (the `CNAME` file in this repo), **Enforce HTTPS** ticked. Don't delete the `CNAME` file, or the site falls back to the github.io address.
- The admin Worker still reads `products.json` from the github.io address; GitHub redirects it to savourlyco.com, so it keeps working.

## Order references

New orders are numbered `OID000001`, `OID000002`, … (a running number, chosen atomically so two checkouts can never clash). A number is used as soon as a customer reaches Stripe, so abandoned checkouts leave small gaps. Early test orders have older `SV-…` references.

## Where order data lives

- **All order data is in Cloudflare D1 `savourly-orders`** (table `orders`): order ref, dates, customer name, email and delivery address, items (product ID, chef ID, style, qty, price), totals, and paid/posted status. Cloudflare encrypts it at rest and in transit.
- **Never in this repo.** It's public and only holds the website, product list and product photos. Weekly Excel copies (and the print PDFs) go only to the separate **private** repo `savourly-reports`.
- **No card details anywhere of ours.** Customers enter them on Stripe's page; Stripe holds them.
- **Who can reach it:** the Cloudflare account login; the admin page (behind the email-code login); and the checkout Worker, which can only add orders and mark them paid and has no way to read them back out.
- **Backups:** D1 Time Travel restores to any point in recent days (about 7 on the free plan). There is no off-site copy yet.
- **Keep it safe:** two-step login on Cloudflare, Stripe and GitHub.

## Source code → where it's pasted

Cloudflare doesn't deploy from this repo automatically. After changing Worker code here, paste it into the matching Worker (**Edit code** → select all → paste → **Deploy**):

| File in repo | Paste into Worker | First line starts with |
|---|---|---|
| `worker/src/index.js` | **savourly-checkout** | `Savourly checkout worker (public …` |
| `admin-worker/src/index.js` | **savourly-admin** | `Savourly admin — your private orders page.` |
| `print-worker/src/index.js` | **savourly-print** | `Savourly print worker — sends paid recipe cards to Stannp …` |

Quick check that each Worker has the right code: the checkout and print URLs should say **"Not found"**; the admin URL should show your orders. If admin says "Not found", it has the checkout or print code in it. If the Printing tab says the print Worker "hasn't run", savourly-print has the wrong code or no Cron Trigger.

## Cloudflare settings (names only; values are secret)

**savourly-checkout**: Access protection **off**.
- Binding: D1 database `DB` → `savourly-orders`
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL` (= `https://savourlyco.com`)

**savourly-admin**: Access protection **on (All traffic)**, allowed email = owner's.
- Binding: D1 database `DB` → `savourly-orders`
- For the print-file **PDF** links and the weekly report copy on GitHub:
  - A **private** GitHub repo `sheltont-99/savourly-reports` (`print-files/`, `reports/`, `card-maker/`). It must stay private; the Worker refuses to save reports if it's public.
  - Secret `GITHUB_TOKEN`: a fine-grained GitHub token for **that repo only**, with *Contents: Read and write* (1-year expiry). See *Create or renew the GitHub token* below. Without it the PDF links show "PDFs not set up".
  - Cron Trigger `0 7 * * 1` (Settings → Trigger events): Mondays 07:00 UTC, which is 8am in summer and 7am in winter.
- For the **Cancel card** and **Refund** buttons (see *Cancel and refund buttons*):
  - Secret `STANNP_API_KEY`: the same Stannp key as savourly-print (to cancel cards already sent to Stannp).
  - Secret `STRIPE_SECRET_KEY`: a **restricted** Stripe key with only *Refunds: Write* (`rk_test_…` now, `rk_live_…` when live).

**savourly-print**: Access protection **off** (Stannp must reach its webhook; it shows nothing else). See *Printing with Stannp* for its settings.

**D1 `savourly-orders`**: table `orders` (see `worker/schema.sql`; `posted_at` was added later with `ALTER TABLE orders ADD COLUMN posted_at TEXT;`). Printing adds `print_jobs`, `print_settings` and `print_alerts` (`print-worker/schema.sql`). Refunds add `refunded_amount`, `refunded_at` and `stripe_refund_id` to `orders` (`admin-worker/refunds.sql`, run once).

## Stripe settings

- Webhook destination → `https://savourly-checkout.shelts-tom.workers.dev/api/stripe-webhook`
  - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
  - Payload style: Snapshot
- No Stripe products or prices are used: every order sends its lines (e.g. `PR00007 · Almighty Chicken Pie — Classic`) directly. Any products made in the Stripe dashboard can be ignored or archived.
- Test cards (test mode only; any future expiry, any CVC, any postcode). Real cards are always declined in test mode.
  | Card | Number |
  |---|---|
  | Visa (credit) | 4242 4242 4242 4242 |
  | Visa debit | 4000 0566 5566 5556 |
  | Mastercard debit | 5200 8282 8282 8210 |
  | Asks for bank verification (3D Secure), then succeeds | 4000 0025 0000 3155 |
  | Always declined | 4000 0000 0000 0002 |

## Product images and print files

**Each recipe card has 5 files: 2 images (JPG) and 3 PDFs.** You supply 4 of them (the thumbnail photo and the Classic, Vibrant and Fine Dining PDFs); the 5th, the preview image, is made automatically from the Fine Dining PDF. Recipe boxes have 3 PDFs only (no thumbnail or preview).

**The images are public; the print PDFs are private.**

| File | Where | What it is | How it gets there |
|---|---|---|---|
| `PR00007-thumbnail.jpg` | this repo, `images/` (public) | Photo on the product card (`"thumbnail"` in `products.json`) | You provide it (Claude adds it) |
| `PR00007-preview.jpg` | this repo, `images/` (public) | Picture of the card shown in the style pop-up (`"preview"`) | **Made automatically** from page 1 of the Fine Dining PDF |
| `PR00007-classic.pdf` | private repo `savourly-reports`, `print-files/` | Print file, Classic style | You provide it |
| `PR00007-vibrant.pdf` | private repo `savourly-reports`, `print-files/` | Print file, Vibrant style | You provide it |
| `PR00007-fine-dining.pdf` | private repo `savourly-reports`, `print-files/` | Print file, Fine Dining style | You provide it, or Claude makes it from the recipe with your PowerPoint template (`savourly-reports/card-maker/`) |

Boxes use the styles `the-farmhouse-box`, `the-pantry-box` and `the-heirloom-tin` (e.g. `print-files/PR00051-the-heirloom-tin.pdf`). File names must match exactly: lower-case style, spaces become hyphens. Without a thumbnail the card shows a drawn icon.

- **Adding files:** send them to Claude with the product ID and style. Print PDFs must **never** go in this public repo, only in `savourly-reports/print-files/`. Uploading one yourself on GitHub is fine too (savourly-reports → `print-files` → **Add file → Upload files**), but then ask Claude to refresh the previews.
- **Previews:** `tools/make_previews.py` reads the Fine Dining PDFs from `../savourly-reports/print-files/` (clone both repos side by side), writes the public `images/<ID>-preview.jpg`, and sets `"preview"`. Claude runs it whenever a Fine Dining PDF is added or replaced; there's no GitHub Action for it any more, because the PDFs aren't in this repo.
- **Order log:** each order line's **PDF** link, and the style buttons under each product on the **Products** tab (faded = not added yet), open `/print/<ID>-<style>.pdf` on the admin page: a small page with **← Back**, **Share / Print** (the phone's share sheet, which includes Print; on a computer it prints), **Save** (downloads the file) and **Open** (the bare PDF, `/pdf/<ID>-<style>.pdf`; add `?download=1` to download). It exists because phone browsers often show a bare PDF with no toolbar at all. The Products tab also shows a **Chef Special** placeholder on every card (`UPCOMING_STYLES` in the admin Worker). It becomes clickable once `print-files/<ID>-chef-special.pdf` is added, but customers can't order Chef Special until it's added to the styles in `products.json` and the website; when it launches, remove it from `UPCOMING_STYLES`. That page is behind your Cloudflare login and fetches the file from the private repo using the `GITHUB_TOKEN` secret. "Print file not added yet" means the file isn't in `print-files/`, or its name doesn't match.
- **Card maker:** `savourly-reports/card-maker/` (private) holds your PowerPoint templates (Fine Dining so far), each card's recipe and photo, the filled editable PowerPoints, and the script that builds the PDFs. See its README.
- **Old copies:** until 28 Sep 2026 print PDFs sat in this repo's `images/`. They've been moved, but older versions stay visible in this repo's GitHub history.

## Create or renew the GitHub token (for PDF links and weekly reports)

The key lives in your GitHub **account** settings, not the repo's settings.

1. Open **https://github.com/settings/personal-access-tokens/new**. To get there by clicking: profile picture → **Settings** → bottom of the left menu → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Fill in:
   - **Token name:** `savourly-reports`
   - **Expiration:** 1 year
   - **Repository access:** **Only select repositories** → `savourly-reports`
   - **Permissions:** **Contents** → **Read and write**
3. Click **Generate token** and copy it (starts `github_pat_`). GitHub only shows it once. Never paste it into chat or into this repo.
4. Cloudflare → **savourly-admin** → **Settings → Variables and Secrets**: add, or edit, the secret `GITHUB_TOKEN` with that value → Deploy/Save.
5. Test: admin → **Reports** → *Save last week's report to GitHub now*.

**Renewing:** GitHub emails you before the token expires. When it does, repeat steps 1–5; editing the existing `GITHUB_TOKEN` secret is fine. Until you renew, the order log's PDF links stop opening and weekly reports stop saving; everything else keeps working.

## Printing with Stannp

Paid recipe cards are printed and posted by **Stannp** (A5 enveloped postcards, 350gsm uncoated, one card per envelope). The plan and costs are in the *Savourly × Stannp Build Spec* doc. Recipe boxes are not sent; they're still posted by hand.

**How it works.** Every 5 minutes savourly-print looks for orders paid since printing was set up, makes one job per card copy (3 copies = 3 jobs), and sends each to Stannp with the private print PDF (`savourly-reports/print-files/<ID>-<style>.pdf`, read with its own read-only `GITHUB_TOKEN`) and the customer's address. Stannp then reports printing → posted → delivered back to it. Everything shows on the admin **Printing** tab.

**The switch: `STANNP_MODE`** (Cloudflare → savourly-print → Settings → Variables and Secrets → edit → Deploy). Takes effect within 5 minutes; no code change.
| Value | What happens |
|---|---|
| `off` (default) | Nothing is sent. Cards wait as **Waiting** and go out when the switch is turned back on. |
| `proof` | Sent with Stannp's test mode: a proof PDF and the real price come back, nothing prints, nothing is charged. |
| `live` | Printed and posted for real, **only if** `STRIPE_IS_LIVE` is `yes`. Otherwise it still only makes proofs, so test-mode checkouts can never print. If `LIVE_ONLY_EMAILS` is set, only orders from those emails print; the rest get proofs. |

**Safety nets**
- Only orders paid after `print-worker/schema.sql` was run are ever sent.
- **Daily cap** `DAILY_CAP_GBP` (default £20, about 20 cards): once reached, live cards wait until midnight UK time. To carry on the same day, raise the cap.
- **Alert emails** (to `ALERT_TO`): at 80% of the cap, when the cap is reached, when cards need attention, when Royal Mail returns a card, and if the Stannp key is missing. Each goes once.
- **Needs attention**: a missing print file, an address that can't be read, a line with no product ID, Stannp refusing a card, or 3 failed tries. The Printing tab shows why, with **Retry** (after fixing it) and **Done by hand**.
- Stannp never posts the same card twice: every card has its own idempotency key.
- **Refund from the order log, not Stripe's dashboard.** The order log's **Refund** button cancels the order's unprinted cards first. A refund made in Stripe's own dashboard isn't seen here and cancels nothing, so cancel those cards with **Cancel card** straight away; cancelling only works before Stannp starts printing.

**Settings (savourly-print)**
- Binding: D1 database `DB` → `savourly-orders`. Optional binding: **Send email** named `EMAIL`.
- Cron Trigger (Settings → Trigger events): `*/5 * * * *`.
- Secrets: `STANNP_API_KEY` (Stannp → Settings → API), `STANNP_WEBHOOK_SECRET` (a long random string you make up, also entered in Stannp's webhook), `GITHUB_TOKEN` (a **separate** fine-grained token for `savourly-reports` only, *Contents: Read-only*).
- Variables: `STANNP_MODE`, `STRIPE_IS_LIVE` (`no` until Stripe is live), `LIVE_ONLY_EMAILS` (optional), `DAILY_CAP_GBP` (`20`), `ALERT_TO` (your email), `ALERT_FROM` (`alerts@savourlyco.com`), `SITE_URL` (`https://savourlyco.com`).
- Stannp webhook (Stannp → Settings → Webhooks): URL `https://savourly-print.shelts-tom.workers.dev/stannp-webhook`, event `mailpiece_status`, secret = `STANNP_WEBHOOK_SECRET`.
- Alert emails use Cloudflare Email Routing on savourlyco.com: your address must be a verified destination (Email → Email Routing → Destination addresses). Without it everything else still works; the Printing tab says "alert emails not set up".

**Set it up (one time)**
1. D1 → savourly-orders → Console: paste all of `print-worker/schema.sql` → Execute.
2. Workers & Pages → Create → Worker → name `savourly-print` → Deploy → **Edit code** → paste `print-worker/src/index.js` → Deploy.
3. Its Settings: add the D1 binding, Cron Trigger, secrets and variables above (start with `STANNP_MODE` = `off`).
4. Admin Worker: paste the updated `admin-worker/src/index.js` for the Printing tab.
5. Stannp: create the webhook above.
6. Roll out in stages (from the build spec): `proof` with Stripe test payments → `proof` on real orders for 1–2 weeks (fulfil by hand meanwhile) → `live` with `STRIPE_IS_LIVE` = `yes` and `LIVE_ONLY_EMAILS` = your email → clear `LIVE_ONLY_EMAILS`.

**Pull the plug:** set `STANNP_MODE` to `off`.

## Cancel and refund buttons

Both are in the order log (savourly-admin), behind your email login.

- **Cancel card** (Printing tab, on each card that hasn't printed): a *Waiting* or *Needs attention* card is simply never sent. A card already *Sent to Stannp* is cancelled in Stannp, which only works before Stannp starts printing; if Stannp refuses, the tab says so and the card will still arrive. Proofs, and cards already printing or posted, have no button. A card shown as *Sending…* is mid-send: refresh in a minute and it can be cancelled.
- **Refund** (To post / Posted / All, on each paid order): opens a confirm page showing the amount (full by default; lower it for a partial refund), which cards can still be stopped and which are too late. Confirming cancels the unprinted cards (tick box, on by default), then refunds the card payment through Stripe. Tapping twice can't refund twice. A fully refunded order leaves *To post* and shows a *Refunded* badge under *All*. The money takes 5–10 days to reach the customer.
- Cancelled live cards don't count towards the daily print cap. The weekly Excel report still shows totals **before** refunds; check refunds in Stripe.

**Set them up (one time)**
1. D1 → savourly-orders → Console: paste all of `admin-worker/refunds.sql` → Execute. ("duplicate column name" means it was already run.)
2. Stripe (test mode) → Developers → API keys → **Create restricted key** → name `savourly-admin refunds` → set **Refunds** to **Write**, leave everything else as None → Create → copy the `rk_test_…` key.
3. Cloudflare → savourly-admin → Settings → Variables and Secrets → add secret `STRIPE_SECRET_KEY` (that key) and secret `STANNP_API_KEY` (the same Stannp key as savourly-print) → Deploy.
4. Paste the updated `admin-worker/src/index.js` into savourly-admin, and the updated `print-worker/src/index.js` into savourly-print.

Without step 1 or the Stripe key, the Refund page says what's missing and refunds nothing; everything else keeps working.

## Everyday tasks

| Task | How |
|---|---|
| See / post orders | Admin page → **To post** → *Mark as posted* |
| Hide / unhide a product | Ask Claude with the product ID (e.g. "hide PR00010"); IDs are in the admin **Products** tab |
| Add, edit, re-price, reorder products | Edit `products.json` (ask Claude, which uses the *savourly-product-manager* skill) |
| Change postage | `postage` in `products.json` |
| Check a payment | Order row → *View in Stripe* |
| Print a product | Order row → **PDF** next to the product → **Share / Print** (opens the private `print-files/<ID>-<style>.pdf` through your login; works on a phone too) |
| Add product photos / print PDFs | Send them to Claude with the product ID (and style for PDFs); see *Product images and print files* |
| Add or change a chef's photo | Send it to Claude with the chef's name or ID. It's saved as `images/<CHEF ID>-portrait.jpg` and set as `photo:` on the chef's `CHEFS` entry in `index.html`. That one photo is used on the chef's page **and** as the small round picture on each of their cards on the Recipes tab, so both update together. Chefs with no photo show their initials there. |
| Make a Fine Dining card from a recipe | Paste the recipe (text or a picture) to Claude, which uses the *savourly-recipe-card-pdf-creator* skill |
| Stop a card printing | Admin → **Printing** → **Cancel card** (only before Stannp starts printing) |
| Refund an order | Admin → the order → **Refund** → check the amount → **Refund £…** (also cancels its unprinted cards) |
| Turn Stannp printing off / on | Cloudflare → savourly-print → Settings → Variables → `STANNP_MODE` = `off` / `proof` / `live` |
| A card needs attention | Admin → **Printing** → read the reason → fix it (e.g. send Claude the missing print PDF) → **Retry**, or **Done by hand** |
| Excel report | Admin → **Reports** → *Last week* / *This week so far* / *All orders*; weekly copies in the private repo `savourly-reports/reports/<year>/` |

ID rules: products are `PR` + 5 digits, chefs are `CHEF` + 5 digits (listed under `chefs` in `products.json`, and on each chef's `CHEFS` entry in `index.html`). The next number is always the highest + 1, and IDs are never changed or reused. Products are hidden (`"hidden": true`), not deleted.

## Going live (real payments), when ready

1. Clear test orders: D1 console → `DELETE FROM orders;` (deletes **every** order; only before real customers).
2. Stripe → switch to live mode → Developers → API keys → copy the live secret key (`sk_live_…`) → replace `STRIPE_SECRET_KEY` in savourly-checkout.
3. Stripe (live mode) → create the same webhook destination as above → copy its new signing secret → replace `STRIPE_WEBHOOK_SECRET`.
   Also create a live **restricted key** (Refunds: Write) and replace `STRIPE_SECRET_KEY` in **savourly-admin**, or the Refund button will fail on real orders.
4. In `admin-worker/src/index.js`, change the two `dashboard.stripe.com/test/` links to `dashboard.stripe.com/` and paste into savourly-admin.
5. Do one real small purchase, check it in the admin page and Stripe, then refund it in Stripe.
6. Add a privacy policy (the site stores customer names, emails and addresses).

## Weekly Excel report

Built inside savourly-admin (no extra services). Every Monday a copy of last week's report is committed to the private repo as `reports/<year>/<Mon>_to_<Sun>.xlsx`, e.g. `reports/2026/2026-09-21_to_2026-09-27.xlsx`. Covers **paid** orders created Monday 00:00 to Sunday 23:59 UK time. It has three sheets:
- **Summary**: paid orders, still to post, cards and boxes sold, subtotal, postage and total taken, plus best sellers by product ID.
- **Orders**: one row per order.
- **Items**: one row per product line, with product and chef IDs.

The Summary figures are live Excel formulas over the other sheets. Totals are before Stripe fees.

## Troubleshooting

- **Site still shows old behaviour**: hard refresh (Ctrl/Cmd+Shift+R). The site doesn't reload between pages.
- **"Couldn't load the recipe cards"**: `products.json` has a JSON mistake (usually a comma). Check the latest commit to it.
- **"Something went wrong starting checkout"**: check the savourly-checkout code/secrets; look at its Logs in Cloudflare.
- **Weekly report not in GitHub**: admin → Reports → *Save last week's report to GitHub now* shows the exact error. Check the Cron Trigger exists, the repo is private, and `GITHUB_TOKEN` hasn't expired.
- **Printing tab: "hasn't run"**: savourly-print is missing its Cron Trigger or has the wrong code (its URL should say "Not found"). Check its Logs.
- **Cards stay "Waiting"**: `STANNP_MODE` is `off`, the daily cap was reached (banner on the Printing tab), or `STANNP_API_KEY` is missing.
- **"Print file missing"**: there's no `print-files/<ID>-<style>.pdf` yet (Classic files don't exist yet). Add the file, then **Retry**.
- **Refund says "Refund NOT made"**: the reason after the colon is Stripe's. "Invalid API key" or "permission" means `STRIPE_SECRET_KEY` on savourly-admin is wrong, test vs live mixed up, or missing *Refunds: Write*. Any cards it says it cancelled stay cancelled; fix the key and refund again.
- **"Couldn't cancel … started printing"**: Stannp had already begun; the card will arrive. Refund if needed.
- **Order stuck on "Not paid"**: webhook problem. Check the Stripe webhook destination's recent deliveries; Stripe retries for 3 days.
