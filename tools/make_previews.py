#!/usr/bin/env python3
"""Make each product's style-picker preview from its Fine Dining print PDF.

Print PDFs are private: they live in the private repo savourly-reports, folder print-files/.
For every product in products.json that has <pdf-dir>/<ID>-fine-dining.pdf, render page 1
to images/<ID>-preview.jpg (720px wide, public) and set "preview" in products.json.
Previews are only remade when the PDF is newer than the existing preview (or with --force).
Needs `pdftoppm` (poppler-utils) and Pillow. Run from the savourly-site repo root, with
savourly-reports cloned next to it:
    python3 tools/make_previews.py [--force] [--pdf-dir ../savourly-reports/print-files]
"""
import json, os, subprocess, sys, tempfile

from PIL import Image

WIDTH = 720
SOURCE_STYLE = 'fine-dining'  # previews are made from this style's PDF


def pdf_dir():
    if '--pdf-dir' in sys.argv:
        return sys.argv[sys.argv.index('--pdf-dir') + 1]
    return os.path.join('..', 'savourly-reports', 'print-files')


def main():
    src = pdf_dir()
    if not os.path.isdir(src):
        sys.exit(f"Can't find the private print files folder {src}. Clone sheltont-99/savourly-reports next to this repo, or pass --pdf-dir.")
    with open('products.json', encoding='utf-8') as f:
        cat = json.load(f)
    changed, made = False, []
    for p in cat['products']:
        pdf = os.path.join(src, f"{p['id']}-{SOURCE_STYLE}.pdf")
        jpg = f"images/{p['id']}-preview.jpg"
        if not os.path.exists(pdf):
            continue
        stale = not os.path.exists(jpg) or os.path.getmtime(pdf) > os.path.getmtime(jpg) or '--force' in sys.argv
        if stale:
            with tempfile.TemporaryDirectory() as tmp:
                subprocess.run(['pdftoppm', '-f', '1', '-l', '1', '-r', '150', '-png', pdf, os.path.join(tmp, 'p')], check=True)
                page = next(os.path.join(tmp, n) for n in sorted(os.listdir(tmp)) if n.endswith('.png'))
                im = Image.open(page).convert('RGB')
                im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
                im.save(jpg, 'JPEG', quality=85, optimize=True, progressive=True)
            made.append(jpg)
        if p.get('preview') != jpg:
            p['preview'] = jpg
            changed = True
    if changed:
        order = ['id', 'name', 'chefId', 'type', 'price', 'description', 'thumbnail', 'preview', 'hidden']
        cat['products'] = [{k: p[k] for k in order if k in p} | {k: v for k, v in p.items() if k not in order} for p in cat['products']]
        with open('products.json', 'w', encoding='utf-8') as f:
            json.dump(cat, f, indent=2, ensure_ascii=False)
            f.write('\n')
    print(f"Previews made: {len(made)}{' (' + ', '.join(made) + ')' if made else ''}; products.json {'updated' if changed else 'unchanged'}")


if __name__ == '__main__':
    main()
