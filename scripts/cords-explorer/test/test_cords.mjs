// Frozen acceptance test for scripts/cords-explorer/cords.js against the Python `cords` package.
// Run from the site root: node scripts/cords-explorer/test/test_cords.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as C from "../cords.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(here, "fixtures.json"), "utf8"));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
}
function maxAbs(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
function maxRel(a, b) {
  let scale = 0;
  for (const v of b) scale = Math.max(scale, Math.abs(v));
  return maxAbs(a, b) / Math.max(scale, 1e-300);
}
const M = (rows, cols, data) => C.mat(rows, cols, data);
function argmaxRows(m, cols = m.cols) {
  const out = [];
  for (let r = 0; r < m.rows; r++) {
    let best = 0;
    for (let c = 1; c < cols; c++) if (m.data[r * m.cols + c] > m.data[r * m.cols + best]) best = c;
    out.push(best);
  }
  return out;
}
function typesAgree(truthFeat, predFeat, pairs, cols) {
  const t = argmaxRows(truthFeat, cols), p = argmaxRows(predFeat, cols);
  return pairs.every(([i, j]) => t[i] === p[j]);
}

// ---------- mat and RNG ----------
{
  const m = C.mat(2, 3);
  check("mat zero-initialised Float64Array", m.rows === 2 && m.cols === 3 && m.data instanceof Float64Array && m.data.length === 6 && m.data.every((v) => v === 0));
  const a = C.makeRng(5), b = C.makeRng(5), c = C.makeRng(6);
  const sa = Array.from({ length: 5 }, () => a.uniform()), sb = Array.from({ length: 5 }, () => b.uniform());
  check("rng deterministic per seed", maxAbs(sa, sb) === 0 && sa[0] !== c.uniform());
  const r = C.makeRng(1);
  let lo = 1, hi = 0, s = 0, s2 = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) { const u = r.uniform(); lo = Math.min(lo, u); hi = Math.max(hi, u); }
  for (let i = 0; i < n; i++) { const z = r.normal(); s += z; s2 += z * z; }
  check("uniform in [0,1)", lo >= 0 && hi < 1);
  check("normal moments", Math.abs(s / n) < 0.02 && Math.abs(s2 / n - 1) < 0.02, `mean ${(s / n).toFixed(4)} var ${(s2 / n).toFixed(4)}`);
}

