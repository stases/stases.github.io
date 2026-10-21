# Orbit Explorer

An interactive, static figure comparing atom tokens with Wyckoff-orbit tokens for
11 real MP-20 crystals. The view shows conventional cells;
Crystalite chips count primitive atoms. Coordinate and lattice edits are
explicitly labelled and can be reset.

Cell-to-cell bonds are all retained. Bonds to ghosts and coordination polyhedra
are drawn only around primary images (`image = [0, 0, 0]`). Ghost radius is 0.5×
and colour mixes 75% toward the background; ghost bond radius is 0.6× with 65% mixing.
Cell edges are 2 px (3 px with L selected); line loci are 3 px at 0.85 opacity,
plane edges 2 px at 0.6 and plane fill 0.16. Axis labels extend 0.45 Å beyond
the corner sphere. Camera fit uses the larger of the cell radius plus the largest
cell-site sphere radius, or 90% of the ghost-shell radius, with a 1.02 margin.
The desktop viewport and panel are 560 px tall; the mobile viewport is 340 px.

Files (relative to the website root):

- `orbit-explorer.html`: standalone page, import map and initial theme.
- `scripts/orbit-explorer/app.js`: UI, three.js rendering and automation hook.
- `scripts/orbit-explorer/styles.css`: responsive layout and native themes.
- `scripts/orbit-explorer/geometry.js`: pure fractional-coordinate and neighbour geometry.
- `scripts/orbit-explorer/crystals.js`: frozen generated dataset.
- `scripts/orbit-explorer/vendor/three/`: unmodified three.js r170 and addons.

Serve the repository root with `python3 -m http.server 8000` and open
`http://localhost:8000/orbit-explorer.html`. Add `?embed=1` for the post layout,
with optional `&theme=light` or `&theme=dark`. Embedded figures otherwise follow
the parent article's `data-theme` and send `orbit-explorer:height` messages.

Run the frozen geometry checks from the repository root:

```sh
node scripts/orbit-explorer/test_geometry.mjs
node --experimental-default-type=module --check scripts/orbit-explorer/geometry.js
node --experimental-default-type=module --check scripts/orbit-explorer/app.js
```

`make_data.py` generates `crystals.js` from Orbitol's tokenizer and Wyckoff tables and the MP-20
CSVs, and `check_data.py` validates it. Both need an Orbitol checkout on `PYTHONPATH` and the
MP-20 raw CSVs (`MP20_RAW`, default `~/GitHub/crystalite/data/mp20/raw`):

```sh
PYTHONPATH=<orbitol checkout> python scripts/orbit-explorer/make_data.py
python scripts/orbit-explorer/check_data.py
```

The dataset's `meta` records the Orbitol commit, table hash and library versions. Do not regenerate
or hand-edit the frozen snapshot as part of UI changes.

`window.orbitExplorer` exposes `selectCrystal(id)`, `selectOrbit(index|null)`,
`setFree(orbitIndex, values)`, `setLattice(name, value)`, `setToggle(name, on)`,
`setTheme(theme)` and `state()`. Await `selectCrystal` to let its transition
finish before taking a screenshot. Toggle names are `polyhedra`, `element` and
`orbit` (the last two select the two sides of the same colour control).

Browser review: select every crystal and orbit; drag coordinate and lattice
sliders, then Reset; check hover links, centring copies, keyboard and touch;
check both themes and a parent article theme change; open and close the
Wyckoff drawer to check iframe height. At a 1440px post viewport the figure
should use two columns inside the prose column; at 390px it should stack,
with a 340px scene, a fully expanded panel, and scrolling chip rows. Disable
WebGL to check that all data controls still work. Browser rendering and frame
rate require separate verification; the Node geometry test does not cover them.
