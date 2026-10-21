// Additional numerical checks beyond the frozen Python parity fixtures.
import assert from "node:assert/strict";
import * as C from "../cords.js";

const close = (a, b, tol = 1e-10) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const sum = (values) => values.reduce((a, b) => a + b, 0);

{
  const input = [1, 2], m = C.mat(1, 2, input);
  input[0] = 9;
  assert.equal(m.data[0], 1);
  const grid = C.sampleUniformGrid([0, 0], [2, 4], 2);
  assert.deepEqual(Array.from(grid.coords.data), [0.5, 1, 0.5, 3, 1.5, 1, 1.5, 3]);
  assert.deepEqual(Array.from(grid.weights), [2, 2, 2, 2]);
  const imp = C.sampleImportance(C.mat(0, 2), 0.7, 16, C.makeRng(4));
  const empty = C.evaluateFields(C.mat(0, 2), C.mat(0, 3), imp.coords, 0.7);
  assert.equal(C.countEstimate(empty.density, imp.weights), 0);
  assert.ok(imp.weights.every(Number.isFinite));
  console.log("PASS matrix copy, midpoint order, empty-set proposal");
}

{
  // All ordinary exponentials underflow here; finite-grid softmax must still sum to one.
  const basis = C.gaussianBasis(C.mat(3, 2, [0, 0, 1, 0, 2, 0]), C.mat(1, 2, [1000, 1000]), 0.1, { pixelMass: true });
  close(sum(basis.data), 1);
  assert.equal(basis.data[2], 1);
  for (const step of [4, 8]) {
    const encoded = C.encodePixelGrid(C.mat(1, 2, [0, 127]), C.mat(1, 1, [1]), 2, 128, 128, { step });
    assert.deepEqual(encoded.gridShape, [128 / step, 128 / step]);
    close(encoded.coords.data[0], (step - 1) / 2);
    close(sum(encoded.density), 1);
  }
  const partial = C.encodePixelGrid(C.mat(1, 2, [3, 4]), C.mat(1, 1, [1]), 1, 7, 5, { step: 2 });
  assert.deepEqual(partial.gridShape, [2, 3]);
  assert.deepEqual(Array.from(partial.coords.data.slice(-2)), [4.5, 2.5]);
  console.log("PASS stable softmax, 32/16 grids, partial blocks");
}

{
  // Near-boundary kernels require the derivative of the finite-grid normalizer.
  const positions = C.mat(2, 2, [0.15, 0.25, 5.5, 6.7]), features = C.mat(2, 2, [1, 0.3, -0.2, 1]);
  const sigma = 1.3, enc = C.encodePixelGrid(positions, features, sigma, 9, 8);
  const initial = C.mat(2, 2, [0.5, 0.6, 5.1, 6.3]);
  const before = Array.from(initial.data);
  const fit = C.refineCenters(enc.coords, enc.density, initial, sigma, { pixelMass: true });
  assert.ok(C.matchSets(positions, fit).rms < 1e-7);
  assert.deepEqual(Array.from(initial.data), before);
  const solved = C.solveFeatures(enc.coords, enc.weights, enc.features, positions, sigma, { pixelMass: true });
  const scaled = C.solveFeatures(enc.coords, enc.weights.map((w) => w * 1e150), enc.features, positions, sigma, { pixelMass: true });
  solved.data.forEach((value, i) => close(value, scaled.data[i], 1e-12));
  const peaks = C.peakCenters(enc.coords, enc.density, 2, sigma);
  const noRefine = C.decode({ ...enc, sigma, pixelMass: true }, { refine: false });
  assert.deepEqual(noRefine.positions, peaks);
  const nonunit = C.decode({ ...enc, weights: enc.weights.map((w) => w * 3), sigma, pixelMass: true });
  close(nonunit.estimate, 2);
  assert.ok(C.matchSets(positions, nonunit.positions).rms < 1e-7);
  console.log("PASS boundary refinement, immutable initial, weight scaling, pixel counting, refine=false");
}

{
  const positions = C.mat(2, 2, [-0.5, 0.2, 0.6, -0.1]), feat = C.mat(2, 1, [1, 2]), sigma = 0.5;
  const grid = C.sampleUniformGrid([-4, -4], [4, 4], 20), field = C.evaluateFields(positions, feat, grid.coords, sigma);
  const initial = C.mat(2, 2, [-0.3, 0.4, 0.8, 0.1]);
  const fit = C.refineCenters(grid.coords, field.density, initial, sigma);
  assert.ok(C.matchSets(positions, fit).rms < 1e-7);
  const base = { coords: C.mat(2, 2, [0, 0, 1, 1]), features: C.mat(2, 1), weights: new Float64Array([1, 1]), sigma: 1 };
  assert.throws(() => C.decode({ ...base, density: new Float64Array([200, 200]) }), /256/);
  assert.throws(() => C.decode({ ...base, density: new Float64Array([2, 2]) }), /number of field samples/);
  assert.throws(() => C.decode({ ...base, density: new Float64Array([NaN, 0]) }), /finite/);
  assert.throws(() => C.fitCentersEM(base.coords, [1, 0], 2, 1, C.makeRng(0)), /positive-weight/);
  assert.throws(() => C.fitCentersEM(C.mat(2, 2), [1, 1], 2, 1, C.makeRng(0)), /distinct/);
  assert.throws(() => C.peakCenters(C.mat(2, 2), [1, 1], 2, 1), /too many centers/);
  console.log("PASS overlapping point refinement with clamped tails and explicit resource/degeneracy errors");
}

{
  // Exhaustive small assignments verify Euclidean (not squared-Euclidean) costs.
  const permutations = (items) => items.length === 0 ? [[]]
    : items.flatMap((x, i) => permutations(items.filter((_, j) => j !== i)).map((p) => [x, ...p]));
  const rng = C.makeRng(34), choices = permutations([0, 1, 2, 3, 4]);
  for (let trial = 0; trial < 12; trial++) {
    const a = C.mat(5, 2, Array.from({ length: 10 }, () => rng.normal()));
    const b = C.mat(5, 2, Array.from({ length: 10 }, () => rng.normal()));
    const distance = (i, j) => Math.hypot(a.data[2 * i] - b.data[2 * j], a.data[2 * i + 1] - b.data[2 * j + 1]);
    const best = Math.min(...choices.map((p) => sum(p.map((j, i) => distance(i, j)))));
    const match = C.matchSets(a, b);
    close(sum(match.pairs.map(([i, j]) => distance(i, j))), best);
    close(match.rms, Math.sqrt(sum(match.pairs.map(([i, j]) => distance(i, j) ** 2)) / 5));
  }
  assert.deepEqual(C.matchSets(C.mat(0, 2), C.mat(0, 2)), { pairs: [], rms: 0, max: 0 });
  console.log("PASS Hungarian assignments against exhaustive search and empty sets");
}

console.log("ALL PASSED");
