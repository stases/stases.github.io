import * as THREE from 'three';

/** Format an integer with spaces between groups of three digits. */
export function integerText(value) { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

/** Interpolate stops in linear light, returning linear colours and 256 sRGB triples. */
export function colorRamp(stops) {
  const colors = stops.map((color) => new THREE.Color(color)), linear = [], srgb = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (colors.length - 1), k = Math.min(colors.length - 2, Math.floor(t));
    const color = colors[k].clone().lerp(colors[k + 1], t - k);
    linear.push(color);
    const encoded = color.clone().convertLinearToSRGB();
    srgb.push([encoded.r, encoded.g, encoded.b].map((v) => Math.round(255 * v)));
  }
  return { linear, srgb };
}

/** Extract row-major contours; crossing(a, b, t) maps sample indices to a 3D point. */
export function marchingSquares(values, height, width, peak, levels, crossing) {
  const segments = [];
  if (!(peak > 0)) return segments;
  const cases = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]],
    7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]], 11: [[2, 1]], 12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]] };
  for (const fraction of levels) {
    const threshold = peak * fraction;
    for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
      const ids = [y * width + x, y * width + x + 1, (y + 1) * width + x + 1, (y + 1) * width + x];
      const v = ids.map((i) => values[i]);
      const code = v.reduce((mask, value, i) => mask | (value >= threshold ? 1 << i : 0), 0);
      if (code === 0 || code === 15) continue;
      let pairs = cases[code];
      if (code === 5 || code === 10) {
        const centreAbove = (v[0] + v[1] + v[2] + v[3]) / 4 >= threshold;
        pairs = (code === 5) === centreAbove ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      }
      const point = (edge) => {
        const next = (edge + 1) % 4;
        return crossing(ids[edge], ids[next], (threshold - v[edge]) / (v[next] - v[edge]));
      };
      for (const [a, b] of pairs) segments.push(...point(a), ...point(b));
    }
  }
  return segments;
}

/** Coalesce invalidations into one frame, allowing the callback to schedule another. */
export function frameScheduler(callback) {
  let frame = 0;
  return () => {
    if (!frame) frame = requestAnimationFrame((time) => { frame = 0; callback(time); });
  };
}

/** Set up the renderer settings common to both figures. */
export function createRenderer(canvas, context) {
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  return renderer;
}

/** Release a group's GPU resources and labels, leaving group ownership to the caller. */
export function disposeGroup(group) {
  if (!group) return;
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of object.material ? [].concat(object.material) : []) {
      materials.add(material); if (material.map) textures.add(material.map);
    }
    if (object.isInstancedMesh) object.dispose();
    if (object.isCSS2DObject) object.element.remove();
  });
  geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose());
}

/** Decode copied fields with stale-reply protection and observable pending state. */
export function createDecodeClient({ result, error }) {
  let worker = null, requestId = 0;
  const terminate = () => { worker?.terminate(); worker = null; };
  const fail = (message) => { client.pending = false; terminate(); error(message); };
  const client = {
    pending: false,
    cancel() {
      requestId++;
      if (client.pending) terminate();
      client.pending = false;
    },
    start(fields, seed) {
      const id = ++requestId;
      client.pending = true;
      try {
        if (!worker) {
          worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
          const currentWorker = worker;
          worker.onmessage = ({ data }) => {
            if (worker !== currentWorker || data.id !== requestId) return;
            client.pending = false;
            result(data);
          };
          worker.onerror = (event) => {
            event.preventDefault();
            if (worker !== currentWorker) return;
            fail(event.message || 'The decode worker could not start.');
          };
          worker.onmessageerror = () => {
            if (worker === currentWorker) fail('Worker reply could not be read.');
          };
        }
        // Transfer copies: live arrays still feed the scene and the public hook.
        const copy = structuredClone(fields);
        worker.postMessage({ id, fields: copy, seed },
          [copy.coords.data.buffer, copy.density.buffer, copy.features.data.buffer, copy.weights.buffer]);
      } catch (failure) { fail(failure.message); }
    },
  };
  return client;
}

/** Follow the embedding theme or system preference unless ?theme= fixes it. */
export function followParentTheme(apply) {
  if (['light', 'dark'].includes(new URLSearchParams(location.search).get('theme'))) return;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let source = null;
  try {
    source = window.frameElement?.closest('[data-theme]') || (window.frameElement && parent.document.body);
  } catch (_) { /* Cross-origin embeds follow the system theme. */ }
  const update = () => {
    const inherited = source?.dataset.theme;
    apply(['light', 'dark'].includes(inherited) ? inherited : system.matches ? 'dark' : 'light');
  };
  if (source) new MutationObserver(update).observe(source, { attributes: true, attributeFilter: ['data-theme'] });
  system.addEventListener('change', update); update();
}

/** Report embedded figure height after layout, font loading, and resizes. */
export function reportHeight(element) {
  if (new URLSearchParams(location.search).get('embed') !== '1' || window.parent === window) return;
  const postHeight = frameScheduler(() => {
    parent.postMessage({ type: 'cords-figure:height', height: document.documentElement.scrollHeight }, '*');
  });
  new ResizeObserver(postHeight).observe(element);
  document.fonts.ready.then(postHeight); window.addEventListener('load', postHeight); postHeight();
}