// ---------- molecules: parity with Python ----------
for (const m of FX.molecules) {
  const pos = M(m.N, 3, m.positions), feat = M(m.N, 5, m.features);
  const probe = M(m.probe.length / 3, 3, m.probe);
  const basis = C.gaussianBasis(probe, pos, m.sigma);
  check(`${m.name}: gaussianBasis parity`, basis.rows === probe.rows && basis.cols === m.N && maxRel(basis.data, m.probe_basis) < 1e-10);
  const ev = C.evaluateFields(pos, feat, probe, m.sigma);
  check(`${m.name}: evaluateFields parity`, maxRel(ev.density, m.probe_density) < 1e-10 && maxRel(ev.features.data, m.probe_features) < 1e-10);
  const S = m.samples;
  const coords = M(S.K, 3, S.coords), fields = M(S.K, 5, S.features);
  const w = Float64Array.from(S.weights), rho = Float64Array.from(S.density);
  check(`${m.name}: countEstimate parity`, Math.abs(C.countEstimate(rho, w) - m.count_estimate) < 1e-9);
  const solved = C.solveFeatures(coords, w, fields, pos, m.sigma);
  check(`${m.name}: solveFeatures parity`, solved.rows === m.N && solved.cols === 5 && maxAbs(solved.data, m.solve_at_truth) < 1e-6, `max abs ${maxAbs(solved.data, m.solve_at_truth).toExponential(2)}`);
  const dec = C.decode({ coords, density: rho, features: fields, weights: w, sigma: m.sigma, pixelMass: false }, { rng: C.makeRng(3) });
  const match = dec.count === m.N ? C.matchSets(pos, dec.positions) : null;
  check(`${m.name}: decode Python samples`, dec.count === m.N && Math.abs(dec.estimate - m.N) < 1e-9 && match.rms < 1e-3 && typesAgree(feat, dec.features, match.pairs, 5),
    `count ${dec.count} rms ${match ? match.rms.toExponential(2) : "-"}`);

  // ---------- own importance sampling ----------
  const imp = C.sampleImportance(pos, m.sigma, 2048, C.makeRng(7));
  const basisAt = C.gaussianBasis(imp.coords, pos, m.sigma);
  const q = new Float64Array(imp.coords.rows);
  for (let s2 = 0; s2 < q.length; s2++) { let acc = 0; for (let i = 0; i < m.N; i++) acc += basisAt.data[s2 * m.N + i]; q[s2] = acc / m.N; }
  check(`${m.name}: importance proposal and weights`, imp.coords.rows === 2048 && maxRel(imp.proposal, q) < 1e-12 && maxRel(imp.weights, Array.from(q, (v) => 1 / (2048 * v))) < 1e-12);
  const evImp = C.evaluateFields(pos, feat, imp.coords, m.sigma);
  check(`${m.name}: importance count exact`, Math.abs(C.countEstimate(evImp.density, imp.weights) - m.N) < 1e-9);
  const t0 = Date.now();
  const decImp = C.decode({ coords: imp.coords, density: evImp.density, features: evImp.features, weights: imp.weights, sigma: m.sigma }, { rng: C.makeRng(9) });
  const ms = Date.now() - t0;
  const mi = decImp.count === m.N ? C.matchSets(pos, decImp.positions) : null;
  check(`${m.name}: decode own importance samples`, decImp.count === m.N && mi.rms < 1e-3 && typesAgree(feat, decImp.features, mi.pairs, 5) && decImp.initial.rows === m.N,
    `rms ${mi ? mi.rms.toExponential(2) : "-"} ${ms} ms`);
  check(`${m.name}: decode diagnostics`, decImp.diagnostics.densityRelError < 1e-3 && decImp.diagnostics.featureRelError < 1e-3);

  // ---------- uniform grid ----------
  const lo = [0, 1, 2].map((k) => Math.min(...Array.from({ length: m.N }, (_, i) => m.positions[3 * i + k])) - 4 * m.sigma);
  const hi = [0, 1, 2].map((k) => Math.max(...Array.from({ length: m.N }, (_, i) => m.positions[3 * i + k])) + 4 * m.sigma);
  const nAxis = Math.ceil(Math.max(...hi.map((h, k) => (h - lo[k]) / m.sigma)));
  const grid = C.sampleUniformGrid(lo, hi, nAxis);
  const vol = hi.reduce((p, h, k) => p * (h - lo[k]), 1);
  let wsum = 0; for (const v of grid.weights) wsum += v;
  check(`${m.name}: uniform grid shape and weights`, grid.coords.rows === nAxis ** 3 && grid.coords.cols === 3 && Math.abs(wsum - vol) < 1e-9 * vol);
  const evGrid = C.evaluateFields(pos, feat, grid.coords, m.sigma);
  const est = C.countEstimate(evGrid.density, grid.weights);
  check(`${m.name}: uniform count estimate`, Math.abs(est - m.N) < 0.05, `N^ ${est.toFixed(4)}`);
  const decGrid = C.decode({ coords: grid.coords, density: evGrid.density, features: evGrid.features, weights: grid.weights, sigma: m.sigma }, { rng: C.makeRng(4) });
  const mg = decGrid.count === m.N ? C.matchSets(pos, decGrid.positions) : null;
  check(`${m.name}: decode uniform grid`, decGrid.count === m.N && mg.rms < 1e-3 && typesAgree(feat, decGrid.features, mg.pairs, 5), `rms ${mg ? mg.rms.toExponential(2) : "-"}`);
}

