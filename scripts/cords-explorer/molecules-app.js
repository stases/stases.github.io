import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { mat, makeRng, evaluateFields, sampleImportance, sampleUniformGrid, countEstimate, matchSets } from './cords.js';
import { integerText, colorRamp, marchingSquares, frameScheduler, createRenderer, disposeGroup,
  createDecodeClient, followParentTheme, reportHeight } from './figure.js';

const DATA = window.CORDS_MOLECULES;
const ELEMENTS = DATA.elements;
const COUNTS = [128, 256, 512, 1024, 2048, 4096, 8192];
const RADII = [.30, .46, .44, .42, .40];
const GRID = 160;
const LEVELS = [.05, .12, .20, .30, .42, .56, .72, .90];
const PLANE_DROP = 2.0; // Å from the lowest atom centre down to the plane
const TILT = THREE.MathUtils.degToRad(18);
const PALETTES = {
  light: { elements: ['#E0A526', '#2F6DB5', '#1F9E89', '#D9542B', '#B8407A'],
    density: ['#EEF2F7', '#D7DFEA', '#A8B7CC', '#637A98', '#1F2F47'],
    background: '#EEF2F7', plane: '#E6EBF2', text: '#0F172A', neutral: '#7A8699', bonds: '#B4BCC8' },
  dark: { elements: ['#F2BF4A', '#5B9BE6', '#3FC4AD', '#F07A52', '#E06AA6'],
    density: ['#0A0F1C', '#16213A', '#2D4468', '#5E82B5', '#BBD1F2'],
    background: '#0A0F1C', plane: '#0F1524', text: '#EEF3FF', neutral: '#8A96AA', bonds: '#6B7891' },
};
const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const ease = (t) => 1 - (1 - t) ** 3;
let settings = { molecule: DATA.default, field: 'density', element: 'C', sampling: 'importance',
  M: 1024, n: 12, sigma: .45, decode: false };
let theme = root.dataset.theme, palette, luts;
let live = null, projection = null, decoded = null, previousResult = null, decodeError = null;
let view = null;
let dirty = true, visualDirty = true, fade = null, fadeAnimation = null;
let blend = 0, blendTween = null, waiters = [];

function seedFor(state) {
  // A stable seed per (molecule, M, sigma); selecting a feature never moves the cloud.
  let seed = 2166136261;
  for (const c of `${state.molecule}:${state.M}:${state.sigma.toFixed(2)}`) {
    seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
  }
  return seed >>> 0;
}

function sampleMolecule(molecule, state) {
  // Principal axes in the data are x, y, z; the flattest axis becomes scene y.
  // Planar molecules (flattest extent < 0.5 Å) are tilted 18° about x so the ring does not lie parallel to the plane.
  const flat = Math.max(...molecule.positions.map(([, , z]) => z)) - Math.min(...molecule.positions.map(([, , z]) => z)) < .5;
  const tilt = flat ? TILT : 0, cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const positions = mat(molecule.n_atoms, 3, molecule.positions.flatMap(([x, y, z]) => [x, z * cosT - y * sinT, z * sinT + y * cosT]));
  const features = mat(molecule.n_atoms, 5);
  molecule.types.forEach((type, i) => { features.data[5 * i + type] = 1; });
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.rows; i++) for (let d = 0; d < 3; d++) {
    minimum[d] = Math.min(minimum[d], positions.data[3 * i + d]);
    maximum[d] = Math.max(maximum[d], positions.data[3 * i + d]);
  }
  const padding = Math.max(1.1, 2.6 * state.sigma);
  const side = Math.max(6.5, maximum[0] - minimum[0] + 2 * padding, maximum[2] - minimum[2] + 2 * padding);
  const cx = (minimum[0] + maximum[0]) / 2, cz = (minimum[2] + maximum[2]) / 2;
  const lo = [cx - side / 2, minimum[1] - PLANE_DROP, cz - side / 2];
  const hi = [cx + side / 2, maximum[1] + padding, cz + side / 2];
  const samples = state.sampling === 'importance'
    ? sampleImportance(positions, state.sigma, state.M, makeRng(seedFor(state)))
    : sampleUniformGrid(lo, hi, state.n);
  const fields = { coords: samples.coords, ...evaluateFields(positions, features, samples.coords, state.sigma),
    weights: samples.weights, sigma: state.sigma, pixelMass: false };
  return { molecule, state: { ...state }, positions, fields, box: { lo, hi, side, cx, cz, ymax: maximum[1], sampling: state.sampling },
    estimate: countEstimate(fields.density, fields.weights), maxDensity: (2 * Math.PI * state.sigma ** 2) ** -1.5 };
}

