# Time Machines - Minimal Static Site Starter

A tiny, no-build static site starter inspired by a monolithic oval "portal".

- **Home page**: white background + black oval.
- **Click the oval**: colors invert with a smooth fade, then navigation links appear *inside* the oval.
- **Inner pages**: black background + white text in a monospaced / typewriter-ish style.

Everything is plain **HTML + CSS + JS** so you can host it for free on **Cloudflare Pages**, GitHub Pages, Netlify, etc.

---

## Local development (Python)

You don't need a backend. This site serves directly from the repository root, so
run a simple static file server from the project root.

If you're using Conda, activate your env first:

```bash
conda activate torch-gpu
```

### Option A: run the included `serve.py`

```bash
# From the project root:
python3 serve.py
```

### Option B: use Python's built-in server

```bash
# From the project root:
python3 -m http.server 8000
```

Then open:

- http://localhost:8000

If you're on Windows and `python3` isn't found, try `py`:

```bash
py serve.py
# or
py -m http.server 8000
```

---

## Deploy to Cloudflare Pages (free)

1. Push this repository to GitHub (or GitLab).
2. In Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → connect your repo.
3. Use these settings:

- **Framework preset**: None
- **Build command**: *(leave empty)*
- **Build output directory**: `/`

Cloudflare will publish the repository root.

---

## Files to edit

- `index.html` — the oval + links.
- `assets/styles.css` — all styling (colors, transitions, typography).
- `assets/script.js` — click behavior + enabling links after the fade.
- `*.html` / `blogposts/**/*.html` — your content pages.

---

## Customizing

- Add/remove links: edit the `<a>` items inside `index.html`.
- Change transition speed: edit `--transition-ms` in `assets/styles.css`.
- Change oval size/aspect: edit `.monolith` sizing in `assets/styles.css`.
- Want a closer album-text feel? Drop in a typewriter-ish font (e.g. Courier Prime / IBM Plex Mono) and set it in `--type`.