// ---------- MultiMNIST pixel-mass grids: parity with Python ----------
for (const sc of FX.scenes) {
  const pos = M(sc.n, 2, sc.positions), feat = M(sc.n, 12, sc.features);
  const enc = C.encodePixelGrid(pos, feat, sc.sigma, sc.width, sc.height);
  let dsum = 0; for (const v of enc.density) dsum += v;
  check(`scene n=${sc.n}: grid shape`, enc.coords.rows === 128 * 128 && enc.gridShape[0] === 128 && enc.gridShape[1] === 128 && enc.coords.data[0] === 0 && enc.coords.data[1] === 0 && enc.coords.data[2] === 1 && enc.coords.data[3] === 0);
  check(`scene n=${sc.n}: density mass`, Math.abs(dsum - sc.density_sum) < 1e-9);
  const pd = sc.pixel_index.map((i) => enc.density[i]);
  const pf = sc.pixel_index.flatMap((i) => Array.from(enc.features.data.subarray(12 * i, 12 * i + 12)));
  check(`scene n=${sc.n}: pixel parity`, maxAbs(pd, sc.pixel_density) < 1e-12 && maxAbs(pf, sc.pixel_features) < 1e-12);
  const peaks = C.peakCenters(enc.coords, enc.density, sc.n, sc.sigma);
  check(`scene n=${sc.n}: peakCenters parity`, peaks.rows === sc.n && maxAbs(peaks.data, sc.peak_centers) < 1e-9);
  const solved = C.solveFeatures(enc.coords, enc.weights, enc.features, pos, sc.sigma, { pixelMass: true });
  check(`scene n=${sc.n}: solveFeatures parity`, maxAbs(solved.data, sc.solve_at_truth) < 1e-6, `max abs ${maxAbs(solved.data, sc.solve_at_truth).toExponential(2)}`);
  const dec = C.decode({ ...enc, sigma: sc.sigma, pixelMass: true }, { rng: C.makeRng(2) });
  const mt = dec.count === sc.n ? C.matchSets(pos, dec.positions) : null;
  const sizesOk = mt && mt.pairs.every(([i, j]) => Math.abs(feat.data[12 * i + 10] - dec.features.data[12 * j + 10]) < 1e-3 && Math.abs(feat.data[12 * i + 11] - dec.features.data[12 * j + 11]) < 1e-3);
  check(`scene n=${sc.n}: decode`, dec.count === sc.n && mt.rms < 0.05 && typesAgree(feat, dec.features, mt.pairs, 10) && sizesOk, `rms ${mt ? mt.rms.toExponential(2) : "-"} px`);
  const coarse = C.encodePixelGrid(pos, feat, sc.sigma, sc.width, sc.height, { step: 2 });
  let csum = 0; for (const v of coarse.density) csum += v;
  const dc = C.decode({ ...coarse, sigma: sc.sigma, pixelMass: true }, { rng: C.makeRng(2) });
  const mc = dc.count === sc.n ? C.matchSets(pos, dc.positions) : null;
  check(`scene n=${sc.n}: coarse 64x64 grid`, coarse.coords.rows === 64 * 64 && coarse.gridShape[0] === 64 && Math.abs(csum - sc.n) < 1e-9 && dc.count === sc.n && mc.rms < 0.5 && typesAgree(feat, dc.features, mc.pairs, 10), `rms ${mc ? mc.rms.toFixed(3) : "-"} px`);
}

// ---------- helpers ----------
{
  const a = M(3, 2, [0, 0, 10, 0, 0, 10]), b = M(3, 2, [0.1, 10, 10.1, 0, 0, 0.1]);
  const r = C.matchSets(a, b);
  const pairs = new Map(r.pairs);
  check("matchSets optimal assignment", pairs.get(0) === 2 && pairs.get(1) === 1 && pairs.get(2) === 0 && Math.abs(r.max - 0.1) < 1e-12);
  const empty = C.decode({ coords: M(4, 2, [0, 0, 1, 0, 0, 1, 1, 1]), density: new Float64Array(4), features: M(4, 3), weights: new Float64Array([1, 1, 1, 1]), sigma: 1 }, { rng: C.makeRng(1) });
  check("decode empty field", empty.count === 0 && empty.positions.rows === 0 && empty.features.rows === 0);
  const m = FX.molecules[1];
  const pos = M(m.N, 3, m.positions), feat = M(m.N, 5, m.features);
  const imp = C.sampleImportance(pos, m.sigma, 8192, C.makeRng(11));
  const ev = C.evaluateFields(pos, feat, imp.coords, m.sigma);
  const t0 = Date.now();
  const dec = C.decode({ coords: imp.coords, density: ev.density, features: ev.features, weights: imp.weights, sigma: m.sigma }, { rng: C.makeRng(12) });
  const ms = Date.now() - t0;
  check("decode 8192 samples in time", dec.count === m.N && ms < 2500, `${ms} ms`);
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