function projectFields(data) {
  // Display only: integrate the unit-mass 3D kernel along y analytically.
  const density = new Float64Array(GRID * GRID);
  const features = ELEMENTS.map(() => new Float64Array(density.length));
  const { box, positions, state, molecule } = data;
  const step = box.side / GRID, inverse = 1 / (2 * state.sigma ** 2);
  const scale = 1 / (2 * Math.PI * state.sigma ** 2);
  const gx = new Float64Array(GRID), gz = new Float64Array(GRID);
  for (let i = 0; i < positions.rows; i++) {
    for (let k = 0; k < GRID; k++) {
      gx[k] = scale * Math.exp(-((box.lo[0] + (k + .5) * step - positions.data[3 * i]) ** 2) * inverse);
      gz[k] = Math.exp(-((box.hi[2] - (k + .5) * step - positions.data[3 * i + 2]) ** 2) * inverse);
    }
    const channel = features[molecule.types[i]];
    for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
      const index = z * GRID + x, value = gx[x] * gz[z];
      density[index] += value; channel[index] += value;
    }
  }
  return { density, features, maximum: Math.max(...density) };
}

function matchedDecode(data, result) {
  const truth = data.positions, pred = result.positions;
  let assignment;
  if (truth.rows === pred.rows) assignment = matchSets(truth, pred).pairs;
  else if (!truth.rows || !pred.rows) assignment = [];
  else {
    // matchSets accepts equal shapes only. Pad in a fourth dimension, so dummy
    // distances are effectively constant (variation < 1e-6 Å), not extra atoms.
    const size = Math.max(truth.rows, pred.rows);
    const radius = Math.max(1, ...Array.from(truth.data, Math.abs), ...Array.from(pred.data, Math.abs));
    const pad = (points) => {
      const padded = mat(size, 4);
      for (let i = 0; i < size; i++) {
        if (i < points.rows) padded.data.set(points.data.subarray(3 * i, 3 * i + 3), 4 * i);
        else padded.data[4 * i + 3] = radius * radius * 1e7;
      }
      return padded;
    };
    assignment = matchSets(pad(truth), pad(pred)).pairs.filter(([i, j]) => i < truth.rows && j < pred.rows);
  }
  // Measure only real pairs, in the original three-dimensional Å coordinates.
  const a = mat(assignment.length, 3), b = mat(assignment.length, 3);
  assignment.forEach(([i, j], k) => {
    a.data.set(truth.data.subarray(i * 3, i * 3 + 3), k * 3);
    b.data.set(pred.data.subarray(j * 3, j * 3 + 3), k * 3);
  });
  const measured = matchSets(a, b);
  const pairs = measured.pairs.map(([i, j]) => [assignment[i][0], assignment[j][1]]);
  const types = Array.from({ length: pred.rows }, (_, i) => {
    let best = 0;
    for (let k = 1; k < 5; k++) if (result.features.data[5 * i + k] > result.features.data[5 * i + best]) best = k;
    return best;
  });
  return { result, types, pairs, rms: pairs.length ? measured.rms : null,
    typesCorrect: pairs.filter(([i, j]) => data.molecule.types[i] === types[j]).length,
    matched: pairs.length, N: truth.rows };
}

function buildLuts() {
  palette = PALETTES[theme];
  const ramps = [palette.density, ...palette.elements.map((color) => [palette.background, color])];
  luts = ramps.map((stops) => {
    const { linear, srgb } = colorRamp(stops);
    return { linear, bytes: Uint8Array.from(srgb.flat()) };
  });
}
function fieldLut() { return luts[settings.field === 'density' ? 0 : ELEMENTS.indexOf(settings.element) + 1]; }

function contourSegments(values, box) {
  const step = box.side / GRID;
  return marchingSquares(values, GRID, GRID, Math.max(...values), LEVELS, (a, b, t) => {
    const x = a % GRID + t * (b % GRID - a % GRID);
    const z = Math.floor(a / GRID) + t * (Math.floor(b / GRID) - Math.floor(a / GRID));
    return [box.lo[0] + (x + .5) * step, box.lo[1] + .002, box.hi[2] - (z + .5) * step];
  });
}

function snapshot() {
  const report = { ...settings, N: live?.molecule.n_atoms ?? null, sampleCount: live?.fields.coords.rows ?? null,
    estimate: live?.estimate ?? null, rounded: live ? Math.round(live.estimate) : null,
    pending: dirty || decoder.pending, error: decodeError, theme };
  if (settings.decode && decoded) Object.assign(report, { count: decoded.result.count, rms: decoded.rms,
    typesCorrect: decoded.typesCorrect, matched: decoded.matched, typeAccuracy: decoded.matched ? decoded.typesCorrect / decoded.matched : null });
  return report;
}

