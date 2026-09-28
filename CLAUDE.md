# Savourly

A recipe-card shop: chefs publish recipe cards, customers buy and print them. Full architecture in `SETUP.md` — read that for how the pieces fit together.

**Architecture diagram**: https://claude.ai/artifact/PpXRrURp7ZZ75LEBxi9fkw — three flows: Claude pushing content into the two repos below (which auto-deploy on push to `main`), a shopper browsing/paying (checkout Worker → Stripe → D1), and the owner reading orders via the admin Worker.

## Use these skills for this repo

- **savourly-product-manager** — adding, editing, re-pricing, hiding/unhiding or reordering recipe cards, recipe boxes or chefs; adding thumbnails and print PDFs.
- **savourly-recipe-card-pdf-creator** — turning a pasted recipe (text or image) into a Fine Dining print card.
- **savourly-system** — changes to checkout, the order log, reports, print-file links, Stripe payments or Cloudflare setup; fixing something broken; going live.

Reach for one of these first for anything matching its description, rather than editing `products.json` or the Cloudflare Workers by hand.

## Repos

- `sheltont-99/savourly-site` (this repo, public) — website, `products.json`, product images.
- `sheltont-99/savourly-reports` (private) — order reports, card-maker templates, print PDFs. Clone it next to this repo for anything involving print PDFs or previews.

## Branch

Develop on `claude/site-building-wytg19`, merge to `main` when ready. GitHub Pages serves `main` only — nothing is live until it's merged there.
