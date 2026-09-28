# Savourly checkout worker

> **Update:** the orders page has moved out of this Worker into `admin-worker/`, a separate Worker locked with Cloudflare Access (email login). This Worker no longer has `/orders` or `/api/orders.json`, and `ADMIN_PASSWORD` is no longer used.

A small Cloudflare Worker that sits between the site and Stripe. It does two jobs:

1. **Takes whatever's in the cart and creates a Stripe Checkout Session for it on the fly** — no
   Stripe Product/Price has to exist in advance for any recipe card, so this scales to
   however many card designs you add, forever, with zero Stripe catalog admin.
2. **Records every order in its own small database** (Cloudflare D1 — free, included), so you have
   a permanent, searchable log of exactly what was ordered (chef/recipe/style/qty), independent of
   Stripe's own dashboard, which only shows you a payment amount and a product name string.

You get a **`/orders`** page (password protected) to browse all orders whenever you like, and each
row links straight to the matching payment in the Stripe dashboard so you can cross-check the two.

## One-time setup (about 15 minutes)

You'll need a free Cloudflare account (cloudflare.com → sign up) if you don't have one already.

### 1. Install the Cloudflare CLI and log in

```
npm install -g wrangler
wrangler login
```

This opens a browser window to authorize the CLI against your Cloudflare account.

### 2. Create the database

```
cd worker
wrangler d1 create savourly-orders
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Then create the `orders` table:

```
wrangler d1 execute savourly-orders --remote --file=./schema.sql
```

### 3. Set your secrets

None of these go in any file — they're stored encrypted by Cloudflare:

```
wrangler secret put STRIPE_SECRET_KEY
```
Paste your Stripe **secret key** (starts `sk_test_...` while you're testing; you'll set a second,
live one later when you go live — see "Going live" below).

```
wrangler secret put STRIPE_WEBHOOK_SECRET
```
You'll get this value in step 5 below — come back to this command after that step.

```
wrangler secret put ADMIN_PASSWORD
```
Choose a password — this protects your `/orders` dashboard. Anyone with this password can see
customer names, emails and addresses, so pick something real and don't share it casually.

```
wrangler secret put SITE_URL
```
Enter `https://savourlyco.com` (no trailing slash).

### 4. Deploy

```
wrangler deploy
```

This prints a URL like `https://savourly-checkout.<your-subdomain>.workers.dev` — that's your
worker's address. Copy it.

### 5. Point Stripe's webhook at it

In the Stripe Dashboard (make sure you're in **Test mode** while testing):
- Go to **Developers → Webhooks → Add endpoint**
- Endpoint URL: `https://savourly-checkout.<your-subdomain>.workers.dev/api/stripe-webhook`
- Select events to send: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.expired`
- Save, then click into the new endpoint and reveal its **Signing secret** (starts `whsec_...`)
- Go back and run `wrangler secret put STRIPE_WEBHOOK_SECRET`, pasting that value in.

### 6. Wire it into the site

In `index.html`, find this line near the top of the `<script>` block:

```js
const CHECKOUT_API = ''; // e.g. 'https://savourly-checkout.YOURNAME.workers.dev'
```

Paste in your worker's URL (no trailing slash), commit, and push. That's the only site change
needed — the checkout button automatically switches from the fake "Order confirmed" demo screen
to a real redirect to Stripe's hosted payment page.

## Using it

- **Test a purchase**: add cards to your cart on the live site, go to checkout, fill in the
  shipping fields, click "Pay and post" — you'll land on Stripe's real hosted payment page. Use
  Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC, any postcode.
- **See your orders**: visit `https://savourly-checkout.<your-subdomain>.workers.dev/orders` and
  log in with the `ADMIN_PASSWORD` you set (your browser will prompt for it). You'll see every
  order — ref, date, status, customer, exactly which cards/styles/quantities, total, and a link
  to that payment in the Stripe dashboard, so you can compare the two side by side.
- **Export as JSON**: `/api/orders.json` (same password) if you ever want to pull the data into a
  spreadsheet or another tool.
- Bookmark the `/orders` link somewhere private — it's the same URL every time.

## Going live

When you're ready to take real payments:
1. Switch Stripe to **Live mode**, get your live secret key, and run
   `wrangler secret put STRIPE_SECRET_KEY` again with the live one (`sk_live_...`).
2. Repeat step 5 above in Live mode to create a **live** webhook endpoint and get its own
   `whsec_...`, then update `STRIPE_WEBHOOK_SECRET` to that.
3. In `worker/src/index.js`, the `/orders` page currently links to
   `dashboard.stripe.com/test/payments/...` — change `/test/payments/` to `/payments/` (and
   `/test/checkout/sessions/` to `/checkout/sessions/`) so the links point at live payments instead
   of test ones, then `wrangler deploy` again.

Nothing else changes — the same worker, database and `/orders` page keep working, just now
against real money.

## Products and IDs

`products.json` at the root of the site is the **only** place products live:

```json
{
  "currency": "gbp", "postage": 1.49,
  "styles": { "card": ["Classic", "Vibrant", "Fine Dining"], "box": ["The Farmhouse Box", "The Pantry Box", "The Heirloom Tin"] },
  "chefs": [ { "id": "CHEF00002", "name": "Luca Ferretti" } ],
  "products": [
    { "id": "PR00053", "name": "Pumpkin Tortelli", "chefId": "CHEF00002", "type": "card",
      "price": 1.99, "description": "…", "photo": "images/PR00053.jpg", "hidden": false }
  ]
}
```

- `id` (PR00001…) and chef `id` (CHEF00001…) are permanent. Never change or reuse them, because past orders refer to them.
- `chefId` links a card to its chef (`null` for boxes). The chef's page content (bio etc.) is the matching `CHEFS` entry in `index.html`, which carries the same `id`.
- Cards appear in the order they're listed. `hidden: true` removes a product from the site and checkout but keeps its ID and sales history.

The website, the checkout Worker (prices) and the admin page (Products tab) all read this file.