function normalizeState(partial) {
  const next = { ...settings };
  for (const [key, value] of Object.entries(partial)) {
    if (!Object.hasOwn(next, key)) throw new Error(`Unknown state key: ${key}`);
    if (key === 'molecule' && !DATA.molecules.some((m) => m.id === value)) throw new Error(`Unknown molecule: ${value}`);
    if (key === 'field' && !['density', 'features'].includes(value)) throw new Error('Field must be density or features');
    if (key === 'sampling' && !['importance', 'uniform'].includes(value)) throw new Error('Sampling must be importance or uniform');
    if (key === 'element' && !ELEMENTS.includes(value)) throw new Error('Unknown element');
    if (['M', 'n', 'sigma'].includes(key) && !Number.isFinite(value)) throw new Error(`${key} must be finite`);
    next[key] = value;
  }
  next.M = COUNTS.reduce((a, b) => Math.abs(b - next.M) < Math.abs(a - next.M) ? b : a);
  next.n = clamp(Math.round(next.n / 2) * 2, 6, 24);
  next.sigma = Math.round(clamp(next.sigma, .1, .6) * 100) / 100;
  next.decode = Boolean(next.decode);
  const molecule = DATA.molecules.find((m) => m.id === next.molecule);
  if (!molecule.types.includes(ELEMENTS.indexOf(next.element))) {
    next.element = ['C', 'N', 'O', 'F', 'H'].find((el) => molecule.types.includes(ELEMENTS.indexOf(el)));
  }
  return next;
}

function setState(partial) {
  let next;
  try { next = normalizeState(partial); } catch (error) { return Promise.reject(error); }
  const changed = Object.keys(next).some((key) => settings[key] !== next[key]);
  if (changed) {
    decoder.cancel(); // Invalidate replies immediately, including during a molecule fade.
    decodeError = null;
    if (decoded) previousResult = decoded;
    decoded = null;
    if (next.decode !== settings.decode) {
      blendTween = reducedMotion.matches ? null : { from: blend, to: Number(next.decode), start: performance.now() };
      if (reducedMotion.matches) blend = Number(next.decode);
    }
    settings = next; dirty = true;
  }
  const promise = new Promise((resolve) => waiters.push(resolve));
  invalidate();
  return promise;
}

function syncControls() {
  const molecule = DATA.molecules.find((m) => m.id === settings.molecule);
  $('#molecule-title').textContent = molecule.name;
  $('#molecule-subtitle').innerHTML = `${molecule.formula_html} · ${molecule.n_atoms} atoms · `;
  const source = document.createElement(molecule.source_url ? 'a' : 'span');
  source.textContent = molecule.source;
  if (molecule.source_url) { source.href = molecule.source_url; source.target = '_blank'; source.rel = 'noopener noreferrer'; }
  $('#molecule-subtitle').append(source);
  $('#structure-badge').textContent = `${molecule.name} · ${molecule.n_atoms} atoms`;
  for (const key of ['molecule', 'field', 'sampling', 'element']) {
    document.querySelectorAll(`[data-${key}]`).forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset[key] === settings[key]));
      if (key === 'element') button.disabled = !molecule.types.includes(ELEMENTS.indexOf(button.dataset.element));
    });
  }
  $('#elements').hidden = settings.field !== 'features';
  $('#importance-row').hidden = settings.sampling !== 'importance';
  $('#uniform-row').hidden = settings.sampling !== 'uniform';
  $('#M-slider').value = COUNTS.indexOf(settings.M); $('#M-value').value = integerText(settings.M);
  $('#M-slider').setAttribute('aria-valuetext', `${integerText(settings.M)} points`);
  $('#n-slider').value = settings.n; $('#n-value').value = `${settings.n}³ = ${integerText(settings.n ** 3)}`;
  $('#n-slider').setAttribute('aria-valuetext', `${settings.n} cubed, ${integerText(settings.n ** 3)} points`);
  $('#sigma-slider').value = settings.sigma; $('#sigma-value').value = `${settings.sigma.toFixed(2)} Å`;
  $('#sigma-slider').setAttribute('aria-valuetext', `${settings.sigma.toFixed(2)} angstroms`);
  $('#decode-toggle').setAttribute('aria-checked', String(settings.decode));
  $('#decode-value').textContent = settings.decode ? 'on' : 'off';
  $('#decode-results').classList.toggle('open', settings.decode);
  $('#decode-results').setAttribute('aria-hidden', String(!settings.decode));
  $('#field-caption').innerHTML = settings.field === 'density'
    ? 'ρ(r) = Σᵢ κ<sub>σ</sub>(r − rᵢ)<br>projected onto the plane'
    : `h<sub>${settings.element}</sub>(r) = Σᵢ κ<sub>σ</sub>(r − rᵢ) [atom i is ${settings.element}]<br>projected onto the plane`;
  $('#sampling-note').textContent = settings.sampling === 'importance'
    ? 'Points are drawn from ρ/N and weighted by 1/(M q), so the weighted sum returns N exactly; switch to Uniform to see a grid estimate that must be rounded.'
    : `A ${settings.n}³ grid integrates ρ numerically: N̂ is very close to N when σ is at least the grid spacing. With a coarse grid and small σ it drifts; rounding can miss the count.`;
  if (live) {
    $('#objects-readout').value = live.molecule.n_atoms;
    $('#samples-readout').value = integerText(live.fields.coords.rows);
    $('#samples-unit').textContent = settings.sampling === 'uniform' ? `${settings.n}³ grid` : 'points';
    $('#kernel-readout').value = settings.sigma.toFixed(2);
    $('#estimate-readout').value = live.estimate.toFixed(3);
    $('#estimate-readout').classList.toggle('drift', Math.abs(live.estimate - live.molecule.n_atoms) > .5);
    $('#estimate-rounded').textContent = `→ ${Math.round(live.estimate)}`;
  }
  syncResults();
}

