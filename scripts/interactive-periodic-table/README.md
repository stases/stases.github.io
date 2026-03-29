# Interactive Periodic Table

A static, GitHub Pages-friendly periodic table inspired by the split layout you shared.

## What's included

- Full 118-element periodic table
- Right-side detail panel
- Animated Bohr-style shell visualization
- Search by name, symbol, or atomic number
- Category legend with filter chips
- Responsive layout for desktop and mobile
- No framework, no build step

## Files

- `index.html`
- `styles.css`
- `elements-data.js`
- `app.js`
- `.nojekyll`

## Deploy on GitHub Pages

1. Upload the contents of this folder to the root of your repository, or to `/docs`.
2. In GitHub, open **Settings → Pages**.
3. Choose the branch and folder you want to publish.
4. Save.

## Customize the sidebar copy

Open `app.js` and edit the `buildNarrative()` function. That is the easiest place to replace the generated element text with your own wording.

## Customize colors

Open `styles.css` and change the `--cat-*` variables at the top of the file.

## Replace the animated atom

The shell renderer lives in `drawAtom()` inside `app.js`. You can swap that out for a static SVG, Three.js scene, image, or anything else without changing the rest of the layout.
