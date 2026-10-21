/** @typedef {{rows: number, cols: number, data: Float64Array}} Mat Row-major matrix. */
const TINY = 2.2250738585072014e-308;

/** Allocate a row-major float64 matrix, copying optional array-like data. */
export function mat(rows, cols, data) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 0 || cols < 0)
    throw new Error("matrix dimensions must be nonnegative integers");
  if (data !== undefined && data.length !== rows * cols)
    throw new Error("matrix data length does not match its shape");
  return { rows, cols, data: data === undefined ? new Float64Array(rows * cols) : Float64Array.from(data) };
}

/** Seeded mulberry32 uniforms in [0,1), and Box–Muller normals with a cached spare. */
export function makeRng(seed) {
  let state = seed >>> 0, spare = null;
  function uniform() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function normal() {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const radius = Math.sqrt(-2 * Math.log(1 - uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
  return { uniform, normal };
}

function checkSigma(sigma) {
  if (!(sigma > 0) || !Number.isFinite(sigma)) throw new Error("sigma must be positive and finite");
}

function squaredDistance(a, ai, b, bi, d) {
  let sum = 0;
  for (let k = 0; k < d; k++) { const delta = a[ai + k] - b[bi + k]; sum += delta * delta; }
  return sum;
}

/** Gaussian kernels [samples, objects]; pixelMass normalizes each finite-grid column. */
export function gaussianBasis(coords, centers, sigma, { pixelMass = false } = {}) {
  checkSigma(sigma);
  const S = coords.rows, N = centers.rows, d = coords.cols;
  if (d < 1 || centers.cols !== d) throw new Error("coordinate dimensions must agree");
  const basis = mat(S, N), a = basis.data;
  const inverse = 1 / (2 * sigma * sigma), scale = (2 * Math.PI * sigma * sigma) ** (-d / 2);
  for (let i = 0; i < N; i++) {
    let maximum = -Infinity;
    for (let s = 0; s < S; s++) {
      const logit = -squaredDistance(coords.data, s * d, centers.data, i * d, d) * inverse;
      a[s * N + i] = pixelMass ? logit : scale * Math.exp(logit);
      if (logit > maximum) maximum = logit;
    }
    if (pixelMass) {
      let total = 0;
      for (let s = 0; s < S; s++) total += (a[s * N + i] = Math.exp(a[s * N + i] - maximum));
      for (let s = 0; s < S; s++) a[s * N + i] /= total;
    }
  }
  return basis;
}

function fieldsFromBasis(basis, features) {
  if (features.rows !== basis.cols) throw new Error("one feature row is required per object");
  const S = basis.rows, N = basis.cols, C = features.cols;
  const density = new Float64Array(S), field = mat(S, C);
  for (let s = 0; s < S; s++) for (let i = 0; i < N; i++) {
    const a = basis.data[s * N + i];
    density[s] += a;
    for (let c = 0; c < C; c++) field.data[s * C + c] += a * features.data[i * C + c];
  }
  return { density, features: field };
}

/** Evaluate continuous density and density-weighted feature fields at supplied samples. */
export function evaluateFields(positions, features, coords, sigma) {
  return fieldsFromBasis(gaussianBasis(coords, positions, sigma), features);
}

/** Sample the equal-weight Gaussian mixture and retain q and quadrature weights 1/(Kq). */
export function sampleImportance(positions, sigma, K, rng) {
  checkSigma(sigma);
  if (!Number.isInteger(K) || K < 1) throw new Error("K must be a positive integer");
  // As in encode(), an empty set uses an origin-centred proposal, but zero fields.
  const centers = positions.rows ? positions : mat(1, positions.cols);
  const N = centers.rows, d = centers.cols, coords = mat(K, d);
  for (let s = 0; s < K; s++) {
    const i = Math.floor(rng.uniform() * N);
    for (let k = 0; k < d; k++) coords.data[s * d + k] = centers.data[i * d + k] + sigma * rng.normal();
  }
  const a = gaussianBasis(coords, centers, sigma).data;
  const proposal = new Float64Array(K), weights = new Float64Array(K);
  for (let s = 0; s < K; s++) {
    for (let i = 0; i < N; i++) proposal[s] += a[s * N + i];
    proposal[s] /= N;
    weights[s] = 1 / (K * proposal[s]);
  }
  return { coords, proposal, weights };
}

/** Midpoint quadrature on a 2D/3D box, with the first coordinate varying slowest. */
export function sampleUniformGrid(lo, hi, n) {
  const d = lo.length;
  if (![2, 3].includes(d) || hi.length !== d || !Number.isInteger(n) || n < 1)
    throw new Error("grid requires a 2D/3D box and a positive integer n");
  const step = Float64Array.from(lo, (v, k) => (hi[k] - v) / n);
  if (!step.every((v) => Number.isFinite(v) && v > 0) || !lo.every(Number.isFinite))
    throw new Error("grid bounds must be finite and increasing");
  const coords = mat(n ** d, d), weights = new Float64Array(coords.rows);
  weights.fill(step.reduce((v, x) => v * x, 1));
  for (let s = 0; s < coords.rows; s++) {
    let index = s;
    for (let k = d - 1; k >= 0; k--) {
      coords.data[s * d + k] = lo[k] + (index % n + 0.5) * step[k];
      index = Math.floor(index / n);
    }
  }
  return { coords, weights };
}

/** Encode unit-mass kernels on row-major XY pixel/block centres; weights are one. */
export function encodePixelGrid(positions, features, sigma, width, height, { step = 1 } = {}) {
  if (![width, height, step].every((v) => Number.isInteger(v) && v > 0) || step > Math.min(width, height))
    throw new Error("width, height, and step must give a nonempty integer grid");
  if (positions.cols !== 2) throw new Error("pixel positions must be XY pairs");
  const w = Math.floor(width / step), h = Math.floor(height / step), coords = mat(w * h, 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    coords.data[2 * (y * w + x)] = x * step + (step - 1) / 2;
    coords.data[2 * (y * w + x) + 1] = y * step + (step - 1) / 2;
  }
  const weights = new Float64Array(w * h).fill(1);
  return { coords, ...fieldsFromBasis(gaussianBasis(coords, positions, sigma, { pixelMass: true }), features),
    weights, gridShape: [h, w] };
}

/** Integrate density using the supplied quadrature weights. */
export function countEstimate(density, weights) {
  if (density.length !== weights.length) throw new Error("density and weights must have equal lengths");
  let sum = 0;
  for (let s = 0; s < density.length; s++) sum += density[s] * weights[s];
  return sum;
}

function weightedChoice(weight, total, rng) {
  const target = rng.uniform() * total;
  let cumulative = 0, last = 0;
  for (let s = 0; s < weight.length; s++) {
    cumulative += weight[s];
    if (weight[s] > 0) last = s;
    if (target < cumulative) return s;
  }
  return last; // Roundoff at the end of a cumulative sum.
}

/** Weighted greedy k-means++ followed by fixed-sigma EM; keep the best of nInit starts. */
export function fitCentersEM(coords, sampleWeight, count, sigma, rng, { nInit = 5, maxIter = 100, tol = 1e-6 } = {}) {
  checkSigma(sigma);
  const S = coords.rows, d = coords.cols;
  if (!Number.isInteger(count) || count < 1 || count > S || sampleWeight.length !== S ||
      !Number.isInteger(nInit) || nInit < 1 || !Number.isInteger(maxIter) || maxIter < 1 || !(tol > 0))
    throw new Error("invalid mixture count, weights, or iteration options");
  let total = 0, positive = 0;
  for (const v of sampleWeight) {
    if (!Number.isFinite(v) || v < 0) throw new Error("sample weights must be finite and nonnegative");
    total += v;
    if (v > 0) positive++;
  }
  if (!Number.isFinite(total) || positive < count || !coords.data.every(Number.isFinite))
    throw new Error("need finite coordinates and at least count positive-weight samples");
  const weight = Float64Array.from(sampleWeight, (v) => v / total);
  const trials = 2 + Math.floor(Math.log(count)), inverse = 1 / (2 * sigma * sigma);
  const logScale = -d * Math.log(sigma * Math.sqrt(2 * Math.PI));
  let best = null, bestObjective = -Infinity;
  for (let start = 0; start < nInit; start++) {
    const means = mat(count, d), distance = new Float64Array(S), probabilities = new Float64Array(S);
    const first = weightedChoice(weight, 1, rng);
    means.data.set(coords.data.subarray(first * d, (first + 1) * d));
    for (let s = 0; s < S; s++) distance[s] = squaredDistance(coords.data, s * d, means.data, 0, d);
    for (let i = 1; i < count; i++) {
      let potential = 0;
      for (let s = 0; s < S; s++) potential += (probabilities[s] = distance[s] * weight[s]);
      if (potential <= TINY) throw new Error("not enough distinct sample locations for this mixture");
      let chosen = 0, bestCost = Infinity;
      for (let trial = 0; trial < trials; trial++) {
        const candidate = weightedChoice(probabilities, potential, rng);
        let cost = 0;
        for (let s = 0; s < S; s++)
          cost += weight[s] * Math.min(distance[s], squaredDistance(coords.data, s * d, coords.data, candidate * d, d));
        if (cost < bestCost) { bestCost = cost; chosen = candidate; }
      }
      means.data.set(coords.data.subarray(chosen * d, (chosen + 1) * d), i * d);
      for (let s = 0; s < S; s++)
        distance[s] = Math.min(distance[s], squaredDistance(coords.data, s * d, means.data, i * d, d));
    }
    const mixture = new Float64Array(count).fill(1 / count), logits = new Float64Array(count);
    const mass = new Float64Array(count), sums = new Float64Array(count * d), logMix = new Float64Array(count);
    let previous = -Infinity, objective = -Infinity;
    for (let iteration = 0; iteration < maxIter; iteration++) {
      mass.fill(0); sums.fill(0); objective = 0;
      for (let i = 0; i < count; i++) logMix[i] = Math.log(Math.max(mixture[i], TINY)) + logScale;
      for (let s = 0; s < S; s++) {
        if (weight[s] === 0) continue;
        let maximum = -Infinity, sum = 0;
        for (let i = 0; i < count; i++) {
          logits[i] = logMix[i] - squaredDistance(coords.data, s * d, means.data, i * d, d) * inverse;
          if (logits[i] > maximum) maximum = logits[i];
        }
        // Components more than e^-40 below the largest contribute nothing in float64.
        for (let i = 0; i < count; i++) if (logits[i] > maximum - 40) sum += Math.exp(logits[i] - maximum);
        const logSum = maximum + Math.log(sum);
        objective += weight[s] * logSum;
        for (let i = 0; i < count; i++) {
          if (logits[i] <= maximum - 40) continue;
          const r = Math.exp(logits[i] - logSum) * weight[s];
          mass[i] += r;
          for (let k = 0; k < d; k++) sums[i * d + k] += r * coords.data[s * d + k];
        }
      }
      let massSum = 0;
      for (let i = 0; i < count; i++) massSum += (mass[i] = Math.max(mass[i], TINY));
      for (let i = 0; i < count; i++) {
        mixture[i] = mass[i] / massSum;
        for (let k = 0; k < d; k++) means.data[i * d + k] = sums[i * d + k] / mass[i];
      }
      if (Math.abs(objective - previous) < tol) break;
      previous = objective;
    }
    if (best === null || objective > bestObjective) { best = means; bestObjective = objective; }
  }
  return best;
}

/** Greedy first-argmax peaks, subtracting unit kernels and excluding distances <= sigma.
 * Pixel-mass kernels by default (the reference's image initializer); continuous kernels for point samples. */
export function peakCenters(coords, density, count, sigma, { pixelMass = true } = {}) {
  checkSigma(sigma);
  const S = coords.rows, d = coords.cols, centers = mat(count, d);
  const scores = Float64Array.from(density), excluded = new Uint8Array(S);
  if (density.length !== S) throw new Error("one density value is required per sample");
  for (let i = 0; i < count; i++) {
    let index = 0;
    for (let s = 1; s < S; s++) if (scores[s] > scores[index]) index = s;
    if (!Number.isFinite(scores[index])) throw new Error("too many centers to initialize at this image bandwidth");
    const center = mat(1, d, coords.data.subarray(index * d, (index + 1) * d));
    centers.data.set(center.data, i * d);
    const kernel = gaussianBasis(coords, center, sigma, { pixelMass }).data;
    for (let s = 0; s < S; s++) {
      scores[s] -= kernel[s];
      if (squaredDistance(coords.data, s * d, center.data, 0, d) <= sigma * sigma) excluded[s] = 1;
      if (excluded[s]) scores[s] = -Infinity;
    }
  }
  return centers;
}

// Solve symmetric systems by Cholesky, falling back to partial-pivoted LU.
// Inputs are never modified. Multiple RHS columns share the factorization.
function solveSystem(a, rhs, n, columns) {
  const l = new Float64Array(n * n);
  let positive = true;
  for (let i = 0; i < n && positive; i++) for (let j = 0; j <= i; j++) {
    let value = a[i * n + j];
    for (let k = 0; k < j; k++) value -= l[i * n + k] * l[j * n + k];
    if (i === j) {
      if (!(value > 0) || !Number.isFinite(value)) { positive = false; break; }
      l[i * n + j] = Math.sqrt(value);
    } else l[i * n + j] = value / l[j * n + j];
  }
  const x = Float64Array.from(rhs);
  if (positive) {
    for (let i = 0; i < n; i++) for (let c = 0; c < columns; c++) {
      for (let j = 0; j < i; j++) x[i * columns + c] -= l[i * n + j] * x[j * columns + c];
      x[i * columns + c] /= l[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) for (let c = 0; c < columns; c++) {
      for (let j = i + 1; j < n; j++) x[i * columns + c] -= l[j * n + i] * x[j * columns + c];
      x[i * columns + c] /= l[i * n + i];
    }
  } else {
    const u = Float64Array.from(a);
    for (let k = 0; k < n; k++) {
      let pivot = k;
      for (let i = k + 1; i < n; i++) if (Math.abs(u[i * n + k]) > Math.abs(u[pivot * n + k])) pivot = i;
      if (u[pivot * n + k] === 0 || !Number.isFinite(u[pivot * n + k])) throw new Error("singular linear system");
      for (let j = k; j < n; j++) [u[k * n + j], u[pivot * n + j]] = [u[pivot * n + j], u[k * n + j]];
      for (let c = 0; c < columns; c++) [x[k * columns + c], x[pivot * columns + c]] = [x[pivot * columns + c], x[k * columns + c]];
      for (let i = k + 1; i < n; i++) {
        const factor = u[i * n + k] / u[k * n + k];
        for (let j = k + 1; j < n; j++) u[i * n + j] -= factor * u[k * n + j];
        for (let c = 0; c < columns; c++) x[i * columns + c] -= factor * x[k * columns + c];
      }
    }
    for (let i = n - 1; i >= 0; i--) for (let c = 0; c < columns; c++) {
      for (let j = i + 1; j < n; j++) x[i * columns + c] -= u[i * n + j] * x[j * columns + c];
      x[i * columns + c] /= u[i * n + i];
    }
  }
  if (!x.every(Number.isFinite)) throw new Error("nonfinite linear solution");
  return x;
}

/** Fit unit-amplitude centres with analytic-Jacobian LM (log-density or pixel-mass MSE). */
export function refineCenters(coords, density, initial, sigma, { pixelMass = false, iterations = 50 } = {}) {
  checkSigma(sigma);
  const S = coords.rows, N = initial.rows, d = coords.cols, P = N * d;
  if (density.length !== S || initial.cols !== d || !Number.isInteger(iterations) || iterations < 0)
    throw new Error("invalid refinement shape or iteration count");
  let positions = mat(N, d, initial.data), maxDensity = 0;
  for (const v of density) maxDensity = Math.max(maxDensity, v);
  if (N === 0 || maxDensity === 0) return positions;
  const floor = maxDensity * 1e-10, inverse = 1 / (sigma * sigma);
  function evaluate(centers) {
    const a = gaussianBasis(coords, centers, sigma, { pixelMass }).data;
    const prediction = new Float64Array(S), residual = new Float64Array(S);
    let loss = 0;
    for (let s = 0; s < S; s++) {
      for (let i = 0; i < N; i++) prediction[s] += a[s * N + i];
      residual[s] = pixelMass ? prediction[s] - density[s]
        : Math.log(Math.max(prediction[s], floor)) - Math.log(Math.max(density[s], floor));
      loss += residual[s] * residual[s];
    }
    return { a, prediction, residual, loss: loss / S };
  }
  let current = evaluate(positions), damping = 1e-3;
  const active = new Int32Array(P), jacobian = new Float64Array(P);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const meanOffset = new Float64Array(P);
    if (pixelMass) for (let s = 0; s < S; s++) for (let i = 0; i < N; i++) for (let k = 0; k < d; k++)
      meanOffset[i * d + k] += current.a[s * N + i] * (coords.data[s * d + k] - positions.data[i * d + k]);
    const gram = new Float64Array(P * P), gradient = new Float64Array(P);
    for (let s = 0; s < S; s++) {
      // The derivative of a clamped prediction is zero below the floor.
      const scale = pixelMass ? inverse : current.prediction[s] > floor ? inverse / current.prediction[s] : 0;
      if (scale === 0) continue;
      // Each sample's Jacobian row is sparse: only kernels with a non-negligible share of the
      // prediction (log loss) or of their own mass (pixel mass) move it. Skipping the rest
      // keeps the Gauss-Newton accumulation near O(S) instead of O(S P^2).
      let m = 0;
      for (let i = 0; i < N; i++) {
        const share = pixelMass ? current.a[s * N + i] : current.a[s * N + i] / current.prediction[s];
        if (share < 1e-13) continue;
        for (let k = 0; k < d; k++) {
          const p = i * d + k;
          // The offset expectation differentiates the finite-grid normalizer.
          jacobian[p] = current.a[s * N + i] * scale *
            (coords.data[s * d + k] - positions.data[p] - meanOffset[p]);
          active[m++] = p;
        }
      }
      for (let x = 0; x < m; x++) {
        const p = active[x], j = jacobian[p];
        gradient[p] += j * current.residual[s];
        for (let y = 0; y < m; y++) {
          const q = active[y];
          if (q <= p) gram[p * P + q] += j * jacobian[q];
        }
      }
    }
    let largestDiagonal = 0;
    for (let p = 0; p < P; p++) {
      gradient[p] = -gradient[p] / S;
      for (let q = 0; q <= p; q++) gram[q * P + p] = (gram[p * P + q] /= S);
      largestDiagonal = Math.max(largestDiagonal, gram[p * P + p]);
    }
    if (largestDiagonal === 0 || current.loss === 0) break;
    let accepted = false, improvement = 0, step = 0;
    for (let trial = 0; trial < 12; trial++) {
      const system = Float64Array.from(gram);
      for (let p = 0; p < P; p++) system[p * P + p] += damping * Math.max(gram[p * P + p], largestDiagonal * 1e-12);
      const delta = solveSystem(system, gradient, P, 1), candidate = mat(N, d, positions.data);
      // Trust region: no centre moves more than sigma per step, so a centre far from the
      // samples cannot run away along a flat direction of the loss.
      let largest = 0;
      for (let p = 0; p < P; p++) largest = Math.max(largest, Math.abs(delta[p]));
      const shrink = largest > sigma ? sigma / largest : 1;
      for (let p = 0; p < P; p++) candidate.data[p] += shrink * delta[p];
      const next = evaluate(candidate);
      if (next.loss < current.loss) {
        improvement = (current.loss - next.loss) / Math.max(current.loss, TINY);
        step = shrink * largest;
        positions = candidate; current = next; damping = Math.max(damping / 3, 1e-12); accepted = true;
        break;
      }
      damping *= 10;
    }
    // Stop once the fit is exact to rounding or the centres no longer move.
    if (!accepted || improvement < 1e-10 || current.loss < 1e-28 || step < 1e-12 * sigma) break;
  }
  return positions;
}

/** Weighted feature projection with relative ridge regularization and a shared matrix solve. */
export function solveFeatures(coords, weights, features, centers, sigma, { pixelMass = false, ridge = 1e-7 } = {}) {
  const S = coords.rows, N = centers.rows, C = features.cols;
  if (weights.length !== S || features.rows !== S || !Number.isFinite(ridge) || ridge < 0)
    throw new Error("invalid projection shape or ridge");
  if (!N) return mat(0, C);
  let maxWeight = 0;
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new Error("projection weights must be finite and nonnegative");
    maxWeight = Math.max(maxWeight, w);
  }
  if (!maxWeight) throw new Error("projection weights must have positive total");
  const a = gaussianBasis(coords, centers, sigma, { pixelMass }).data;
  const gram = new Float64Array(N * N), rhs = new Float64Array(N * C);
  for (let s = 0; s < S; s++) for (let i = 0; i < N; i++) {
    const weighted = a[s * N + i] * (weights[s] / maxWeight);
    for (let j = 0; j <= i; j++) gram[i * N + j] += weighted * a[s * N + j];
    for (let c = 0; c < C; c++) rhs[i * C + c] += weighted * features.data[s * C + c];
  }
  let trace = 0;
  for (let i = 0; i < N; i++) trace += gram[i * N + i];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < i; j++) gram[j * N + i] = gram[i * N + j];
    gram[i * N + i] += ridge * trace / N;
  }
  return mat(N, C, solveSystem(gram, rhs, N, C));
}