function syncResults() {
  const pending = settings.decode && (decoder.pending || dirty);
  const report = decoded || (pending ? previousResult : null);
  $('#decode-results').setAttribute('aria-busy', String(pending));
  const status = $('#decode-status');
  status.hidden = !settings.decode || (!pending && !decodeError);
  status.textContent = pending ? 'Decoding…' : decodeError ? `Decoding failed: ${decodeError}` : '';
  status.classList.toggle('error', Boolean(decodeError));
  $('#result-values').hidden = !report;
  if (!report) return;
  const { result, N, rms, typesCorrect, matched } = report;
  const difference = result.count - N;
  $('#result-count').innerHTML = `N̂ = ${result.estimate.toFixed(3)} → rounds to ${result.count}<span class="count-truth">N = ${N} · <span class="${difference ? 'count-error' : ''}">${difference ? `✗ off by ${difference > 0 ? '+' : ''}${difference}` : '✓'}</span></span>`;
  $('#result-rms').textContent = rms === null ? 'No matched pairs' : `RMS ${rms.toFixed(3)} Å${difference ? ' over matched pairs' : ''}`;
  $('#result-types').textContent = difference ? `${typesCorrect} / ${N} matched · ${matched} pairs` : `${typesCorrect} / ${N} correct`;
}

const decoder = createDecodeClient({
  result(data) {
    try {
      if (data.error) throw new Error(data.error);
      decoded = matchedDecode(live, data.result); previousResult = decoded;
      view?.updateDecoded();
    } catch (error) { decoded = null; decodeError = error.message; }
    syncResults(); invalidate();
  },
  error(message) { decodeError = message; syncResults(); invalidate(); },
});

function startDecode() {
  decoder.pending = true; decodeError = null; syncResults();
  decoder.start(live.fields, seedFor(settings));
}

const scheduleFrame = frameScheduler(tick);
function invalidate() { visualDirty = true; scheduleFrame(); }

function tick(time) {
  if (dirty) {
    const changingMolecule = live && live.molecule.id !== settings.molecule;
    if (changingMolecule && !fade && view && !reducedMotion.matches) {
      fadeAnimation?.cancel();
      fadeAnimation = view.renderer.domElement.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
      fade = { until: time + 120 };
    }
    if (!fade || time >= fade.until || reducedMotion.matches) {
      const first = !live, oldBox = live?.box;
      const onlyDecodeChanged = live && Object.keys(settings).every((key) => key === 'decode' || live.state[key] === settings[key]);
      const needsProjection = first || changingMolecule || live.state.sigma !== settings.sigma;
      live = sampleMolecule(DATA.molecules.find((m) => m.id === settings.molecule), settings);
      if (needsProjection) projection = projectFields(live);
      dirty = false; syncControls();
      if (!onlyDecodeChanged) view?.rebuild();
      if (first || changingMolecule || oldBox.side !== live.box.side || oldBox.lo[1] !== live.box.lo[1]
        || oldBox.sampling !== live.box.sampling
        || (settings.sampling === 'uniform' && oldBox.hi[1] !== live.box.hi[1])) view?.fit(!first);
      if (fade) {
        fadeAnimation?.cancel(); fade = null;
        fadeAnimation = view?.renderer.domElement.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reducedMotion.matches ? 0 : 200, easing: 'ease-out' });
      }
      if (settings.decode) startDecode();
    }
  }
  if (blendTween) {
    const t = reducedMotion.matches ? 1 : clamp((time - blendTween.start) / 180, 0, 1);
    blend = THREE.MathUtils.lerp(blendTween.from, blendTween.to, ease(t));
    if (t === 1) blendTween = null;
  }
  const moving = view?.step(time) || false;
  if (visualDirty || moving || blendTween) {
    view?.applyBlend(); view?.render(); visualDirty = false;
    if (live) { $('#loading').hidden = true; view?.renderer.domElement.classList.add('ready'); }
  }
  if (!dirty && !decoder.pending && !moving && !blendTween && waiters.length) {
    const result = snapshot(); const ready = waiters; waiters = [];
    ready.forEach((resolve) => resolve(result));
  }
  if (dirty || moving || blendTween) invalidate();
}

