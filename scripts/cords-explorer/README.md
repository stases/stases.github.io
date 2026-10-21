# CORDS figure core and data

This directory supplies the computational core, offline data, and browser code
for the CORDS interactive figures. There is no model inference or build step.
Browser code imports ES modules and loads the data scripts separately.

## Figures

[Molecules](../../cords-molecules.html) and [MultiMNIST](../../cords-mnist.html)
use their respective apps for scene geometry, controls, and decode metrics.
Both import [figure.js](figure.js) for colour ramps, contours, renderer setup,
resource disposal, frame scheduling, decode workers, theme following, and embed
height messages. [figure.css](figure.css) supplies the common shell and controls;
each page loads its figure-specific stylesheet after it.

The automation hooks remain `window.cordsMolecules` and `window.cordsMnist`.
Each exposes `set(partialState)`, whose promise resolves after updates settle,
and `state()` for the current settings and decode measurements. Add `?embed=1`
for embedding and `&theme=light` or `&theme=dark` to fix the theme; otherwise
embedded figures follow the parent theme and send `cords-figure:height` messages.

## Core and data

| File | Purpose |
| --- | --- |
| `cords.js` | Dependency-free, float64 set/field transform and inverse. |
| `make_data.py` | Exports eight molecules and 80 deterministic MultiMNIST scenes from local inputs. |
| `check_data.py` | Checks schemas, molecular geometry/bonds, scene annotations, and decoded PNGs. |
| `data/molecules.js` | Sets `window.CORDS_MOLECULES`; default molecule is ethanol. |
| `data/mnist.js` | Sets `window.CORDS_MNIST`; default scene is seven digits, seed zero. |
| `test/test_cords.mjs` | Frozen acceptance checks against the Python reference. |
| `test/fixtures.json` | Frozen float64 Python parity fixtures. |
| `test/test_edges.mjs` | Additional boundary, coarse-grid, degeneracy, and assignment checks. |

All floating arrays are `Float64Array`. A matrix is
`{rows, cols, data}`, with row-major `data`. Positions are `[N,d]`, object
attributes `[N,C]`, sample coordinates `[S,d]`, and sampled attributes `[S,C]`.
Fields contain density-weighted attributes, not class probabilities or raw sizes.
Decoded objects have arbitrary order; use `matchSets` to compare them.

| Export | Contract |
| --- | --- |
| `mat(rows, cols, data?)` | Allocate zeros or copy array-like data into a new float64 matrix. |
| `makeRng(seed)` | Deterministic mulberry32 `uniform()` and cached Box–Muller `normal()`. |
| `gaussianBasis(coords, centers, sigma, {pixelMass=false}={})` | `[S,N]` continuous unit-integral kernels, or stable finite-grid column softmax. |
| `evaluateFields(positions, features, coords, sigma)` | Return `{density, features}` with physical Gaussian fields. |
| `sampleImportance(positions, sigma, K, rng)` | Draw mixture samples; return `{coords, proposal, weights}`, with `weights=1/(K*proposal)`. |
| `sampleUniformGrid(lo, hi, n)` | Midpoint grid and cell-volume weights; first axis slowest, in 2D or 3D. |
| `encodePixelGrid(positions, features, sigma, width, height, {step=1}={})` | Return `{coords,density,features,weights,gridShape:[h,w]}` on XY pixel/block centres, y-major. |
| `countEstimate(density, weights)` | Sum `weights[s]*density[s]`. |
| `fitCentersEM(coords, sampleWeight, count, sigma, rng, {nInit=5,maxIter=100,tol=1e-6}={})` | Weighted greedy k-means++ starts, fixed-sigma mixture EM, best weighted log likelihood. |
| `peakCenters(coords, density, count, sigma)` | First-index greedy argmax; subtract a unit pixel kernel and exclude within sigma. |
| `refineCenters(coords, density, initial, sigma, {pixelMass=false,iterations=50}={})` | Analytic-Jacobian Levenberg–Marquardt, accepting only loss-decreasing steps. |
| `solveFeatures(coords, weights, features, centers, sigma, {pixelMass=false,ridge=1e-7}={})` | Weighted Gram projection; relative ridge and Cholesky with partial-pivoted LU fallback. |
| `decode({coords,density,features,weights,sigma,pixelMass=false}, {rng,refine=true}={})` | Return `{estimate,count,positions,features,initial,diagnostics:{densityRelError,featureRelError}}`; default RNG seed zero. |
| `matchSets(truth, pred)` | Equal-size Hungarian assignment minimizing total Euclidean distance; `{pairs,rms,max}`. |

Continuous kernels have unit integral over all space. Grid quadrature is an
approximation; importance samples give exact count for fields constructed from
the same proposal, up to roundoff. Pixel kernels have unit **sum** on their
finite grid, including near boundaries. Pixel counting ignores quadrature
weights; exported pixel weights are all one. With `step > 1`, the grid is
`floor(height/step)` by `floor(width/step)` and samples are block centres
`j*step + (step-1)/2`. Incomplete trailing blocks are omitted; kernels are
renormalized on the retained grid.

