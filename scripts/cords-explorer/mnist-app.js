import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { mat, encodePixelGrid, sampleImportance, evaluateFields, countEstimate, matchSets, makeRng } from './cords.js';
import { integerText, colorRamp, marchingSquares, frameScheduler, createRenderer, disposeGroup,
  createDecodeClient, followParentTheme, reportHeight } from './figure.js';

const DATA = window.CORDS_MNIST;
const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const narrow = matchMedia('(max-width: 719px)');
const POINT_COUNTS = [256, 512, 1024, 2048, 4096];
const GRID_SIZES = [128, 64, 32, 16];
const LEVELS = [.05, .12, .20, .30, .42, .56, .72, .90];
const AZIMUTH = 30 * Math.PI / 180, ELEVATION = 32 * Math.PI / 180;
const DEFAULTS = { n: 8, seed: 1, plane: 'all', sampling: 'uniform', grid: 128, M: 1024, sigma: 4, decode: false };
const GAP = .42; // vertical spacing of the three planes, in plane widths
const LABEL_SHIFT = .07; // minimum leftward shift of the stack, leaving room for the plane labels
const PALETTES = {
  light: {
    base: '#eef2f7', plane: '#e6ebf2', text: '#0f172a', neutral: '#7a8699', copper: '#b5642a',
    classes: ['#2f6db5', '#d9542b', '#e0a526', '#1f9e89', '#b8407a', '#6b5bd6', '#4f9a3c', '#2f93c4', '#9a8a1f', '#6e7b8e'],
    slate: ['#eef2f7', '#d7dfea', '#a8b7cc', '#637a98', '#1f2f47'], image: ['#1f2733', '#f6f8fb'],
  },
  dark: {
    base: '#0a0f1c', plane: '#0f1524', text: '#eef3ff', neutral: '#8a96aa', copper: '#e09262',
    classes: ['#5b9be6', '#f07a52', '#f2bf4a', '#3fc4ad', '#e06aa6', '#9a8cf2', '#78c464', '#5fc0ea', '#c9ba3a', '#9aa8be'],
    slate: ['#0a0f1c', '#16213a', '#2d4468', '#5e82b5', '#bbd1f2'], image: ['#0a0f1c', '#eef3ff'],
  },
};
const settings = { ...DEFAULTS };
let theme = root.dataset.theme, palette, luts;
let model, fields, gridFields, estimate = NaN, result = null, metrics = null;
let decodeError = null;
let view = null, dirty = true, imagePending = false, imageId = 0, imagePixels = null;
let loadedScene = '', visualScene = '', fieldKey = '', visualDirty = true;
const waiters = [], imageCache = new Map();
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const sceneKey = () => `${settings.n}:${settings.seed}`;
const pixelPoint = (x, y, level) => [x / 128 - .5, level, y / 128 - .5];
const maxOf = (values) => values.reduce((a, b) => Math.max(a, b), 0);

const makeLut = (stops) => colorRamp(stops).srgb;

function buildLuts() {
  palette = PALETTES[theme];
  luts = {
    density: makeLut(palette.slate), copper: makeLut([palette.base, palette.copper]),
    classes: palette.classes.map((c) => makeLut([palette.base, c])), image: makeLut(palette.image),
  };
  document.querySelectorAll('[data-class]').forEach((button) => {
    button.style.setProperty('--class-color', palette.classes[Number(button.dataset.class)]);
  });
}

function argmaxClass(features, row) {
  let best = 0;
  for (let k = 1; k < 10; k++) if (features.data[row * 12 + k] > features.data[row * 12 + best]) best = k;
  return best;
}

function currentModel() {
  const data = DATA.scenes.find((s) => s.n === settings.n && s.seed === settings.seed);
  const positions = mat(data.n, 2, data.centers.flat()), features = mat(data.n, 12);
  data.labels.forEach((label, i) => {
    features.data[i * 12 + label] = 1;
    features.data.set(data.sizes[i], i * 12 + 10);
  });
  return { data, positions, features, maxWidth: maxOf(data.sizes.map((s) => s[0])), maxHeight: maxOf(data.sizes.map((s) => s[1])) };
}

function computeFields() {
  model = currentModel();
  const key = [sceneKey(), settings.sampling, settings.grid, settings.M, settings.sigma].join(':');
  if (key === fieldKey) return;
  fieldKey = key;
  const { positions, features } = model, { sigma } = settings;
  gridFields = encodePixelGrid(positions, features, sigma, 128, 128,
    { step: settings.sampling === 'uniform' ? 128 / settings.grid : 1 });
  if (settings.sampling === 'uniform') {
    fields = { ...gridFields, sigma, pixelMass: true };
  } else {
    const samples = sampleImportance(positions, sigma, settings.M, makeRng(settings.seed));
    fields = { ...samples, ...evaluateFields(positions, features, samples.coords, sigma), sigma, pixelMass: false };
  }
  estimate = countEstimate(fields.density, fields.weights);
}