class MoleculeView {
  constructor(host, canvas, context) {
    this.host = host;
    this.renderer = createRenderer(canvas, context);
    this.renderer.toneMappingExposure = 1;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Atoms above a plane of projected density, with coloured drop lines and field samples.');
    host.prepend(canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, .1, 1000);
    this.scene.add(this.camera);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false; this.controls.enableDamping = !reducedMotion.matches;
    this.controls.dampingFactor = .08;
    this.controls.addEventListener('change', invalidate);
    this.controls.addEventListener('start', () => { this.cameraTween = null; this.clearHover(); invalidate(); });
    const hemi = new THREE.HemisphereLight('#FFFFFF', '#B9C2D0', .6);
    const key = new THREE.DirectionalLight('#FFFFFF', 1.1); key.position.set(-.6, 1, .8); this.camera.add(key);
    const fill = new THREE.DirectionalLight('#FFFFFF', .35); fill.position.set(.8, .2, -.6); this.camera.add(fill);
    const ambient = new THREE.AmbientLight('#FFFFFF', .22);
    this.scene.add(hemi, ambient, key.target, fill.target);
    this.lights = [[hemi, .6], [key, 1.1], [fill, .35], [ambient, .22]];
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.hovered = null; this.rings = [];
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  line(group, positions, color, opacity, width = 1, dashed = false) {
    if (!positions.length) return null;
    const material = new LineMaterial({ color, linewidth: width, transparent: true, opacity,
      depthWrite: false, toneMapped: false, dashed, dashSize: .14, gapSize: .10 });
    material.resolution.set(this.host.clientWidth, this.host.clientHeight);
    const line = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), material);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 4; group.add(line); return line;
  }

  rebuild() {
    this.clearHover();
    disposeGroup(this.content); this.content?.removeFromParent(); disposeGroup(this.overlay); this.overlay?.removeFromParent(); this.overlay = null; this.rings = [];
    this.content = new THREE.Group(); this.scene.add(this.content);
    this.scene.background = new THREE.Color(palette.background);
    this.lights.forEach(([light, intensity]) => { light.intensity = intensity * (theme === 'dark' ? .9 : 1); });
    this.buildPlane(); this.buildAtoms(); this.buildSamples();
    if (decoded && settings.decode) this.updateDecoded();
    this.applyBlend();
  }

  buildPlane() {
    const { box } = live, group = this.content;
    const planeGeometry = new THREE.PlaneGeometry(box.side, box.side);
    const base = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({ color: palette.plane, toneMapped: false, side: THREE.DoubleSide }));
    base.rotation.x = -Math.PI / 2; base.position.set(box.cx, box.lo[1], box.cz); group.add(base);
    const values = settings.field === 'density' ? projection.density : projection.features[ELEMENTS.indexOf(settings.element)];
    const bytes = new Uint8Array(GRID * GRID * 4), lut = fieldLut();
    for (let i = 0; i < values.length; i++) {
      const index = Math.round(255 * clamp(values[i] / projection.maximum, 0, 1));
      bytes.set(lut.bytes.subarray(3 * index, 3 * index + 3), 4 * i); bytes[4 * i + 3] = 217;
    }
    const texture = new THREE.DataTexture(bytes, GRID, GRID);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
    const fill = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true,
      depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    fill.rotation.copy(base.rotation); fill.position.copy(base.position); fill.renderOrder = 1; group.add(fill);
    const [x0, y, z0] = box.lo, [x1, y1, z1] = box.hi, grid = [];
    for (let x = Math.ceil(x0); x < x1; x++) grid.push(x, y + .001, z0, x, y + .001, z1);
    for (let z = Math.ceil(z0); z < z1; z++) grid.push(x0, y + .001, z, x1, y + .001, z);
    this.line(group, grid, palette.neutral, .18).renderOrder = 2;
    const border = [x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0];
    this.line(group, border, palette.neutral, .7);
    const contours = this.line(group, contourSegments(values, box), palette.text, theme === 'dark' ? .36 : .42);
    if (contours) contours.renderOrder = 3;
    if (settings.sampling === 'uniform') {
      const edges = [];
      for (const x of [x0, x1]) for (const z of [z0, z1]) edges.push(x, y, z, x, y1, z);
      for (const z of [z0, z1]) edges.push(x0, y1, z, x1, y1, z);
      for (const x of [x0, x1]) edges.push(x, y1, z0, x, y1, z1);
      this.line(group, edges, palette.neutral, .5);
    }
  }

  buildAtoms() {
    const { molecule, positions, box } = live, group = this.content;
    const helper = new THREE.Object3D(), sphere = new THREE.SphereGeometry(1, 40, 28);
    this.atomMaterial = new THREE.MeshPhysicalMaterial({ roughness: .35, metalness: 0,
      clearcoat: .6, clearcoatRoughness: .25, transparent: true });
    this.atoms = new THREE.InstancedMesh(sphere, this.atomMaterial, positions.rows);
    this.atoms.renderOrder = 10;
    for (let i = 0; i < positions.rows; i++) {
      helper.position.fromArray(positions.data, 3 * i); helper.scale.setScalar(RADII[molecule.types[i]]); helper.updateMatrix();
      this.atoms.setMatrixAt(i, helper.matrix); this.atoms.setColorAt(i, new THREE.Color(palette.elements[molecule.types[i]]));
    }
    group.add(this.atoms);
    this.bondMaterial = new THREE.MeshStandardMaterial({ color: palette.bonds, roughness: .7, transparent: true });
    const bonds = new THREE.InstancedMesh(new THREE.CylinderGeometry(.10, .10, 1, 12), this.bondMaterial, molecule.bonds.length);
    bonds.renderOrder = 6;
    const up = new THREE.Vector3(0, 1, 0);
    molecule.bonds.forEach(([a, b], i) => {
      const start = new THREE.Vector3().fromArray(positions.data, 3 * a), end = new THREE.Vector3().fromArray(positions.data, 3 * b);
      const direction = end.clone().sub(start);
      helper.position.copy(start).add(end).multiplyScalar(.5); helper.scale.set(1, direction.length(), 1);
      helper.quaternion.setFromUnitVectors(up, direction.normalize()); helper.updateMatrix(); bonds.setMatrixAt(i, helper.matrix);
    });
    group.add(bonds);
    ELEMENTS.forEach((element, type) => {
      const ids = molecule.types.map((t, i) => t === type ? i : -1).filter((i) => i >= 0);
      if (!ids.length) return;
      const opacity = settings.field === 'features' && element !== settings.element ? .35 : 1;
      const discs = new THREE.InstancedMesh(new THREE.CircleGeometry(.11, 24), new THREE.MeshBasicMaterial({
        color: palette.elements[type], transparent: true, opacity, depthWrite: false, toneMapped: false }), ids.length);
      const drops = [];
      helper.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); helper.scale.setScalar(1);
      ids.forEach((i, index) => {
        const [x, y, z] = positions.data.subarray(3 * i, 3 * i + 3);
        helper.position.set(x, box.lo[1] + .003, z); helper.updateMatrix(); discs.setMatrixAt(index, helper.matrix);
        drops.push(x, y - RADII[type], z, x, box.lo[1] + .003, z);
      });
      discs.renderOrder = 5; group.add(discs);
      this.line(group, drops, palette.elements[type], .7, 1.5, true).renderOrder = 6;
    });
  }

  buildSamples() {
    const { fields, maxDensity } = live, count = fields.coords.rows;
    const colors = new Float32Array(count * 3), alpha = new Float32Array(count), lut = fieldLut();
    const channel = ELEMENTS.indexOf(settings.element);
    const floor = settings.field === 'features' ? .10 : .25;
    for (let i = 0; i < count; i++) {
      const value = settings.field === 'density' ? fields.density[i] : fields.features.data[5 * i + channel];
      const t = clamp(value / maxDensity, 0, 1), color = lut.linear[Math.round(255 * (floor + (1 - floor) * t))];
      color.toArray(colors, 3 * i);
      alpha[i] = settings.sampling === 'importance' ? .55 : .15 + .85 * Math.sqrt(t);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(fields.coords.data, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('pointAlpha', new THREE.BufferAttribute(alpha, 1));
    const radius = settings.sampling === 'uniform' ? (settings.n <= 12 ? .04 : .03)
      : settings.M <= 1024 ? .035 : settings.M <= 4096 ? .028 : .022;
    this.pointMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true, toneMapped: false,
      uniforms: { diameter: { value: 2 * radius }, projectionScale: { value: this.projectionScale() } },
      vertexShader: `attribute float pointAlpha;
        uniform float diameter;
        uniform float projectionScale;
        varying vec3 sampleColor;
        varying float sampleAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, diameter * projectionScale / -mv.z);
          sampleColor = color; sampleAlpha = pointAlpha;
        }`,
      fragmentShader: `varying vec3 sampleColor;
        varying float sampleAlpha;
        void main() {
          vec2 p = 2.0 * gl_PointCoord - 1.0;
          float r = dot(p, p);
          if (r > 1.0) discard;
          gl_FragColor = vec4(sampleColor, sampleAlpha * (1.0 - smoothstep(0.8, 1.0, r)));
          #include <colorspace_fragment>
        }` });
    const points = new THREE.Points(geometry, this.pointMaterial); points.renderOrder = 5; this.content.add(points);
  }

  updateDecoded() {
    disposeGroup(this.overlay); this.overlay?.removeFromParent(); this.overlay = null; this.rings = [];
    if (!decoded || !settings.decode) return;
    this.overlay = new THREE.Group(); this.scene.add(this.overlay);
    const { result, types, pairs } = decoded;
    const matched = new Map(pairs.map(([i, j]) => [j, i]));
    const helper = new THREE.Object3D();
    this.recoveredMaterial = new THREE.MeshPhysicalMaterial({ roughness: .35, metalness: 0,
      clearcoat: .6, clearcoatRoughness: .25, transparent: true });
    const recovered = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 40, 28), this.recoveredMaterial, result.count);
    recovered.renderOrder = 7;
    for (let i = 0; i < result.count; i++) {
      const color = palette.elements[types[i]];
      helper.position.fromArray(result.positions.data, 3 * i); helper.scale.setScalar(.55 * RADII[types[i]]); helper.updateMatrix();
      recovered.setMatrixAt(i, helper.matrix); recovered.setColorAt(i, new THREE.Color(color));
      const trueIndex = matched.get(i), radius = 1.25 * RADII[trueIndex === undefined ? types[i] : live.molecule.types[trueIndex]];
      const circle = [];
      for (let k = 0; k < 64; k++) for (const a of [k, k + 1]) circle.push(radius * Math.cos(a * Math.PI / 32), radius * Math.sin(a * Math.PI / 32), 0);
      const ring = this.line(this.overlay, circle, color, .9, 1.5);
      ring.position.copy(helper.position); ring.renderOrder = 9; this.rings.push(ring);
    }
    this.overlay.add(recovered); this.applyBlend();
  }

  applyBlend() {
    if (!this.atomMaterial) return;
    // OPAQUE is a shader define: refresh the program when entering/leaving a fade.
    for (const [material, transparent] of [[this.atomMaterial, blend > 0],
      [this.bondMaterial, blend > 0], [this.recoveredMaterial, blend < 1]]) {
      if (material && material.transparent !== transparent) {
        material.transparent = transparent; material.needsUpdate = true;
      }
    }
    this.atomMaterial.opacity = 1 - .75 * blend; this.atomMaterial.depthWrite = blend === 0;
    this.bondMaterial.opacity = 1 - .7 * blend; this.bondMaterial.depthWrite = blend === 0;
    if (this.recoveredMaterial) {
      this.recoveredMaterial.opacity = blend;
      this.recoveredMaterial.depthWrite = blend === 1;
    }
    if (this.overlay) this.overlay.visible = blend > 0;
    this.rings.forEach((ring) => { ring.material.opacity = .9 * blend; });
  }

  projectionScale() { return this.host.clientHeight * this.renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))); }

  resize() {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false);
    this.scene.traverse((object) => { if (object.material?.isLineMaterial) object.material.resolution.set(width, height); });
    if (this.pointMaterial) this.pointMaterial.uniforms.projectionScale.value = this.projectionScale();
    if (live) this.fit(false, true);
    invalidate();
  }

  fit(animate = true, preserveDirection = false) {
    if (!live) return;
    const { box, molecule } = live;
    const top = settings.sampling === 'uniform' ? box.hi[1] : box.ymax + .5;
    const target = new THREE.Vector3(0, (box.lo[1] + top) / 2, 0);
    const large = ['aspirin', 'caffeine'].includes(molecule.id);
    const azimuth = THREE.MathUtils.degToRad(large ? 30 : 35), elevation = THREE.MathUtils.degToRad(large ? 28 : 26);
    const direction = preserveDirection ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    const right = new THREE.Vector3().crossVectors(this.camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let distance = 0;
    for (const x of [box.lo[0], box.hi[0]]) for (const y of [box.lo[1], top]) for (const z of [box.lo[2], box.hi[2]]) {
      const point = new THREE.Vector3(x, y, z).sub(target), depth = point.dot(direction);
      distance = Math.max(distance, depth + Math.abs(point.dot(right)) / (tangent * this.camera.aspect * .90),
        depth + Math.abs(point.dot(up)) / (tangent * .84));
    }
    const to = target.clone().addScaledVector(direction, distance);
    this.controls.minDistance = .75 * distance; this.controls.maxDistance = 1.6 * distance;
    // Clear any residual drag damping before setting a reproducible fit.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update(); this.controls.enableDamping = damping;
    this.cameraTween = animate && !reducedMotion.matches ? { from: this.camera.position.clone(), to,
      fromTarget: this.controls.target.clone(), target, start: performance.now() } : null;
    if (!this.cameraTween) { this.camera.position.copy(to); this.controls.target.copy(target); this.controls.update(); }
    invalidate();
  }

  step(time) {
    let moving = false;
    if (this.cameraTween) {
      const tween = this.cameraTween, t = reducedMotion.matches ? 1 : clamp((time - tween.start) / 320, 0, 1);
      this.camera.position.lerpVectors(tween.from, tween.to, ease(t));
      this.controls.target.lerpVectors(tween.fromTarget, tween.target, ease(t));
      if (t === 1) this.cameraTween = null;
      moving = true;
    }
    return this.controls.update() || moving;
  }

  render() {
    this.rings.forEach((ring) => ring.quaternion.copy(this.camera.quaternion));
    this.renderer.render(this.scene, this.camera);
  }

  clearHover() {
    if (this.hovered !== null && this.atoms && live) {
      this.atoms.setColorAt(this.hovered, new THREE.Color(palette.elements[live.molecule.types[this.hovered]]));
      this.atoms.instanceColor.needsUpdate = true;
    }
    this.hovered = null; $('#atom-tooltip').hidden = true;
  }

  bindPointer() {
    const canvas = this.renderer.domElement;
    let down = null;
    canvas.addEventListener('pointerdown', (event) => { down = [event.clientX, event.clientY]; this.clearHover(); });
    canvas.addEventListener('pointerup', () => { down = null; });
    canvas.addEventListener('pointercancel', () => { down = null; this.clearHover(); });
    canvas.addEventListener('pointerleave', () => { this.clearHover(); invalidate(); });
    canvas.addEventListener('pointermove', (event) => {
      if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) $('#drag-hint').hidden = true;
      if (down || event.pointerType === 'touch' || !this.atoms) return;
      this.clearHover();
      const box = canvas.getBoundingClientRect();
      this.pointer.set((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObject(this.atoms)[0];
      if (hit && hit.instanceId < live.positions.rows) {
        const i = hit.instanceId, type = live.molecule.types[i]; this.hovered = i;
        this.atoms.setColorAt(i, new THREE.Color(palette.elements[type]).lerp(new THREE.Color('white'), .12));
        this.atoms.instanceColor.needsUpdate = true;
        const tooltip = $('#atom-tooltip');
        tooltip.textContent = `${ELEMENTS[type]} · (${Array.from(live.positions.data.subarray(3 * i, 3 * i + 3), (v) => v.toFixed(2)).join(', ')}) Å`;
        tooltip.hidden = false;
        tooltip.style.left = `${clamp(event.clientX - box.left + 12, 8, box.width - tooltip.offsetWidth - 8)}px`;
        tooltip.style.top = `${clamp(event.clientY - box.top + 12, 8, box.height - tooltip.offsetHeight - 8)}px`;
      }
      invalidate();
    });
    canvas.addEventListener('dblclick', () => this.fit());
    this.host.addEventListener('keydown', (event) => {
      if (event.target !== this.host || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); this.cameraTween = null;
      const spherical = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
      const delta = THREE.MathUtils.degToRad(5);
      if (event.key === 'ArrowLeft') spherical.theta -= delta;
      if (event.key === 'ArrowRight') spherical.theta += delta;
      if (event.key === 'ArrowUp') spherical.phi -= delta;
      if (event.key === 'ArrowDown') spherical.phi += delta;
      spherical.makeSafe(); this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
      this.clearHover(); invalidate();
    });
  }
}

function bindChoiceRow(selector, key) {
  const row = $(selector);
  row.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => { void setState({ [key]: button.dataset[key] }); });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(row.querySelectorAll('button')).filter((b) => !b.disabled);
      const index = buttons.indexOf(button), direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(index + direction + buttons.length) % buttons.length];
      next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      void setState({ [key]: next.dataset[key] });
    });
  });
}

