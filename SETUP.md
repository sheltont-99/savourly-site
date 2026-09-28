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
| Order log | Cloudflare Worker **savourly-admin** → https://savourly-admin.shelts-tom.workers.dev | Your private page: To post / Posted / All / Products (IDs, prices, sales, Hidden column; view only) / Reports (Excel downloads, weekly email). Locked with Cloudflare Access (email one-time code). |
| Database | Cloudflare D1 **savourly-orders** | Every order: ref, customer, address, items (product ID, name, style, qty, price), totals, paid/posted times. |
| Payments | Stripe (currently **test mode / sandbox**) | Takes the money; holds card details; sends "paid" webhooks. |

## Where order data lives

- **All order data is in Cloudflare D1 `savourly-orders`** (table `orders`): order ref, dates, customer name, email and delivery address, items (product ID, chef ID, style, qty, price), totals, and paid/posted status. Cloudflare encrypts it at rest and in transit.
- **Never in this repo.** It's public and only holds the website and product list.
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
- For the weekly email report (optional):
  - Secret `RESEND_API_KEY`: an API key from resend.com (free). Without your own domain, Resend only delivers to the email address you signed up to Resend with.
  - Secret `REPORT_EMAIL`: where the report goes (that same address).
  - Cron Trigger `0 7 * * 1` (Settings → Trigger events): Mondays 07:00 UTC, which is 8am in summer and 7am in winter.
- If a `GITHUB_TOKEN` secret was added earlier, it's no longer used and can be deleted, along with the GitHub token itself.

**D1 `savourly-orders`**: table `orders` (see `worker/schema.sql`; `posted_at` was added later with `ALTER TABLE orders ADD COLUMN posted_at TEXT;`).

## Stripe settings

- Webhook destination → `https://savourly-checkout.shelts-tom.workers.dev/api/stripe-webhook`
  - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
  - Payload style: Snapshot
- No Stripe products or prices are used: every order sends its lines (e.g. `PR00007 · Almighty Chicken Pie — Classic`) directly. Any products made in the Stripe dashboard can be ignored or archived.
- Test card: 4242 4242 4242 4242, any future date, any CVC. Real cards are declined in test mode.

## Everyday tasks

| Task | How |
|---|---|
| See / post orders | Admin page → **To post** → *Mark as posted* |
| Hide / unhide a product | Ask Claude with the product ID (e.g. "hide PR00010"); IDs are in the admin **Products** tab |
| Add, edit, re-price, reorder products | Edit `products.json` (ask Claude, which uses the *savourly-products* skill) |
| Change postage | `postage` in `products.json` |
| Check a payment | Order row → *View in Stripe* |
| Excel report | Admin → **Reports** → *Last week* / *This week so far* / *All orders*; or wait for Monday's email |

ID rules: products are `PR` + 5 digits, chefs are `CHEF` + 5 digits (listed under `chefs` in `products.json`, and on each chef's `CHEFS` entry in `index.html`). The next number is always the highest + 1, and IDs are never changed or reused. Products are hidden (`"hidden": true`), not deleted.

## Going live (real payments), when ready

1. Clear test orders: D1 console → `DELETE FROM orders;` (deletes **every** order; only before real customers).
2. Stripe → switch to live mode → Developers → API keys → copy the live secret key (`sk_live_…`) → replace `STRIPE_SECRET_KEY` in savourly-checkout.
3. Stripe (live mode) → create the same webhook destination as above → copy its new signing secret → replace `STRIPE_WEBHOOK_SECRET`.
4. In `admin-worker/src/index.js`, change the two `dashboard.stripe.com/test/` links to `dashboard.stripe.com/` and paste into savourly-admin.
5. Do one real small purchase, check it in the admin page and Stripe, then refund it in Stripe.
6. Add a privacy policy (the site stores customer names, emails and addresses).

## Weekly Excel report

Built inside savourly-admin (no extra services except Resend for email). Covers **paid** orders created Monday 00:00 to Sunday 23:59 UK time. It has three sheets:
- **Summary**: paid orders, still to post, cards and boxes sold, subtotal, postage and total taken, plus best sellers by product ID.
- **Orders**: one row per order.
- **Items**: one row per product line, with product and chef IDs.

The Summary figures are live Excel formulas over the other sheets. Totals are before Stripe fees.

## Troubleshooting

- **Site still shows old behaviour**: hard refresh (Ctrl/Cmd+Shift+R). The site doesn't reload between pages.
- **"Couldn't load the recipe cards"**: `products.json` has a JSON mistake (usually a comma). Check the latest commit to it.
- **"Something went wrong starting checkout"**: check the savourly-checkout code/secrets; look at its Logs in Cloudflare.
- **Weekly email didn't arrive**: check spam; admin → Reports → *Email me last week's report now* shows any error; check the Cron Trigger exists and `REPORT_EMAIL` matches the Resend sign-up address.
- **Order stuck on "Not paid"**: webhook problem. Check the Stripe webhook destination's recent deliveries; Stripe retries for 3 days.