function decodeMetrics(decoded) {
  // Both sampling conventions conserve mass, so these sets have equal cardinality.
  if (decoded.count !== model.positions.rows) return { matched: 0, centreRms: null, sizeRms: null, classesCorrect: 0 };
  const matched = matchSets(model.positions, decoded.positions);
  let sizeSquared = 0, classesCorrect = 0;
  for (const [i, j] of matched.pairs) {
    if (model.data.labels[i] === argmaxClass(decoded.features, j)) classesCorrect++;
    for (const k of [10, 11]) sizeSquared += (128 * (model.features.data[12 * i + k] - decoded.features.data[12 * j + k])) ** 2;
  }
  return { matched: matched.pairs.length, centreRms: matched.rms,
    sizeRms: Math.sqrt(sizeSquared / (2 * matched.pairs.length)), classesCorrect };
}

function finishDecode(message) {
  if (message.error) { result = metrics = null; decodeError = message.error; }
  else { result = message.result; metrics = decodeMetrics(result); }
  syncResults(); view?.updateDecode(); invalidate();
}
const decoder = createDecodeClient({
  result: finishDecode, error: (error) => finishDecode({ error }),
});

function startDecode() {
  decoder.cancel();
  if (!settings.decode) { result = metrics = null; decodeError = null; return; }
  decodeError = null;
  decoder.start(fields, settings.seed);
}

function syncResults() {
  const container = $('#decode-results');
  container.classList.toggle('open', settings.decode);
  container.inert = !settings.decode;
  container.setAttribute('aria-busy', String(decoder.pending));
  $('#decode-status').hidden = !decoder.pending && !decodeError;
  $('#decode-status').textContent = decodeError ? `Decoding failed: ${decodeError}` : decoder.pending ? 'Decoding…' : '';
  $('#decode-status').classList.toggle('error', Boolean(decodeError));
  if (decoder.pending) return; // Retain the preceding values, at half opacity, while the worker runs.
  if (!result) {
    for (const name of ['count', 'centres', 'sizes', 'classes']) $(`#result-${name}`).textContent = '—';
    return;
  }
  const difference = result.count - settings.n;
  $('#result-count').textContent = `N̂ = ${result.estimate.toFixed(3)} → rounds to ${result.count} · N = ${settings.n} ${difference ? `✗ off by ${difference > 0 ? '+' : ''}${difference}` : '✓'}`;
  $('#result-count').classList.toggle('error', difference !== 0);
  $('#result-centres').textContent = metrics.centreRms === null ? 'No equal-count match' : `RMS ${metrics.centreRms.toFixed(3)} px`;
  $('#result-sizes').textContent = metrics.sizeRms === null ? '—' : `RMS ${metrics.sizeRms.toFixed(3)} px`;
  $('#result-classes').textContent = `${metrics.classesCorrect} / ${metrics.matched} correct`;
}

function syncNote() {
  const outside = settings.n > DATA.train_max;
  let note;
  if (narrow.matches) {
    note = outside ? 'N̂ = N. ' : settings.sampling === 'uniform'
      ? 'N̂ = N. At 16², peaks can merge; try N ≥ 15.' : 'Points follow ρ/N; the weighted sum is exactly N.';
  } else {
    note = settings.sampling === 'uniform'
      ? 'Each digit puts one unit of mass on the pixel grid, so the sum is N at every resolution; what a coarse grid loses is the separation of nearby peaks. On 16² try N ≥ 15.'
      : 'Points follow ρ/N, concentrating samples around digits; the weighted sum returns N exactly.';
  }
  $('#sampling-note').textContent = note + (outside ? ` N = ${settings.n} lies outside the counts seen in training.` : '');
}

