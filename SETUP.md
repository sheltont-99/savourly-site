# Savourly: how everything fits together

This repo is public. Nothing here is secret; keys and passwords live only in Cloudflare.

## The pieces

```
 Customer ──► Website (GitHub Pages) ──"Pay and post"──► savourly-checkout (Cloudflare Worker)
                  │  reads products.json                       │  reads products.json for prices
                  │                                            │  writes order to D1 (pending)
                  │                                            ▼
                  │                                   Stripe hosted payment page
                  │                                            │  webhook: "paid"
                  ◄──────── back to site, "Order confirmed" ───┤
                                                               ▼
 You ──email login (Cloudflare Access)──► savourly-admin ──► D1 database "savourly-orders"
                                               │  Products tab reads products.json (view only)
```

| Piece | Where | What it does |
|---|---|---|
| Website | `index.html` in this repo → https://sheltont-99.github.io/savourly-site/ | Shop, chef pages, cart, checkout form. Builds every card from `products.json`. |
| Product list | `products.json` (+ photos in `images/`) | The only place products live: IDs, names, chefs, prices, descriptions, hidden flags, postage. |
| Checkout | Cloudflare Worker **savourly-checkout** → https://savourly-checkout.shelts-tom.workers.dev (shows "Not found" in a browser; that's normal) | Prices the cart from `products.json`, creates the Stripe payment page, saves the order, marks it paid when Stripe confirms. Must stay public. |
| Order log | Cloudflare Worker **savourly-admin** → https://savourly-admin.shelts-tom.workers.dev | Your private page: To post / Posted / All / Products (IDs, prices, sales, Hidden column, a print-PDF button per style; view only) / Reports (Excel downloads, weekly email). Locked with Cloudflare Access (email one-time code). |
| Database | Cloudflare D1 **savourly-orders** | Every order: ref, customer, address, items (product ID, name, style, qty, price), totals, paid/posted times. |
| Payments | Stripe (currently **test mode / sandbox**) | Takes the money; holds card details; sends "paid" webhooks. |

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

Quick check that each Worker has the right code: the checkout URL should say **"Not found"**; the admin URL should show your orders. If admin says "Not found", it has the checkout code in it.

## Cloudflare settings (names only; values are secret)

**savourly-checkout**: Access protection **off**.
- Binding: D1 database `DB` → `savourly-orders`
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL` (= `https://sheltont-99.github.io/savourly-site`)

**savourly-admin**: Access protection **on (All traffic)**, allowed email = owner's.
- Binding: D1 database `DB` → `savourly-orders`
- For the print-file **PDF** links and the weekly report copy on GitHub:
  - A **private** GitHub repo `sheltont-99/savourly-reports` (`print-files/`, `reports/`, `card-maker/`). It must stay private; the Worker refuses to save reports if it's public.
  - Secret `GITHUB_TOKEN`: a fine-grained GitHub token for **that repo only**, with *Contents: Read and write* (1-year expiry). See *Create or renew the GitHub token* below. Without it the PDF links show "PDFs not set up".
  - Cron Trigger `0 7 * * 1` (Settings → Trigger events): Mondays 07:00 UTC, which is 8am in summer and 7am in winter.

**D1 `savourly-orders`**: table `orders` (see `worker/schema.sql`; `posted_at` was added later with `ALTER TABLE orders ADD COLUMN posted_at TEXT;`).

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

**Each recipe card has 5 files: 2 images (JPG) and 3 PDFs.** You supply 4 of them (the thumbnail photo and the Classic, Funky and Fine Dining PDFs); the 5th, the preview image, is made automatically from the Fine Dining PDF. Recipe boxes have 3 PDFs only (no thumbnail or preview).

**The images are public; the print PDFs are private.**