Decoding rounds mass using `floor(estimate+0.5)`. Zero count returns empty
matrices. Counts exceeding 256 or the number of samples raise errors rather
than being clamped. EM rejects fewer positive-weight samples or distinct
locations than components; pixel initialization rejects an exhausted exclusion
mask. Noisy or poorly sampled fields can produce local minima: this is a
numerical inverse, not a guarantee of recovery at every bandwidth/resolution.

The reference is the read-only checkout at `/home/thadziv/GitHub/CORDS`, primarily
`/home/thadziv/GitHub/CORDS/cords/reconstruction.py` and
`/home/thadziv/GitHub/CORDS/cords/gmm.py`. Deliberate differences are:

- The random stream is mulberry32/Box–Muller, not NumPy/PyTorch. The sampling
  distributions and weighted greedy initialization algorithm are unchanged.
- Refinement uses analytic-Jacobian LM with up to 50 iterations, as required
  for the JavaScript API, instead of PyTorch L-BFGS. Point loss is mean squared
  log-density error with floor `1e-10*max(density)`; pixel loss is mean squared
  density error. The Python pixel loss divides by a constant target-density
  norm, which does not change the minimizer. The pixel Jacobian includes the
  derivative of each finite-grid normalizer.
- Feature projection uses Cholesky with a pivoted-LU fallback instead of
  `torch.linalg.solve`; the weighted Gram matrix and relative ridge are the
  same. Quadrature weights are divided by their maximum before projection.
- This API covers physical point fields and pixel masses with amplitude one.
  The reference's historical count-normalized/unknown-amplitude modes and
  learned model code are outside the figure's scope.
- Block-centred coarse pixel grids extend the reference's unit-step grid.
  Uniform midpoint grids and Hungarian matching are independent helpers.
- For interactive speed and robustness, `decode` on point samples first starts from
  the greedy peak initializer applied to the samples (continuous kernels; the
  reference uses it only on image grids), then from up to three EM fits on an evenly
  strided subset of at most 2048 samples, while the reconstructed density misses the
  field by more than 0.1%, keeping the best fit; the reference has no retry. LM limits
  each step to σ per coordinate (trust region), skips negligible kernels in its
  accumulation, and stops once the fit is exact to rounding. Over the figure's ranges
  (8 molecules, σ 0.10–0.60 Å, M 256–8192, three seeds) decoding recovers every atom
  except two aspirin cases at σ ≥ 0.5 with M = 256; M = 128 is too few samples for
  the larger molecules.

## Regenerate and check

Use the existing environment; nothing downloads data or installs dependencies.
The exporter requires NumPy, PyTorch, Pillow, ASE, and the CORDS checkout. The
data checker needs only Pillow beyond the standard library. The scripts disable
bytecode writes so imported external checkouts remain read-only.

From this worktree:

```bash
cd /home/thadziv/.claudex/worktrees/stases.github.io/cords-core
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/home/thadziv/GitHub/CORDS /home/thadziv/GitHub/crystalite/.venv/bin/python -c 'import cords; print(cords.__file__)'
PYTHONPATH=/home/thadziv/GitHub/CORDS /home/thadziv/GitHub/crystalite/.venv/bin/python scripts/cords-explorer/make_data.py
/home/thadziv/GitHub/crystalite/.venv/bin/python scripts/cords-explorer/check_data.py
/home/thadziv/.hermes/node/bin/node scripts/cords-explorer/test/test_cords.mjs
/home/thadziv/.hermes/node/bin/node scripts/cords-explorer/test/test_edges.mjs
```

The Python import should print `/home/thadziv/GitHub/CORDS/cords/__init__.py`.
Node tests import the adjacent module in this worktree, with no installed package
resolution. Each test command is a short CPU check.

Verify byte-identical regeneration using hashes captured before the second run:

```bash
set -e
before="$(sha256sum scripts/cords-explorer/data/molecules.js scripts/cords-explorer/data/mnist.js)"
PYTHONPATH=/home/thadziv/GitHub/CORDS /home/thadziv/GitHub/crystalite/.venv/bin/python scripts/cords-explorer/make_data.py
after="$(sha256sum scripts/cords-explorer/data/molecules.js scripts/cords-explorer/data/mnist.js)"
test "$before" = "$after"
printf '%s\n' 'Byte-identical regeneration passed' "$after"
```

The exports have no timestamps, use compact JSON, and embed grayscale 8-bit
PNGs with fixed compression settings. Exact PNG bytes are expected to be stable
in the same Python/Pillow/zlib environment; a library upgrade can change them.

## Molecules and scene conventions