function syncControls() {
  const outside = settings.n > DATA.train_max, importance = settings.sampling === 'importance';
  $('#n').value = settings.n; $('#n-value').textContent = `${settings.n} ${settings.n === 1 ? 'digit' : 'digits'}`;
  $('#n').setAttribute('aria-valuetext', $('#n-value').textContent);
  $('#sigma').value = settings.sigma; $('#sigma-value').textContent = `${settings.sigma.toFixed(1)} px`;
  $('#sigma').setAttribute('aria-valuetext', $('#sigma-value').textContent);
  $('#m').value = POINT_COUNTS.indexOf(settings.M); $('#m-value').textContent = integerText(settings.M);
  $('#m').setAttribute('aria-valuetext', `${settings.M} points`);
  document.querySelectorAll('[data-plane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.plane === String(settings.plane))));
  document.querySelectorAll('[data-sampling]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sampling === settings.sampling)));
  document.querySelectorAll('[data-grid]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.grid) === settings.grid)));
  $('#grid-control').hidden = importance; $('#m-control').hidden = !importance;
  $('#decode-toggle').setAttribute('aria-checked', String(settings.decode)); $('#decode-state').textContent = settings.decode ? 'on' : 'off';
  $('#scene-title').textContent = $('#n-value').textContent; $('#scene-meta').textContent = `seed ${settings.seed} · 128²`;
  $('#scene-badge').textContent = `seed ${settings.seed} · ${$('#n-value').textContent}${outside ? ' · outside the training range' : ''}`;
  $('#scene-badge').classList.toggle('outside', outside);
  $('#field-caption').textContent = importance ? `M = ${integerText(settings.M)} points drawn from ρ/N` : 'N = ∫ρ · one unit of mass per digit';
  $('#read-n').textContent = settings.n; $('#read-m').textContent = integerText(fields.coords.rows);
  $('#read-sampling').textContent = importance ? 'points' : `${settings.grid}² grid`;
  $('#read-sigma').textContent = settings.sigma.toFixed(1); $('#read-estimate').textContent = estimate.toFixed(3);
  $('#read-round').textContent = `→ ${Math.round(estimate)}`;
  $('#read-estimate').classList.toggle('off', Math.abs(estimate - settings.n) > .5);
  syncNote(); syncResults();
}

function state() {
  return { ...settings, N: settings.n, sampleCount: fields?.coords.rows ?? 0, estimate,
    pending: decoder.pending, error: decodeError, theme,
    count: settings.decode && !decoder.pending && result ? result.count : null,
    rms: settings.decode && !decoder.pending ? metrics?.centreRms ?? null : null,
    centreRms: settings.decode && !decoder.pending ? metrics?.centreRms ?? null : null,
    sizeRms: settings.decode && !decoder.pending ? metrics?.sizeRms ?? null : null,
    classesCorrect: settings.decode && !decoder.pending ? metrics?.classesCorrect ?? null : null,
    matched: settings.decode && !decoder.pending ? metrics?.matched ?? null : null,
    classAccuracy: settings.decode && !decoder.pending && metrics?.matched ? metrics.classesCorrect / metrics.matched : null };
}

function set(partial = {}) {
  const next = { ...settings, ...partial };
  const valid = Object.keys(partial).every((k) => Object.hasOwn(DEFAULTS, k)) &&
    Number.isInteger(next.n) && next.n >= 1 && next.n <= 20 && Number.isInteger(next.seed) && next.seed >= 0 && next.seed <= 3 &&
    (['all', 'width', 'height'].includes(next.plane) || Number.isInteger(next.plane) && next.plane >= 0 && next.plane <= 9) &&
    ['uniform', 'importance'].includes(next.sampling) && GRID_SIZES.includes(next.grid) && POINT_COUNTS.includes(next.M) &&
    Number.isFinite(next.sigma) && next.sigma >= 1 && next.sigma <= 6 && typeof next.decode === 'boolean';
  if (!valid) return Promise.reject(new Error('Invalid CORDS MultiMNIST state.'));
  next.sigma = Math.round(next.sigma * 10) / 10;
  Object.assign(settings, next);
  decoder.cancel(); dirty = true;
  if (settings.decode) decoder.pending = true;
  invalidate();
  return new Promise((resolve) => waiters.push(resolve));
}

const invalidate = frameScheduler(renderFrame);

function loadImage() {
  if (!view || loadedScene === sceneKey()) return;
  const key = sceneKey(), id = ++imageId;
  loadedScene = key; imagePending = true;
  const finish = (pixels) => {
    if (id !== imageId) return;
    imagePixels = pixels; imagePending = false; visualDirty = true; invalidate();
  };
  if (imageCache.has(key)) { finish(imageCache.get(key)); return; }
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, 128, 128).data;
    const pixels = Uint8Array.from({ length: 128 * 128 }, (_, i) => rgba[4 * i]);
    imageCache.set(key, pixels); finish(pixels);
  };
  image.onerror = () => {
    if (id !== imageId) return;
    imagePending = false; imagePixels = null;
    $('#loading').textContent = 'The digit image could not load.'; $('#loading').hidden = false;
    invalidate();
  };
  image.src = model.data.png;
}

function renderFrame(time) {
  if (dirty) {
    dirty = false; computeFields(); loadImage(); startDecode(); syncControls(); visualDirty = true;
  }
  if (visualDirty && !imagePending && view && imagePixels) {
    const changed = visualScene !== sceneKey(); visualScene = sceneKey(); visualDirty = false;
    view.queueRebuild(changed, time);
  }
  const moving = view?.render(time) ?? false;
  if (moving) invalidate();
  if (!dirty && !decoder.pending && !imagePending && !moving) {
    const snapshot = state(); waiters.splice(0).forEach((resolve) => resolve(snapshot));
  }
}

function contours(values, grid, levelY) {
  const [height, width] = grid.gridShape;
  return marchingSquares(values, height, width, maxOf(values), LEVELS, (a, b, t) => {
    const ax = grid.coords.data[2 * a], ay = grid.coords.data[2 * a + 1];
    return pixelPoint(ax + t * (grid.coords.data[2 * b] - ax),
      ay + t * (grid.coords.data[2 * b + 1] - ay), levelY + .002);
  });
}

function fieldChannel(field, densityPlane = false) {
  if (densityPlane || settings.plane === 'all') return field.density;
  const channel = settings.plane === 'width' ? 10 : settings.plane === 'height' ? 11 : settings.plane;
  return Float64Array.from({ length: field.coords.rows }, (_, i) => field.features.data[i * 12 + channel]);
}

function fieldColor(field, i, densityPlane, rhoMax, point = false) {
  const rho = field.density[i], mass = clamp(rho / rhoMax);
  let t, lut;
  if (densityPlane) { t = mass; lut = luts.density; }
  else if (settings.plane === 'all') {
    const k = argmaxClass(field.features, i);
    if (!point) return [...luts.classes[k][255], mass < .02 ? 0 : Math.round(255 * mass ** .7)];
    t = mass; lut = luts.classes[k];
  } else {
    const channel = settings.plane === 'width' ? 10 : settings.plane === 'height' ? 11 : settings.plane;
    const normalizer = rhoMax * (channel === 10 ? model.maxWidth : channel === 11 ? model.maxHeight : 1);
    t = clamp(field.features.data[i * 12 + channel] / normalizer);
    lut = channel >= 10 ? luts.copper : luts.classes[channel];
  }
  return [...lut[Math.round(255 * (point ? .25 + .75 * t : t))], 255];
}

function makeTexture(data, size, coarse = false) {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // Row orientation is explicit in the plane UVs, including typed-array uploads.
  texture.magFilter = texture.minFilter = coarse ? THREE.NearestFilter : THREE.LinearFilter;
  texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}

function fieldTexture(densityPlane) {
  const size = gridFields.gridShape[0], bytes = new Uint8Array(size * size * 4), peak = maxOf(gridFields.density);
  for (let i = 0; i < size * size; i++) bytes.set(fieldColor(gridFields, i, densityPlane, peak), i * 4);
  const texture = makeTexture(bytes, size, size < 128);
  // encodePixelGrid centres are (step - 1)/2, half a pixel before texture texel centres.
  texture.offset.set(.5 / 128, .5 / 128);
  return texture;
}

function imageTexture() {
  const bytes = new Uint8Array(128 * 128 * 4);
  for (let i = 0; i < imagePixels.length; i++) bytes.set([...luts.image[imagePixels[i]], 255], i * 4);
  return makeTexture(bytes, 128);
}

function rectangle(box, y) {
  const [x0, y0, x1, y1] = box;
  const p = [pixelPoint(x0, y0, y), pixelPoint(x1, y0, y), pixelPoint(x1, y1, y), pixelPoint(x0, y1, y)];
  return p.flatMap((point, i) => [...point, ...p[(i + 1) % 4]]);
}

class MnistView {
  constructor(host, canvas, context) {
    this.host = host; this.canvas = canvas;
    this.renderer = createRenderer(canvas, context);
    host.prepend(canvas);
    canvas.setAttribute('aria-label', 'Digit boxes above their density and feature planes, linked through each box centre.');
    canvas.setAttribute('role', 'img');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, .01, 100);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false; this.controls.enableDamping = !reducedMotion.matches; this.controls.dampingFactor = .08;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    this.controls.addEventListener('change', invalidate);
    this.controls.addEventListener('start', () => { this.cameraTween = null; $('#box-tooltip').hidden = true; invalidate(); });
    this.labels = new CSS2DRenderer(); this.labels.domElement.className = 'plane-labels'; host.append(this.labels.domElement);
    this.content = new THREE.Group(); this.overlay = new THREE.Group(); this.scene.add(this.content, this.overlay);
    const hemi = new THREE.HemisphereLight('#ffffff', '#b9c2d0', .6);
    const key = new THREE.DirectionalLight('#ffffff', 1.1); key.position.set(-.6, 1, .8);
    const fill = new THREE.DirectionalLight('#ffffff', .35); fill.position.set(.8, .2, -.6);
    const ambient = new THREE.AmbientLight('#ffffff', .22);
    this.camera.add(key, fill); this.scene.add(this.camera, hemi, ambient);
    this.lights = [[hemi, .6], [key, 1.1], [fill, .35], [ambient, .22]];
    this.hitTargets = []; this.trueBoxes = []; this.pointMaterials = [];
    this.raycaster = new THREE.Raycaster(); this.raycaster.params.Line2 = { threshold: 5 };
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    this.bindInteraction(); this.resize();
  }

  line(positions, color, width = 1, opacity = 1, group = this.content, dashed = false, order = 4) {
    if (!positions.length) return null;
    const geometry = new LineSegmentsGeometry(); geometry.setPositions(positions);
    const material = new LineMaterial({ color, linewidth: width, transparent: true, opacity,
      depthWrite: false, toneMapped: false, dashed, dashSize: .045, gapSize: .03 });
    material.resolution.set(this.width || 1, this.height || 1);
    const line = new LineSegments2(geometry, material);
    line.computeLineDistances(); line.renderOrder = order; group.add(line); return line;
  }

  plane(y, texture = null, opacity = 1, order = 0) {
    const material = new THREE.MeshBasicMaterial({ color: texture ? '#ffffff' : palette.plane, map: texture,
      transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const geometry = new THREE.PlaneGeometry(1, 1);
    // The PNG and field arrays both start at the top-left; after rotation that is z = -0.5.
    if (texture) {
      const uv = geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y; mesh.renderOrder = order; this.content.add(mesh);
  }

  disc(x, y, level, color) {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(.012, 24), new THREE.MeshBasicMaterial({ color,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(...pixelPoint(x, y, level + .003));
    mesh.renderOrder = 4; this.content.add(mesh);
  }

  label(html, position, className, group = this.content, color = null) {
    // Labels contain only internal strings and digit classes.
    const element = document.createElement('span'); element.className = className; element.innerHTML = html;
    if (color) element.style.setProperty('--class-color', color);
    const label = new CSS2DObject(element); label.position.set(...position); label.center.set(0, .5);
    group.add(label); return label;
  }

  updatePlaneLabel() {
    if (!this.featureLabel) return;
    this.featureLabel.element.innerHTML = settings.plane === 'all'
      ? (this.width < 600 ? 'h(r)<br>all classes' : 'h(r) · all classes')
      : `h<sub>${settings.plane === 'width' ? 'w' : settings.plane === 'height' ? 'h' : settings.plane}</sub>(r)`;
  }

  addPoints(level, densityPlane) {
    const count = fields.coords.rows, positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
    const peak = maxOf(fields.density), color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      positions.set(pixelPoint(fields.coords.data[i * 2], fields.coords.data[i * 2 + 1], level + .004), i * 3);
      const rgba = fieldColor(fields, i, densityPlane, peak, true);
      color.setRGB(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, THREE.SRGBColorSpace).toArray(colors, i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { diameter: { value: settings.M >= 2048 ? .016 : .022 }, projectionScale: { value: 1 } },
      vertexShader: `uniform float diameter; uniform float projectionScale; varying vec3 pointColor;
        void main() { pointColor = color; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = diameter * projectionScale / -mvPosition.z; }`,
      fragmentShader: `varying vec3 pointColor;
        void main() { float radius = length(gl_PointCoord - vec2(0.5));
          if (radius > 0.5) discard;
          gl_FragColor = vec4(pointColor, 0.9 * (1.0 - smoothstep(0.43, 0.5, radius)));
          #include <colorspace_fragment>
        }`,
    });
    const points = new THREE.Points(geometry, material); points.renderOrder = 3;
    this.content.add(points); this.pointMaterials.push(material);
  }

  rebuild() {
    const previousBoxOpacity = this.trueBoxes[0]?.material.opacity ?? (settings.decode ? .45 : 1);
    disposeGroup(this.content); this.content.clear(); disposeGroup(this.overlay); this.overlay.clear();
    this.hitTargets = []; this.trueBoxes = []; this.pointMaterials = [];
    this.scene.background = new THREE.Color(palette.base);
    this.lights.forEach(([light, intensity]) => { light.intensity = intensity * (theme === 'dark' ? .9 : 1); });
    for (const y of [-GAP, 0]) {
      this.plane(y);
      if (settings.sampling === 'uniform') this.plane(y + .0005, fieldTexture(y === 0), .85, 1);
      const grid = [];
      for (let i = 1; i < 8; i++) {
        const t = i / 8 - .5;
        grid.push(-.5, y + .001, t, .5, y + .001, t, t, y + .001, -.5, t, y + .001, .5);
      }
      this.line(grid, palette.neutral, 1, .18, this.content, false, 2);
      this.line(contours(fieldChannel(gridFields, y === 0), gridFields, y), palette.text, 1, theme === 'dark' ? .30 : .22,
        this.content, false, 2);
      if (settings.sampling === 'importance') this.addPoints(y, y === 0);
    }
    this.plane(GAP, imageTexture(), 1, 5);
    for (const y of [-GAP, 0, GAP]) this.line(rectangle([0, 0, 128, 128], y + .001), palette.neutral, 1, .7,
      this.content, false, y === GAP ? 6 : 2);
    model.data.boxes.forEach((box, i) => {
      const color = palette.classes[model.data.labels[i]], [x, y] = model.data.centers[i];
      const trueBox = this.line(rectangle(box, GAP + .003), color, 1.5, previousBoxOpacity, this.content, false, 6);
      const stem = this.line([...pixelPoint(x, y, GAP), ...pixelPoint(x, y, -GAP)], color, 1.5, .75);
      const info = { index: i, decoded: false };
      trueBox.userData.hover = stem.userData.hover = info;
      this.trueBoxes.push(trueBox); this.hitTargets.push(trueBox, stem);
      this.disc(x, y, 0, color); this.disc(x, y, -GAP, color);
    });
    // The back-right corner is the rightmost point on screen at the default azimuth.
    this.label('image', [.5, GAP, -.5], 'plane-label');
    this.label('ρ(r)', [.5, 0, -.5], 'plane-label');
    this.featureLabel = this.label('', [.5, -GAP, -.5], 'plane-label');
    this.updatePlaneLabel();
    this.updateDecode(); this.updateProjection();
    $('#loading').hidden = true;
  }

  queueRebuild(changed, time) {
    if (changed && this.hasContent && !reducedMotion.matches) {
      this.fade = { start: time, rebuilt: false }; this.needsRebuild = true;
    } else {
      this.rebuild(); this.hasContent = true; this.needsRebuild = false;
      if (changed) this.fit(true);
      if (!this.shown) { this.shown = true; this.fade = { start: time - 120, rebuilt: true }; }
    }
  }

  updateDecode() {
    disposeGroup(this.overlay); this.overlay.clear();
    this.hitTargets = this.hitTargets.filter((line) => !line.userData.hover.decoded);
    const target = settings.decode ? .45 : 1;
    this.boxFade = { from: this.trueBoxes[0]?.material.opacity ?? target, to: target, start: performance.now() };
    if (!settings.decode || decoder.pending || !result || this.needsRebuild) return;
    for (let i = 0; i < result.count; i++) {
      const x = result.positions.data[2 * i], y = result.positions.data[2 * i + 1];
      const w = 128 * result.features.data[12 * i + 10], h = 128 * result.features.data[12 * i + 11];
      const digit = argmaxClass(result.features, i), color = palette.classes[digit];
      const box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
      const line = this.line(rectangle(box, GAP + .005), color, 2, 1, this.overlay, true, 7);
      line.userData.hover = { index: i, decoded: true }; this.hitTargets.push(line);
      this.label(String(digit), pixelPoint(box[0], box[1], GAP + .007), 'decoded-label', this.overlay, color);
      const ring = [];
      for (let k = 0; k < 48; k++) for (const angle of [k * Math.PI / 24, (k + 1) * Math.PI / 24]) {
        ring.push(x / 128 - .5 + .025 * Math.cos(angle), .005, y / 128 - .5 + .025 * Math.sin(angle));
      }
      this.line(ring, color, 2, .9, this.overlay, false, 5);
    }
  }

  updateProjection() {
    const scale = this.height * this.renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.pointMaterials.forEach((material) => { material.uniforms.projectionScale.value = scale; });
  }

  resize() {
    this.width = this.host.clientWidth; this.height = this.host.clientHeight;
    this.renderer.setSize(this.width, this.height, false); this.labels.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
    this.scene.traverse((object) => { if (object.material?.isLineMaterial) object.material.resolution.set(this.width, this.height); });
    this.updatePlaneLabel(); this.fit(false, true); this.updateProjection(); invalidate();
  }

  fit(animated = true, keepDirection = false) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const direction = keepDirection && offset.lengthSq() ? offset.normalize() :
      new THREE.Vector3(Math.sin(AZIMUTH) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.cos(AZIMUTH) * Math.cos(ELEVATION));
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const target = right.clone().multiplyScalar(LABEL_SHIFT);
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tan = Math.tan(THREE.MathUtils.degToRad(14));
    const widthFactor = .90;
    // Reserve text space at the feature label's anchor, including padding and a right margin.
    const labelSpace = this.width < 600 ? 80 : 130;
    const labelCorner = new THREE.Vector3(.5, -GAP, -.5).sub(target), labelDepth = labelCorner.dot(direction);
    const leftScale = tan * this.camera.aspect * widthFactor;
    const rightScale = tan * this.camera.aspect * (1 - 2 * labelSpace / this.width);
    let distance = 0;
    for (const x of [-.5, .5]) for (const y of [-GAP, GAP]) for (const z of [-.5, .5]) {
      const corner = new THREE.Vector3(x, y, z).sub(target), depth = corner.dot(direction);
      distance = Math.max(distance, depth + Math.abs(corner.dot(up)) / (tan * .86),
        depth + Math.abs(corner.dot(right)) / leftScale,
        (labelCorner.dot(right) - corner.dot(right) + leftScale * depth + rightScale * labelDepth) / (leftScale + rightScale));
    }
    // Shift the stack left when the labels need room, keeping the leftmost corner inside too.
    target.addScaledVector(right, Math.max(0, labelCorner.dot(right) - rightScale * (distance - labelDepth)));
    this.fitDistance = distance;
    this.controls.minDistance = distance * .75; this.controls.maxDistance = distance * 1.6;
    this.controls.enableDamping = false; this.controls.update(); this.controls.enableDamping = !reducedMotion.matches;
    this.controls.target.copy(target);
    const to = target.clone().addScaledVector(direction, distance);
    if (animated && !reducedMotion.matches) this.cameraTween = { from: this.camera.position.clone(), to, start: performance.now() };
    else { this.cameraTween = null; this.camera.position.copy(to); this.camera.lookAt(target); this.controls.update(); }
    invalidate();
  }

  render(time) {
    let moving = false;
    if (this.fade) {
      const elapsed = reducedMotion.matches ? 320 : time - this.fade.start;
      if (elapsed >= 120 && !this.fade.rebuilt) {
        this.needsRebuild = false; this.rebuild(); this.fade.rebuilt = true; this.fit(true);
      }
      const opacity = elapsed < 120 ? 1 - elapsed / 120 : clamp((elapsed - 120) / 200);
      this.canvas.style.opacity = opacity; this.labels.domElement.style.opacity = opacity;
      if (elapsed >= 320) this.fade = null; else moving = true;
    }
    if (this.cameraTween) {
      const t = reducedMotion.matches ? 1 : clamp((time - this.cameraTween.start) / 320);
      this.camera.position.lerpVectors(this.cameraTween.from, this.cameraTween.to, 1 - (1 - t) ** 3);
      if (t === 1) this.cameraTween = null; else moving = true;
    }
    if (this.boxFade) {
      const t = reducedMotion.matches ? 1 : clamp((time - this.boxFade.start) / 180);
      const opacity = this.boxFade.from + (this.boxFade.to - this.boxFade.from) * (1 - (1 - t) ** 3);
      this.trueBoxes.forEach((line) => { line.material.opacity = opacity; });
      if (t === 1) this.boxFade = null; else moving = true;
    }
    moving = this.controls.update() || moving;
    this.renderer.render(this.scene, this.camera); this.labels.render(this.scene, this.camera);
    return moving;
  }

  bindInteraction() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (event) => { down = [event.clientX, event.clientY]; });
    this.canvas.addEventListener('pointerup', () => { down = null; });
    this.canvas.addEventListener('pointercancel', () => { down = null; });
    this.canvas.addEventListener('pointerleave', () => { $('#box-tooltip').hidden = true; });
    this.canvas.addEventListener('pointermove', (event) => {
      if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 3) $('#drag-hint').hidden = true;
      if (down || event.pointerType === 'touch' || this.fade || dirty || imagePending || visualDirty) {
        $('#box-tooltip').hidden = true; return;
      }
      const rect = this.canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      this.raycaster.setFromCamera(new THREE.Vector2(x / rect.width * 2 - 1, 1 - y / rect.height * 2), this.camera);
      const hit = this.raycaster.intersectObjects(this.hitTargets, false)[0];
      const tooltip = $('#box-tooltip'); tooltip.hidden = !hit;
      if (!hit) return;
      const { index, decoded } = hit.object.userData.hover;
      let digit, cx, cy, w, h;
      if (decoded) {
        digit = argmaxClass(result.features, index); [cx, cy] = result.positions.data.slice(2 * index, 2 * index + 2);
        w = result.features.data[12 * index + 10] * 128; h = result.features.data[12 * index + 11] * 128;
      } else {
        digit = model.data.labels[index]; [cx, cy] = model.data.centers[index];
        [w, h] = model.data.sizes[index].map((v) => v * 128);
      }
      const format = (v) => decoded ? v.toFixed(1) : String(v);
      tooltip.textContent = `${decoded ? 'decoded' : 'digit'} ${digit} · centre (${format(cx)}, ${format(cy)}) · ${format(w)}×${format(h)} px`;
      tooltip.style.left = `${clamp(x + 12, 8, Math.max(8, rect.width - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${clamp(y + 12, 8, Math.max(8, rect.height - tooltip.offsetHeight - 8))}px`;
    });
    this.canvas.addEventListener('dblclick', () => this.fit());
    this.host.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || event.target !== this.host) return;
      event.preventDefault(); this.cameraTween = null;
      const sphere = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
      const step = 5 * Math.PI / 180;
      if (event.key === 'ArrowLeft') sphere.theta -= step;
      if (event.key === 'ArrowRight') sphere.theta += step;
      if (event.key === 'ArrowUp') sphere.phi -= step;
      if (event.key === 'ArrowDown') sphere.phi += step;
      sphere.makeSafe(); this.camera.position.setFromSpherical(sphere).add(this.controls.target); this.controls.update(); invalidate();
    });
  }
}