| File | Where | What it is | How it gets there |
|---|---|---|---|
| `PR00007-thumbnail.jpg` | this repo, `images/` (public) | Photo on the product card (`"thumbnail"` in `products.json`) | You provide it (Claude adds it) |
| `PR00007-preview.jpg` | this repo, `images/` (public) | Picture of the card shown in the style pop-up (`"preview"`) | **Made automatically** from page 1 of the Fine Dining PDF |
| `PR00007-classic.pdf` | private repo `savourly-reports`, `print-files/` | Print file, Classic style | You provide it |
| `PR00007-funky.pdf` | private repo `savourly-reports`, `print-files/` | Print file, Funky style | You provide it |
| `PR00007-fine-dining.pdf` | private repo `savourly-reports`, `print-files/` | Print file, Fine Dining style | You provide it, or Claude makes it from the recipe with your PowerPoint template (`savourly-reports/card-maker/`) |

Boxes use the styles `kraft-wrap`, `gift-ribbon` and `keepsake-tin` (e.g. `print-files/PR00051-keepsake-tin.pdf`). File names must match exactly: lower-case style, spaces become hyphens. Without a thumbnail the card shows a drawn icon.

- **Adding files:** send them to Claude with the product ID and style. Print PDFs must **never** go in this public repo, only in `savourly-reports/print-files/`. Uploading one yourself on GitHub is fine too (savourly-reports → `print-files` → **Add file → Upload files**), but then ask Claude to refresh the previews.
- **Previews:** `tools/make_previews.py` reads the Fine Dining PDFs from `../savourly-reports/print-files/` (clone both repos side by side), writes the public `images/<ID>-preview.jpg`, and sets `"preview"`. Claude runs it whenever a Fine Dining PDF is added or replaced; there's no GitHub Action for it any more, because the PDFs aren't in this repo.
- **Order log:** each order line's **PDF** link, and the style buttons under each product on the **Products** tab (faded = not added yet), open `/pdf/<ID>-<style>.pdf` on the admin page. That page is behind your Cloudflare login and fetches the file from the private repo using the `GITHUB_TOKEN` secret. "Print file not added yet" means the file isn't in `print-files/`, or its name doesn't match.
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

## Everyday tasks

| Task | How |
|---|---|
| See / post orders | Admin page → **To post** → *Mark as posted* |
| Hide / unhide a product | Ask Claude with the product ID (e.g. "hide PR00010"); IDs are in the admin **Products** tab |
| Add, edit, re-price, reorder products | Edit `products.json` (ask Claude, which uses the *savourly-product-manager* skill) |
| Change postage | `postage` in `products.json` |
| Check a payment | Order row → *View in Stripe* |
| Print a product | Order row → **PDF** next to the product (opens the private `print-files/<ID>-<style>.pdf` through your login) |
| Add product photos / print PDFs | Send them to Claude with the product ID (and style for PDFs); see *Product images and print files* |
| Make a Fine Dining card from a recipe | Paste the recipe (text or a picture) to Claude, which uses the *savourly-recipe-card-pdf-creator* skill |
| Excel report | Admin → **Reports** → *Last week* / *This week so far* / *All orders*; weekly copies in the private repo `savourly-reports/reports/<year>/` |

ID rules: products are `PR` + 5 digits, chefs are `CHEF` + 5 digits (listed under `chefs` in `products.json`, and on each chef's `CHEFS` entry in `index.html`). The next number is always the highest + 1, and IDs are never changed or reused. Products are hidden (`"hidden": true`), not deleted.

## Going live (real payments), when ready

1. Clear test orders: D1 console → `DELETE FROM orders;` (deletes **every** order; only before real customers).
2. Stripe → switch to live mode → Developers → API keys → copy the live secret key (`sk_live_…`) → replace `STRIPE_SECRET_KEY` in savourly-checkout.
3. Stripe (live mode) → create the same webhook destination as above → copy its new signing secret → replace `STRIPE_WEBHOOK_SECRET`.
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
- **Order stuck on "Not paid"**: webhook problem. Check the Stripe webhook destination's recent deliveries; Stripe retries for 3 days.