function relativeError(predicted, actual) {
  let error = 0, norm = 0;
  for (let i = 0; i < actual.length; i++) { error += (predicted[i] - actual[i]) ** 2; norm += actual[i] ** 2; }
  return Math.sqrt(error) / Math.max(Math.sqrt(norm), TINY);
}

/** Infer count, initialize/refine centres, solve attributes, and report sampled relative L2 errors. */
export function decode({ coords, density, features, weights, sigma, pixelMass = false }, { rng = makeRng(0), refine = true } = {}) {
  checkSigma(sigma);
  const S = coords.rows;
  if (!S || density.length !== S || features.rows !== S || weights.length !== S ||
      !coords.data.every(Number.isFinite) || !features.data.every(Number.isFinite) ||
      !density.every((v) => Number.isFinite(v) && v >= 0) || !weights.every((v) => Number.isFinite(v) && v > 0))
    throw new Error("decode requires finite fields, nonnegative density, and positive sample weights");
  const estimate = pixelMass ? density.reduce((a, b) => a + b, 0) : countEstimate(density, weights);
  if (!Number.isFinite(estimate)) throw new Error("nonfinite count estimate");
  const count = Math.floor(estimate + 0.5);
  if (count > 256) throw new Error(`inferred count ${count} exceeds max_count=256`);
  if (count > S) throw new Error("inferred count exceeds the number of field samples");
  if (count === 0) return { estimate, count, positions: mat(0, coords.cols), features: mat(0, features.cols),
    initial: mat(0, coords.cols), diagnostics: { densityRelError: density.some((v) => v !== 0) ? 1 : 0,
      featureRelError: features.data.some((v) => v !== 0) ? 1 : 0 } };
  // Point samples: a poor start can leave refinement in a local optimum (two centres sharing one
  // atom). Unlike the Python reference, the first start is the greedy peak initializer applied to
  // the samples, then fresh EM starts follow while the reconstructed density misses the field;
  // the best fit is kept.
  // EM only seeds the refinement, so it runs on an evenly strided subset of at most 2048 samples;
  // refinement and the feature solve use every sample.
  const stride = Math.max(1, S / 2048), subset = mat(Math.min(S, 2048), coords.cols);
  const subsetWeight = new Float64Array(subset.rows);
  if (!pixelMass) for (let j = 0; j < subset.rows; j++) {
    const s = Math.floor(j * stride);
    subset.data.set(coords.data.subarray(s * coords.cols, (s + 1) * coords.cols), j * coords.cols);
    subsetWeight[j] = density[s] * weights[s];
  }
  let best = null;
  for (let attempt = 0; attempt < (pixelMass || !refine ? 1 : 4); attempt++) {
    let initial = null;
    if (pixelMass) initial = peakCenters(coords, density, count, sigma);
    else if (attempt === 0) {
      try { initial = peakCenters(coords, density, count, sigma, { pixelMass: false }); }
      catch { initial = null; } // Too few separated samples for greedy peaks: use EM.
    }
    if (initial === null) initial = fitCentersEM(subset, subsetWeight, count, sigma, rng);
    const positions = refine ? refineCenters(coords, density, initial, sigma, { pixelMass }) : mat(count, coords.cols, initial.data);
    const error = relativeError(fieldsFromBasis(gaussianBasis(coords, positions, sigma, { pixelMass }), mat(count, 0)).density, density);
    if (best === null || error < best.error) best = { initial, positions, error };
    if (error < 1e-3) break;
  }
  const { initial, positions } = best;
  const recovered = solveFeatures(coords, weights, features, positions, sigma, { pixelMass });
  const predicted = fieldsFromBasis(gaussianBasis(coords, positions, sigma, { pixelMass }), recovered);
  return { estimate, count, positions, features: recovered, initial, diagnostics: {
    densityRelError: relativeError(predicted.density, density), featureRelError: relativeError(predicted.features.data, features.data) } };
}

