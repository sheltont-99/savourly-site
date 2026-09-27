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
                                               │  Products tab reads/writes products.json on GitHub
```

| Piece | Where | What it does |
|---|---|---|
| Website | `index.html` in this repo → https://sheltont-99.github.io/savourly-site/ | Shop, chef pages, cart, checkout form. Builds every card from `products.json`. |
| Product list | `products.json` (+ photos in `images/`) | The only place products live: IDs, names, chefs, prices, descriptions, hidden flags, postage. |
| Checkout | Cloudflare Worker **savourly-checkout** → https://savourly-checkout.shelts-tom.workers.dev (shows "Not found" in a browser; that's normal) | Prices the cart from `products.json`, creates the Stripe payment page, saves the order, marks it paid when Stripe confirms. Must stay public. |
| Order log | Cloudflare Worker **savourly-admin** → https://savourly-admin.shelts-tom.workers.dev | Your private page: To post / Posted / All / Products. Locked with Cloudflare Access (email one-time code). |
| Database | Cloudflare D1 **savourly-orders** | Every order: ref, customer, address, items (product ID, name, style, qty, price), totals, paid/posted times. |
| Payments | Stripe (currently **test mode / sandbox**) | Takes the money; holds card details; sends "paid" webhooks. |

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
- Secret: `GITHUB_TOKEN`, a fine-grained GitHub token for this repo only, *Contents: read and write*, 1-year expiry. It powers the Products tab tick boxes. When it expires the boxes become read-only; make a new token and replace the secret.

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
| Hide / unhide a product | Admin page → **Products** → untick / tick (site updates in ~2 min) |
| Add, edit, re-price, reorder products | Edit `products.json` (ask Claude, which uses the *savourly-products* skill) |
| Change postage | `postage` in `products.json` |
| Check a payment | Order row → *View in Stripe* |

Product ID rules: `PR` + 5 digits, next number = highest + 1, never changed or reused; hide instead of deleting.

## Going live (real payments), when ready

1. Clear test orders: D1 console → `DELETE FROM orders;` (deletes **every** order; only before real customers).
2. Stripe → switch to live mode → Developers → API keys → copy the live secret key (`sk_live_…`) → replace `STRIPE_SECRET_KEY` in savourly-checkout.
3. Stripe (live mode) → create the same webhook destination as above → copy its new signing secret → replace `STRIPE_WEBHOOK_SECRET`.
4. In `admin-worker/src/index.js`, change the two `dashboard.stripe.com/test/` links to `dashboard.stripe.com/` and paste into savourly-admin.
5. Do one real small purchase, check it in the admin page and Stripe, then refund it in Stripe.
6. Add a privacy policy (the site stores customer names, emails and addresses).

## Troubleshooting

- **Site still shows old behaviour**: hard refresh (Ctrl/Cmd+Shift+R). The site doesn't reload between pages.
- **"Couldn't load the recipe cards"**: `products.json` has a JSON mistake (usually a comma). Check the latest commit to it.
- **"Something went wrong starting checkout"**: check the savourly-checkout code/secrets; look at its Logs in Cloudflare.
- **Order stuck on "Not paid"**: webhook problem. Check the Stripe webhook destination's recent deliveries; Stripe retries for 3 days.
- **Products tab says read-only**: `GITHUB_TOKEN` missing, wrong or expired.
