# Crystalite Beamer Preset

This folder is a self-contained Beamer starter translated from the `blogposts/crystalite` article
into a presentation format. It keeps the article's quiet editorial feel:

- soft blue-white paper background
- dark slate typography
- muted mono metadata labels
- rounded figure cards with light borders
- restrained blue-lilac accents for emphasis and plots

## Included

- `main.tex`: example slide deck
- `beamerthemecrystalite.sty`: reusable theme
- `assets/fonts/`: bundled local font files copied from the repository
- `assets/images/`: copied Crystalite figures
- `data/`: editable CSV files used by the plot examples
- `Makefile` and `latexmkrc`: build helpers

## Build

The safest default build is:

```bash
make
```

or

```bash
latexmk main.tex
```

## Notes

- When LuaLaTeX or XeLaTeX is available with a healthy font stack, the theme uses the repository's
  bundled PP Supply and PP Rader files. Under pdfLaTeX it falls back to a close sans/mono stack so
  the deck still builds cleanly.
- The CSV plot data is illustrative placeholder data. Replace it with your own values while keeping
  the same plotting styles.
- The theme is written to be easy to modify directly in `beamerthemecrystalite.sty`.