/** Hungarian minimum-total-Euclidean-distance assignment of equal-size sets, with RMS/max errors. */
export function matchSets(truth, pred) {
  if (truth.rows !== pred.rows || truth.cols !== pred.cols ||
      !truth.data.every(Number.isFinite) || !pred.data.every(Number.isFinite))
    throw new Error("matching requires finite point sets of equal shape");
  const N = truth.rows, d = truth.cols, cost = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
    cost[i * N + j] = Math.sqrt(squaredDistance(truth.data, i * d, pred.data, j * d, d));
  const u = new Float64Array(N + 1), v = new Float64Array(N + 1);
  const p = new Int32Array(N + 1), way = new Int32Array(N + 1);
  for (let i = 1; i <= N; i++) {
    p[0] = i;
    let j0 = 0;
    const min = new Float64Array(N + 1).fill(Infinity), used = new Uint8Array(N + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= N; j++) if (!used[j]) {
        const current = cost[(i0 - 1) * N + j - 1] - u[i0] - v[j];
        if (current < min[j]) { min[j] = current; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= N; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const pairs = Array(N);
  let sum = 0, max = 0;
  for (let j = 1; j <= N; j++) {
    const i = p[j] - 1, distance = cost[i * N + j - 1];
    pairs[i] = [i, j - 1]; sum += distance * distance; max = Math.max(max, distance);
  }
  return { pairs, rms: N ? Math.sqrt(sum / N) : 0, max };
}