$('#molecules').innerHTML = DATA.molecules.map((m) => `<button type="button" class="chip" data-molecule="${m.id}" aria-pressed="${m.id === settings.molecule}">${m.name}</button>`).join('');
$('#elements').innerHTML = ELEMENTS.map((el) => `<button type="button" class="token" data-element="${el}" aria-pressed="false" style="--orbit-color:var(--${el.toLowerCase()})"><span class="dot" aria-hidden="true"></span>${el}</button>`).join('');
bindChoiceRow('#molecules', 'molecule'); bindChoiceRow('#field-controls', 'field');
bindChoiceRow('#sampling-controls', 'sampling'); bindChoiceRow('#elements', 'element');
$('#M-slider').addEventListener('input', (event) => { void setState({ M: COUNTS[Number(event.target.value)] }); });
$('#n-slider').addEventListener('input', (event) => { void setState({ n: Number(event.target.value) }); });
$('#sigma-slider').addEventListener('input', (event) => { void setState({ sigma: Number(event.target.value) }); });
$('#decode-toggle').addEventListener('click', () => { void setState({ decode: !settings.decode }); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { document.activeElement?.blur(); view?.clearHover(); invalidate(); }
});

buildLuts();
const canvas = document.createElement('canvas');
const context = canvas.getContext('webgl2', { antialias: true });
if (context) view = new MoleculeView($('#viewport'), canvas, context);
else {
  const message = document.createElement('p'); message.className = 'webgl-message';
  message.innerHTML = 'This figure needs WebGL.<br><a href="https://raw.githubusercontent.com/stases/CORDS---ICLR-2026/main/figures/MOLECULE.png" target="_blank" rel="noopener noreferrer">View the paper figure ↗</a>';
  $('#viewport').append(message); $('#loading').hidden = true; $('#drag-hint').hidden = true;
}

function followTheme(value) {
  if (!['light', 'dark'].includes(value) || value === theme) return;
  theme = value; root.dataset.theme = theme; buildLuts();
  if (live) view?.rebuild();
  invalidate();
}
followParentTheme(followTheme);
reducedMotion.addEventListener('change', () => {
  if (view) view.controls.enableDamping = !reducedMotion.matches;
  invalidate();
});
reportHeight($('#explorer'));
window.cordsMolecules = { set: setState, state: snapshot };
invalidate();