| ID | Name | Formula | Atoms | Source |
| --- | --- | --- | ---: | --- |
| acetonitrile | Acetonitrile | C2H3N | 6 | ASE G2 geometry (`CH3CN`) |
| trifluoropropyne | Trifluoropropyne | C3HF3 | 7 | QM9 gdb_826 |
| ethanol | Ethanol | C2H6O | 9 | QM9 gdb_14 |
| acetamide | Acetamide | C2H5NO | 9 | QM9 gdb_19 |
| pyridine | Pyridine | C5H5N | 11 | ASE G2 geometry (`C5H5N`) |
| benzene | Benzene | C6H6 | 12 | ASE G2 geometry (`C6H6`) |
| aspirin | Aspirin | C9H8O4 | 21 | PubChem 3D conformer (CID 2244) |
| caffeine | Caffeine | C8H10N4O2 | 24 | PubChem 3D conformer (CID 2519) |

All hydrogens are retained. Positions are centroid-centred, rotated to principal
axes with decreasing spread along x/y/z, and rounded to four decimals in Å.
The largest absolute atom projection fixes each of the x/y signs, first index
winning ties; z is their cross product to preserve handedness. Rounding can
leave a centroid residual of at most 0.00005 Å per coordinate. Degenerate
principal eigenspaces follow NumPy's eigensolver's basis.

Element indices are H/C/N/O/F = 0/1/2/3/4. ASE bonds use
`distance < 1.2*(r_i+r_j)` with radii 0.31/0.76/0.71/0.66/0.57 Å; these are
display connections of order one, including aromatic ASE molecules, not
inferred chemical bond orders. QM9 keeps its source bonds, mapping types
0/1/2/3 to orders 1/2/3/1.5. The local PubChem V2000 atom/bond blocks are parsed
directly; source bond order 4 becomes 1.5.

Scene `n=1..20`, `seed=0..3` uses CORDS `make_scene(seed=100*n+seed,
num_digits=n, image_size=128, overlap=False)`. Boxes use exclusive upper bounds;
centres are their midpoints. Ten class channels are one-hot; the two remaining
object feature channels are width/128 and height/128. Images are the scene
pixels rounded back to uint8. `train_max=15` is display metadata, not evidence
that these fixtures train or evaluate a model. All 80 scenes reuse the 100
glyphs in the CORDS fixture and are for illustration, not an independent test set.

## Data sources and licences

- **QM9:** Ramakrishnan et al., *Quantum chemistry structures and properties of
  134 kilo molecules*, Scientific Data 1, 140022 (2014),
  [doi:10.1038/sdata.2014.22](https://doi.org/10.1038/sdata.2014.22).
  The dataset is distributed under CC0 1.0; the article has separate CC BY terms.
  Inputs are the three records in
  `/home/thadziv/GitHub/CORDS/cords/data/qm9_examples.json`; no conformers are
  regenerated.
- **ASE G2:** [ASE's G2 collection](https://ase-lib.org/ase/collections.html#g2),
  from the G2/97 geometries described by Curtiss et al., J. Chem. Phys. 106,
  1063 (1997), [doi:10.1063/1.473182](https://doi.org/10.1063/1.473182).
  The installed ASE distribution declares **LGPL-2.1-or-later**. These records
  are derived from its bundled geometry tables; this does not relicense ASE or
  claim an independently verified licence for the original G2 source tables.
- **PubChem:** [aspirin, CID 2244](https://pubchem.ncbi.nlm.nih.gov/compound/2244)
  and [caffeine, CID 2519](https://pubchem.ncbi.nlm.nih.gov/compound/2519).
  Inputs are `/home/thadziv/GitHub/cords-blog-work/specs/data/aspirin.sdf` and
  `/home/thadziv/GitHub/cords-blog-work/specs/data/caffeine.sdf`, the supplied
  PubChem-generated 3D conformers. NCBI-produced data are freely available;
  contributed PubChem records can retain their original providers' terms.
  See [NCBI policies](https://www.ncbi.nlm.nih.gov/home/about/policies/).
- **MNIST:** LeCun et al., *Gradient-Based Learning Applied to Document
  Recognition*, Proceedings of the IEEE 86(11), 2278–2324 (1998),
  [doi:10.1109/5.726791](https://doi.org/10.1109/5.726791).
  The upstream MNIST distribution is commonly identified as **CC BY-SA 3.0**;
  the composed PNGs retain that source provenance. The input is
  `/home/thadziv/GitHub/CORDS/cords/data/mnist_glyphs.npz`: the first ten training
  glyphs of each class, with original source indices. Composition comes from
  `/home/thadziv/GitHub/CORDS/cords/detection.py`.

Licensing was reviewed offline: the local QM9/MNIST fixture documentation names
the publications but includes no licence texts, and the SDF files have no
licence notice. The upstream licensing descriptions above are not fresh
verification of those providers' terms. Preserve the source references when
publishing the derived data; this directory does not supply a new blanket
licence for third-party data.