for (let k = 0; k < 10; k++) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'token';
  button.dataset.plane = String(k); button.dataset.class = String(k);
  button.setAttribute('aria-label', `Digit ${k} feature field`); button.setAttribute('aria-pressed', 'false');
  const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
  button.append(dot, String(k)); $('#class-chips').append(button);
}
document.querySelectorAll('[data-plane]').forEach((b) => b.addEventListener('click', () => set({ plane: /^\d$/.test(b.dataset.plane) ? Number(b.dataset.plane) : b.dataset.plane })));
document.querySelectorAll('[data-grid]').forEach((b) => b.addEventListener('click', () => set({ grid: Number(b.dataset.grid) })));
document.querySelectorAll('[data-sampling]').forEach((b) => b.addEventListener('click', () => set({ sampling: b.dataset.sampling })));
for (const selector of ['#class-chips', '#plane-chips', '#grid-chips', '#sampling']) {
  $(selector).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const buttons = [...$(selector).querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault(); const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    next.focus(); next.click(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}
$('#n').addEventListener('input', (e) => set({ n: Number(e.target.value) }));
$('#m').addEventListener('input', (e) => set({ M: POINT_COUNTS[Number(e.target.value)] }));
$('#sigma').addEventListener('input', (e) => set({ sigma: Number(e.target.value) }));
$('#new-scene').addEventListener('click', () => set({ seed: (settings.seed + 1) % 4 }));
$('#decode-toggle').addEventListener('click', () => set({ decode: !settings.decode }));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { document.activeElement?.blur(); $('#box-tooltip').hidden = true; } });
narrow.addEventListener('change', () => {
  syncNote(); visualDirty = true; view?.resize(); invalidate();
});
reducedMotion.addEventListener('change', () => { if (view) view.controls.enableDamping = !reducedMotion.matches; invalidate(); });

buildLuts();
const canvas = document.createElement('canvas');
const context = canvas.getContext('webgl2', { antialias: true });
if (context) view = new MnistView($('#viewport'), canvas, context);
else {
  $('#loading').textContent = 'This figure needs WebGL. ';
  const link = document.createElement('a'); link.textContent = 'View the paper figure PNG';
  link.href = 'https://raw.githubusercontent.com/stases/CORDS---ICLR-2026/main/figures/mnist_bbox_to_field_hr_aligned.png';
  $('#loading').append(link); $('#drag-hint').hidden = true;
}

followParentTheme((next) => {
  if (theme === next) return;
  theme = next; root.dataset.theme = theme; buildLuts(); visualDirty = true; invalidate();
});
reportHeight($('#explorer'));
window.cordsMnist = { set, state };
invalidate();
