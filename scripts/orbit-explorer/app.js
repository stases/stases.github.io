import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { defaultState, latticeMatrix, memberFracs, cellSites, bonds, polyhedra } from './geometry.js';

const DATA = window.ORBIT_EXPLORER_DATA;
const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const palettes = {
  light: ['#2F6DB5', '#D9542B', '#E0A526', '#1F9E89', '#B8407A'],
  dark: ['#5B9BE6', '#F07A52', '#F2BF4A', '#3FC4AD', '#E06AA6'],
};
const elements = {
  O: ['#E8452F', .48], F: ['#7BC043', .46], S: ['#E6C229', .62], Se: ['#D97B2A', .66],
  B: ['#E0A3A3', .50], Al: ['#B4B8C0', .60], Si: ['#C7A36B', .58], Mg: ['#5EB75E', .64],
  Ca: ['#6E8FD6', .78], Sc: ['#9C8AD9', .72], Ti: ['#8793A8', .68], Fe: ['#B85C3C', .66],
  Zn: ['#7D8B9E', .64], Zr: ['#5CAFA2', .76], Ag: ['#B9BEC6', .74], Sn: ['#7E96A8', .74],
  La: ['#4E7BBB', .86], Cs: ['#7A5EA8', .96],
};
const symbols = { alpha: 'α', beta: 'β', gamma: 'γ' };
// Ghost neighbours (outside the cell) are context only: small and close to the background.
const GHOST_RADIUS = .5, GHOST_FADE = .75, GHOST_BOND_FADE = .65, GHOST_BOND_WIDTH = .6;
const CELL_WIDTH = 2, CELL_WIDTH_SELECTED = 3, LOCI_WIDTH = 3, LOCI_EDGE_WIDTH = 2;
const LABEL_GAP = .45; // Å beyond the corner sphere
const variable = (name) => symbols[name] || name;
const expression = (s) => s.replace(/[xyz]/g, '<i>$&</i>');
const fmt = (n, digits = 4) => Number(n).toFixed(digits);
const plural = (count, noun) => `${noun}${count === 1 ? '' : 's'}`;
const orbitStyle = (i) => `--orbit-color:var(--o${i})`;
const dot = '<span class="dot" aria-hidden="true"></span>';
const swatch = '<span class="lattice-swatch" aria-hidden="true"></span>';
const endpointKey = (p) => `${p.orbit}/${p.member}/${p.image.join(',')}`;
let crystal, model, defaults, selected = null, hovered = null, selectedPrim = null;
let theme = root.dataset.theme, colourMode = 'orbit', showPolyhedra = true;
let view = null, frame = 0, geometryDirty = false, visualDirty = false;
let resetAnimation = null, colourAnimation = null, colourBlend = 0;
let primByMember = new Map();
let crystalTransition = null, crystalRequest = 0;

// All changes share one scheduler. It sleeps after controls and finite tweens settle.
function invalidate(geometry = false) {
  geometryDirty ||= geometry;
  visualDirty = true;
  if (!frame) frame = requestAnimationFrame(tick);
}
function tick(time) {
  frame = 0;
  if (resetAnimation) {
    const t = Math.min(1, (time - resetAnimation.start) / 320);
    const u = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    model.free = defaults.free.map((row, i) => row.map((v, j) => THREE.MathUtils.lerp(resetAnimation.from.free[i][j], v, u)));
    for (const name in model.lattice) model.lattice[name] = THREE.MathUtils.lerp(resetAnimation.from.lattice[name], defaults.lattice[name], u);
    if (t === 1) { model = defaultState(crystal); resetAnimation = null; }
    syncNumbers();
    geometryDirty = true;
  }
  if (colourAnimation) {
    const t = Math.min(1, (time - colourAnimation.start) / 180);
    colourBlend = THREE.MathUtils.lerp(colourAnimation.from, colourAnimation.to, 1 - (1 - t) ** 3);
    if (t === 1) colourAnimation = null;
    visualDirty = true;
  }
  if (geometryDirty) { view?.updateGeometry(); geometryDirty = false; visualDirty = true; }
  const moving = view?.step(time) || false;
  if (visualDirty || moving) { view?.refresh(); view?.render(); visualDirty = false; }
  if (resetAnimation || colourAnimation || moving) invalidate();
}
function edited() {
  return model.free.some((row, i) => row.some((v, j) => Math.abs(v - defaults.free[i][j]) > 1e-10))
    || Object.keys(model.lattice).some((name) => Math.abs(model.lattice[name] - defaults.lattice[name]) > 1e-10);
}
function selectCrystal(id) {
  const next = DATA.crystals.find((c) => c.id === id);
  if (!next) return;
  const request = ++crystalRequest;
  crystalTransition?.cancel();
  if (!crystal || reducedMotion.matches) { applyCrystal(next); return Promise.resolve(); }
  const canvas = view?.renderer.domElement || $('#panel');
  crystalTransition = canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
  return crystalTransition.finished.catch(() => {}).then(() => {
    if (request !== crystalRequest) return;
    crystalTransition.cancel(); applyCrystal(next);
    const options = { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' };
    crystalTransition = canvas.animate([{ opacity: 0 }, { opacity: 1 }], options);
    const panelTransition = $('#panel').animate([{ opacity: 0 }, { opacity: 1 }], options);
    return Promise.all([crystalTransition.finished, panelTransition.finished]).catch(() => {});
  });
}
function applyCrystal(next) {
  crystal = next;
  model = defaultState(crystal); defaults = defaultState(crystal);
  resetAnimation = null; hovered = null; selectedPrim = null;
  const first = crystal.orbits.findIndex((o) => o.d > 0);
  selected = first === -1 ? null : first;
  primByMember = new Map(crystal.atoms.map((a) => [`${a.orbit}/${a.member}`, a.prim_class]));
  buildPanel(); buildTokens(); buildTable(); syncSelection(); syncNumbers();
  $('#crystal-note').textContent = crystal.note;
  $('#cell-caption').textContent = `Conventional cell · ${crystal.counts.n_conv} ${plural(crystal.counts.n_conv, 'atom')}`;
  const polyhedraToggle = $('#polyhedra-toggle');
  const noPolyhedra = crystal.display.polyhedra.length === 0;
  polyhedraToggle.disabled = noPolyhedra;
  polyhedraToggle.setAttribute('aria-disabled', String(noPolyhedra));
  if (noPolyhedra) polyhedraToggle.title = 'No coordination polyhedra for this crystal';
  else polyhedraToggle.removeAttribute('title');
  $('#atom-tooltip').hidden = true;
  for (const button of $('#crystals').children) button.setAttribute('aria-pressed', String(button.dataset.crystal === crystal.id));
  view?.updateGeometry(); view?.fit(false);
  invalidate();
}
function selectOrbit(index, primitive = null, toggle = false) {
  if (index !== null && index !== 'lattice' && !crystal.orbits[index]) return;
  selected = toggle && selected === index ? null : index;
  selectedPrim = selected === null ? null : primitive;
  buildDetail(); syncSelection(); syncNumbers();
  view?.updateLoci(); invalidate();
}
function setFree(index, values) {
  const orbit = crystal.orbits[index];
  if (!orbit || values.length !== orbit.d || !values.every(Number.isFinite)) return;
  resetAnimation = null;
  model.free[index] = values.map((v) => Math.max(0, Math.min(.9995, v)));
  syncNumbers(); invalidate(true);
}
function setLattice(name, value) {
  const entry = crystal.lattice.free.find((f) => f.name === name);
  if (!entry || !Number.isFinite(value)) return;
  resetAnimation = null;
  const [min, max] = latticeRange(entry);
  model.lattice[name] = Math.max(min, Math.min(max, value));
  syncNumbers(); invalidate(true);
}
function latticeRange(f) { return f.unit === '°' ? [f.value - 10, f.value + 10] : [f.value * .85, f.value * 1.15]; }
function setToggle(name, on) {
  if (name === 'polyhedra') {
    if (crystal.display.polyhedra.length === 0) return;
    showPolyhedra = Boolean(on);
    $('#polyhedra-toggle').setAttribute('aria-checked', String(showPolyhedra));
  } else if (name === 'element' || name === 'orbit') {
    colourMode = (name === 'element' ? on : !on) ? 'element' : 'orbit';
    const to = colourMode === 'element' ? 1 : 0;
    colourAnimation = reducedMotion.matches ? null : { from: colourBlend, to, start: performance.now() };
    if (reducedMotion.matches) colourBlend = to;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === colourMode)));
  } else return;
  invalidate();
}
function setTheme(value) {
  if (value !== 'light' && value !== 'dark') return;
  theme = value; root.dataset.theme = theme;
  view?.applyTheme(); invalidate();
}
function setHover(value) {
  if (JSON.stringify(hovered) === JSON.stringify(value)) return;
  hovered = value;
  document.querySelectorAll('[data-orbit]').forEach((el) => {
    const sameOrbit = hovered && Number(el.dataset.orbit) === hovered.orbit;
    const sameAtom = !el.hasAttribute('data-prim') || hovered?.prim === undefined || Number(el.dataset.prim) === hovered.prim;
    const sameMember = !el.hasAttribute('data-member') || hovered?.member === undefined || Number(el.dataset.member) === hovered.member;
    el.classList.toggle('is-hovered', Boolean(sameOrbit && sameAtom && sameMember));
  });
  view?.beginHover(); invalidate();
}
function bindOrbit(el, orbit, member, prim) {
  const hover = () => setHover({ orbit, ...(member === undefined ? {} : { member }), ...(prim === undefined ? {} : { prim }) });
  el.addEventListener('pointerenter', hover); el.addEventListener('focus', hover);
  el.addEventListener('pointerleave', () => setHover(null)); el.addEventListener('blur', () => setHover(null));
  el.addEventListener('click', () => selectOrbit(orbit, prim ?? null, true));
}
function syncSelection() {
  document.querySelectorAll('[data-orbit][aria-pressed]').forEach((el) => {
    const chosen = Number(el.dataset.orbit) === selected && (!el.hasAttribute('data-prim') || selectedPrim === null || Number(el.dataset.prim) === selectedPrim);
    el.setAttribute('aria-pressed', String(chosen));
  });
  document.querySelectorAll('[data-lattice]').forEach((el) => el.setAttribute('aria-pressed', String(selected === 'lattice')));
}
function buildPanel() {
  const sg = crystal.space_group;
  $('#panel').innerHTML = `<div class="panel-title"><h2>${crystal.formula_html}</h2>${crystal.name === crystal.formula ? '' : `<span>${crystal.name}</span>`}</div>
    <div class="kicker">Space group</div><div class="space-symbol">${sg.symbol_html}</div>
    <div class="space-meta">No. ${sg.number} · ${sg.crystal_system} · ${sg.order} ${plural(sg.order, 'operation')}</div>
    <div class="kicker">Skeleton</div><div class="skeleton">${crystal.orbits.map((o, i) =>
      `<button class="orbit-row" data-orbit="${i}" aria-pressed="false" style="${orbitStyle(i)}">${dot}<strong>${o.species}</strong><span>${o.wyckoff}</span><span class="chart">${expression(o.chart)}</span><span class="multiplicity">×${o.multiplicity}</span></button>`).join('')}
      <button class="lattice-row" data-lattice aria-pressed="false">${swatch}<strong>L</strong><span>${crystal.lattice.free.map((f) => variable(f.name)).join(', ')}</span>${crystal.lattice.ties === 'none' ? '' : `<span class="lattice-ties">${crystal.lattice.ties}</span>`}</button></div><div id="detail" class="detail"></div>`;
  $('#panel').querySelectorAll('[data-orbit]').forEach((el) => bindOrbit(el, Number(el.dataset.orbit)));
  $('#panel').querySelector('[data-lattice]').addEventListener('click', () => selectOrbit('lattice', null, true));
  buildDetail();
}
function buildDetail() {
  const detail = $('#detail');
  if (selected === null) { detail.hidden = true; detail.innerHTML = ''; return; }
  detail.hidden = false;
  if (selected === 'lattice') {
    detail.style.setProperty('--orbit-color', 'var(--lattice)');
    detail.innerHTML = `<div class="kicker">Lattice</div>${crystal.lattice.free.map((f) => {
      const [min, max] = latticeRange(f);
      return `<label class="slider-row"><i>${variable(f.name)}</i><input type="range" data-lattice-input="${f.name}" aria-label="Lattice ${variable(f.name)} (${f.unit})" min="${min}" max="${max}" step="${f.unit === '°' ? .05 : .001}"><output></output></label>`;
    }).join('')}`;
    detail.querySelectorAll('input').forEach((el) => el.addEventListener('input', () => setLattice(el.dataset.latticeInput, Number(el.value))));
    return;
  }
  const o = crystal.orbits[selected];
  detail.style.setProperty('--orbit-color', `var(--o${selected})`);
  detail.innerHTML = `<div class="kicker"><span class="sym">${o.species}</span> on <span class="sym">${o.wyckoff}</span> · ${o.multiplicity} ${plural(o.multiplicity, 'atom')} · <span class="sym">${o.site_symmetry_html}</span></div>
    ${o.d === 0 ? '<p class="detail-copy">Fixed point · nothing to generate</p>' : o.d === 3 ? '<p class="detail-copy">Free in all three directions</p>' : ''}
    ${o.free_names.map((name, i) => `<label class="slider-row"><i>${name}</i><input type="range" data-free-input="${i}" aria-label="${o.species} ${o.wyckoff} coordinate ${name}" min="0" max="0.9995" step="0.0005"><output></output></label>`).join('')}
    <div class="kicker members-heading">${plural(o.members.length, 'Member')} · ${o.members.length}</div><div class="member-list">${o.members.map((m, j) => `<button class="member-row" aria-pressed="false" data-orbit="${selected}" data-member="${j}" title="${j === 0 ? 'representative' : m.label}"><span class="${j === 0 ? 'member-ring' : 'member-spacer'}" aria-hidden="true"></span><span class="member-label">${m.label}</span><span>${expression(m.expr)}</span></button>`).join('')}</div>`;
  detail.querySelectorAll('input').forEach((el) => el.addEventListener('input', () => {
    const values = [...model.free[selected]]; values[Number(el.dataset.freeInput)] = Number(el.value); setFree(selected, values);
  }));
  detail.querySelectorAll('[data-member]').forEach((el) => bindOrbit(el, selected, Number(el.dataset.member)));
}
function orbitToken(o, i) {
  return `<button class="token" data-orbit="${i}" aria-pressed="false" style="${orbitStyle(i)}">${dot}<span>${o.species} ${o.wyckoff}</span><span class="token-values">${o.free_names.map((name, j) => `<span><i>${name}</i> <span data-free-value="${i}/${j}"></span></span>`).join('')}</span><span class="multiplicity">×${o.multiplicity}</span></button>`;
}
function buildTokens() {
  const classes = new Set();
  const atoms = [...crystal.atoms].sort((a, b) => a.orbit - b.orbit || a.member - b.member).filter((a) => {
    if (classes.has(a.prim_class)) return false;
    classes.add(a.prim_class); return true;
  });
  // In P1 both encodings carry exactly the same per-site coordinate payload.
  const identical = crystal.space_group.number === 1;
  const atomChips = atoms.map((a) => identical ? orbitToken(crystal.orbits[a.orbit], a.orbit).replace('data-orbit=', `data-prim="${a.prim_class}" data-atom="${a.orbit}/${a.member}" data-orbit=`)
    : `<button class="token atom-token" data-orbit="${a.orbit}" data-prim="${a.prim_class}" data-atom="${a.orbit}/${a.member}" aria-pressed="false" style="${orbitStyle(a.orbit)}">${dot}${a.species}</button>`).join('');
  const latticeToken = (full) => `<button class="token token-lattice" data-lattice aria-pressed="false">${swatch}<span>L</span><span class="token-values">${full && !identical ? '<i>a b c α β γ</i>' : crystal.lattice.free.map((f) => `<span><i>${variable(f.name)}</i> <span data-lattice-value="${f.name}"></span></span>`).join('')}</span></button>`;
  $('#tokens').innerHTML = ['crystalite', 'orbitol'].map((kind) => {
    const count = crystal.counts[kind];
    return `<div class="token-row"><div class="token-heading"><span class="kicker">${kind} · ${kind === 'crystalite' ? 'Atoms' : 'Orbits'} as tokens</span><span class="token-count">${count.tokens} ${plural(count.tokens, 'token')} · ${count.coords} + ${count.lattice} ${plural(count.coords + count.lattice, 'number')}${kind === 'crystalite' && crystal.counts.n_cell !== crystal.counts.n_conv ? ' · primitive cell' : ''}</span></div><div class="token-scroll">${kind === 'crystalite' ? atomChips : crystal.orbits.map(orbitToken).join('')}${latticeToken(kind === 'crystalite')}</div></div>`;
  }).join('');
  $('#tokens').querySelectorAll('[data-orbit]').forEach((el) => bindOrbit(el, Number(el.dataset.orbit), undefined, el.hasAttribute('data-prim') ? Number(el.dataset.prim) : undefined));
  $('#tokens').querySelectorAll('[data-lattice]').forEach((el) => el.addEventListener('click', () => selectOrbit('lattice', null, true)));
}
function syncNumbers() {
  const isEdited = edited();
  $('#structure-badge').textContent = isEdited ? 'Edited · not the MP-20 structure' : `${crystal.material_id} · MP-20`;
  $('#structure-badge').classList.toggle('edited', isEdited); $('#reset').hidden = !isEdited;
  document.querySelectorAll('[data-free-value]').forEach((el) => { const [i, j] = el.dataset.freeValue.split('/'); el.textContent = fmt(model.free[i][j]); });
  document.querySelectorAll('[data-lattice-value]').forEach((el) => { el.textContent = fmt(model.lattice[el.dataset.latticeValue], el.dataset.latticeValue.length === 1 ? 3 : 2); });
  document.querySelectorAll('[data-free-input]').forEach((el) => {
    const j = Number(el.dataset.freeInput), value = model.free[selected][j];
    el.value = value; el.nextElementSibling.textContent = fmt(value);
    el.parentElement.classList.toggle('changed', Math.abs(value - defaults.free[selected][j]) > 1e-10);
  });
  document.querySelectorAll('[data-lattice-input]').forEach((el) => {
    const f = crystal.lattice.free.find((f) => f.name === el.dataset.latticeInput), value = model.lattice[f.name];
    el.value = value; el.nextElementSibling.textContent = `${fmt(value, f.unit === '°' ? 2 : 3)}${f.unit === '°' ? '' : ' '}${f.unit}`;
    el.parentElement.classList.toggle('changed', Math.abs(value - f.value) > 1e-10);
  });
  const fractions = crystal.orbits.map((o, i) => memberFracs(o, model.free[i]));
  document.querySelectorAll('[data-atom]').forEach((el) => {
    const [i, j] = el.dataset.atom.split('/');
    const coords = `(${fractions[i][j].map((n) => fmt(n)).join(', ')})`;
    el.title = coords; el.setAttribute('aria-label', `${crystal.orbits[i].members[j].label} · ${crystal.orbits[i].wyckoff} · ${coords}`);
  });
}
function buildTable() {
  $('#drawer-title').innerHTML = `Wyckoff positions · <span class="sym">${crystal.space_group.symbol_html}</span> · ${crystal.wyckoff_table.length} ${plural(crystal.wyckoff_table.length, 'row')}`;
  $('#wyckoff-rows').innerHTML = crystal.wyckoff_table.map((r) => `<tr ${r.occupied_by.length ? `class="occupied" style="${orbitStyle(r.occupied_by[0])}" tabindex="0" data-occupied="${r.occupied_by[0]}" aria-label="Select ${r.occupied_by.map((i) => crystal.orbits[i].species).join(', ')} on ${r.wyckoff}"` : ''}><td>${r.multiplicity}</td><td>${r.letter}</td><td>${r.site_symmetry_html}</td><td>${expression(r.representative)}</td><td>${r.d}</td><td><span class="occupants">${r.occupied_by.map((i) => `<span style="${orbitStyle(i)}">${dot} ${crystal.orbits[i].species}</span>`).join('')}</span></td></tr>`).join('');
  $('#wyckoff-rows').querySelectorAll('[data-occupied]').forEach((el) => {
    const choose = () => selectOrbit(Number(el.dataset.occupied), null, true);
    el.addEventListener('click', choose);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  });
}

class CrystalView {
  constructor(host, canvas) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    host.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, .1, 1000);
    this.camera.up.set(0, 0, 1);
    this.scene.add(this.camera);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = !reducedMotion.matches;
    this.controls.dampingFactor = .08;
    this.controls.addEventListener('change', () => invalidate());
    this.controls.addEventListener('start', () => { this.cameraTween = null; invalidate(); });
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'axis-labels';
    host.append(this.labels.domElement);
    this.axisLabels = ['a', 'b', 'c'].map((name) => {
      const el = document.createElement('span'); el.className = 'axis-label'; el.textContent = name;
      const label = new CSS2DObject(el); this.scene.add(label); return label;
    });
    const hemi = new THREE.HemisphereLight('#FFFFFF', '#B9C2D0', .6);
    const key = new THREE.DirectionalLight('#FFFFFF', 1.1); key.position.set(-.6, 1, .8); this.camera.add(key);
    const fill = new THREE.DirectionalLight('#FFFFFF', .35); fill.position.set(.8, .2, -.6); this.camera.add(fill);
    const ambient = new THREE.AmbientLight('#FFFFFF', .22);
    this.scene.add(hemi, ambient, key.target, fill.target);
    this.lights = [[hemi, .6], [key, 1.1], [fill, .35], [ambient, .22]];
    this.sphereGeometry = new THREE.SphereGeometry(1, 40, 28);
    this.sphereMaterial = new THREE.MeshStandardMaterial({ roughness: .5, metalness: 0 });
    this.bondGeometry = new THREE.CylinderGeometry(.075, .075, 1, 12);
    this.bondMaterial = new THREE.MeshStandardMaterial({ roughness: .7, metalness: 0 });
    this.cell = this.fatLines([], CELL_WIDTH, 1); this.cell.renderOrder = 4;
    this.lociLines = this.fatLines([], LOCI_WIDTH, .85); this.lociLines.renderOrder = 3;
    this.lociEdges = this.fatLines([], LOCI_EDGE_WIDTH, .6); this.lociEdges.renderOrder = 3;
    this.lociFill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: .16, side: THREE.DoubleSide, depthWrite: false }));
    this.lociFill.renderOrder = 2; this.scene.add(this.lociFill);
    this.polyPool = [];
    this.ringCanvas = document.createElement('canvas'); this.ringCanvas.width = this.ringCanvas.height = 128;
    this.ringTexture = new THREE.CanvasTexture(this.ringCanvas);
    this.ringTexture.colorSpace = THREE.SRGBColorSpace;
    this.ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ringTexture, transparent: true, opacity: .9, depthWrite: false }));
    this.scene.add(this.ring);
    this.sites = []; this.spheres = []; this.links = []; this.polys = [];
    this.hoverScales = []; this.hoverUntil = 0;
    this.matrixHelper = new THREE.Object3D();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.applyTheme();
    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    reducedMotion.addEventListener('change', () => { this.controls.enableDamping = !reducedMotion.matches; invalidate(); });
    this.resize();
  }
  fatLines(positions, width, opacity) {
    const material = new LineMaterial({ linewidth: width, transparent: true, opacity, depthWrite: false });
    const line = new LineSegments2(new LineSegmentsGeometry(), material);
    line.frustumCulled = false; line.visible = positions.length > 0;
    if (positions.length) line.geometry.setPositions(positions);
    this.scene.add(line); return line;
  }
  linePositions(line, positions) {
    line.visible = positions.length > 0;
    if (!positions.length) return;
    const data = line.geometry.getAttribute('instanceStart')?.data;
    if (data?.array.length === positions.length) { data.array.set(positions); data.needsUpdate = true; }
    else { line.geometry.dispose(); line.geometry = new LineSegmentsGeometry().setPositions(positions); }
    line.geometry.computeBoundingSphere();
  }
  instanced(name, geometry, material, count) {
    let mesh = this[name];
    if (!mesh || mesh.instanceMatrix.count < count) {
      if (mesh) { this.scene.remove(mesh); mesh.dispose(); }
      mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, 2 ** Math.ceil(Math.log2(count || 1))));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false;
      this.scene.add(mesh); this[name] = mesh;
    }
    mesh.count = count; return mesh;
  }
  toCart(f) { return new THREE.Vector3(...[0, 1, 2].map((j) => f.reduce((sum, v, i) => sum + v * this.M[i][j], 0))); }
  applyTheme() {
    const dark = theme === 'dark';
    this.background = new THREE.Color(dark ? '#0A0F1C' : '#EEF2F7');
    this.scene.background = this.background;
    this.neutral = new THREE.Color(dark ? '#A3AFC2' : '#5F6E84');
    this.bondColour = new THREE.Color(dark ? '#3E4A60' : '#B4BCC8');
    this.textColour = new THREE.Color(dark ? '#EEF3FF' : '#0F172A');
    this.lights.forEach(([light, intensity]) => { light.intensity = intensity * (dark ? .9 : 1); });
    this.ringSignature = ''; invalidate();
  }
  resize() {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (!width || !height) return;
    const oldAspect = this.camera.aspect;
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false); this.labels.setSize(width, height);
    [this.cell, this.lociLines, this.lociEdges].forEach((line) => line.material.resolution.set(width, height));
    if (this.spheres.length && Math.abs(oldAspect - this.camera.aspect) > .01) this.fit(false, true);
    invalidate();
  }
  updateGeometry() {
    this.M = latticeMatrix(crystal, model.lattice);
    this.sites = cellSites(crystal, model);
    // One neighbour shell per atom: bonds to outside the cell and coordination
    // polyhedra are drawn around the primary image only, so corner and face
    // copies carry no second shell of ghosts.
    const primary = (site) => site.image.every((v) => v === 0);
    this.links = bonds(crystal, model, this.sites).filter((b) => (b.a.site !== -1 && b.b.site !== -1) || primary(this.sites[b.a.site !== -1 ? b.a.site : b.b.site]));
    this.polys = polyhedra(crystal, model, this.sites).filter((p) => primary(this.sites[p.center]));
    const ghosts = new Map();
    const remember = (p) => { if (p.site === -1) ghosts.set(endpointKey(p), { ...p, species: crystal.orbits[p.orbit].species, ghost: true }); };
    this.links.forEach((b) => { remember(b.a); remember(b.b); });
    this.polys.forEach((p) => p.ligands.forEach(remember));
    this.spheres = [...this.sites, ...ghosts.values()];
    this.instanced('atomMesh', this.sphereGeometry, this.sphereMaterial, this.spheres.length);
    const bondMesh = this.instanced('bondMesh', this.bondGeometry, this.bondMaterial, this.links.length);
    const axis = new THREE.Vector3(0, 1, 0), helper = this.matrixHelper;
    this.links.forEach((b, i) => {
      const a = new THREE.Vector3(...b.a.cart), end = new THREE.Vector3(...b.b.cart);
      helper.position.copy(a).add(end).multiplyScalar(.5);
      helper.quaternion.setFromUnitVectors(axis, end.sub(a).normalize());
      const thin = b.a.site === -1 || b.b.site === -1 ? GHOST_BOND_WIDTH : 1;
      helper.scale.set(thin, b.length, thin); helper.updateMatrix(); bondMesh.setMatrixAt(i, helper.matrix);
    });
    bondMesh.instanceMatrix.needsUpdate = true;
    this.corners = Array.from({ length: 8 }, (_, n) => this.toCart([n & 1, (n >> 1) & 1, (n >> 2) & 1]));
    const edges = [];
    this.corners.forEach((a, i) => { for (const bit of [1, 2, 4]) if (!(i & bit)) edges.push(...a.toArray(), ...this.corners[i | bit].toArray()); });
    this.linePositions(this.cell, edges);
    this.axisLabels.forEach((label, i) => {
      const corner = this.corners[1 << i], direction = corner.clone().sub(this.corners[0]).normalize();
      let occupied = 0;
      for (const p of this.sites) if (new THREE.Vector3(...p.cart).distanceTo(corner) < .3) occupied = Math.max(occupied, elements[p.species][1]);
      label.position.copy(corner).addScaledVector(direction, occupied + LABEL_GAP);
    });
    const center = this.toCart([.5, .5, .5]);
    const shift = center.clone().sub(this.controls.target);
    this.camera.position.add(shift); this.controls.target.copy(center);
    this.lights.forEach(([light]) => { if (light.target) light.target.position.copy(center); });
    this.updatePolyhedra(); this.updateLoci(); this.refresh();
    this.atomMesh.computeBoundingSphere();
  }
  // Polyhedra need new triangulation after edits. Keep meshes/materials and reuse
  // GPU buffers whenever the topology size is unchanged.
  replaceGeometry(object, fresh) {
    const old = object.geometry;
    const names = Object.keys(fresh.attributes);
    if (!old.index && !fresh.index && names.length === Object.keys(old.attributes).length
        && names.every((name) => old.getAttribute(name)?.array.length === fresh.getAttribute(name).array.length)) {
      for (const name of names) { old.attributes[name].array.set(fresh.attributes[name].array); old.attributes[name].needsUpdate = true; }
      old.computeBoundingSphere(); fresh.dispose();
    } else { old.dispose(); object.geometry = fresh; }
  }
  updatePolyhedra() {
    this.polyPool.forEach((p) => { p.fill.visible = p.edges.visible = false; });
    let used = 0;
    for (const poly of this.polys) {
      const points = poly.ligands.map((p) => new THREE.Vector3(...p.cart));
      if (points.length < 4) continue;
      // At slider endpoints a shell can collapse to a plane or line.
      const a = points[0]; let normal = null;
      for (let i = 1; i < points.length - 1 && !normal; i++) for (let j = i + 1; j < points.length; j++) {
        const n = points[i].clone().sub(a).cross(points[j].clone().sub(a));
        if (n.lengthSq() > 1e-12) { normal = n.normalize(); break; }
      }
      if (!normal || !points.some((p) => Math.abs(p.clone().sub(a).dot(normal)) > 1e-6)) continue;
      let entry = this.polyPool[used++];
      if (!entry) {
        const fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ flatShading: true, roughness: .7, side: THREE.DoubleSide, transparent: true, opacity: .2, depthWrite: false }));
        const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: .5, depthWrite: false }));
        fill.renderOrder = 1; edges.renderOrder = 2;
        this.scene.add(fill, edges); entry = { fill, edges }; this.polyPool.push(entry);
      }
      const hull = new ConvexGeometry(points);
      this.replaceGeometry(entry.edges, new THREE.EdgesGeometry(hull));
      this.replaceGeometry(entry.fill, hull);
      entry.orbit = this.sites[poly.center].orbit; entry.active = true;
      entry.fill.visible = entry.edges.visible = showPolyhedra;
    }
    this.polyPool.forEach((entry, i) => { entry.active = i < used; });
  }
  updateLoci() {
    if (!this.M) return;
    const signature = `${crystal.id}/${selected}/${this.M.flat().join(',')}`;
    if (this.lociSignature === signature) return;
    this.lociSignature = signature;
    const orbit = typeof selected === 'number' ? crystal.orbits[selected] : null;
    const lines = [], edges = [], triangles = [], seen = new Set();
    for (const locus of orbit?.loci || []) {
      for (const segment of locus.segments || []) {
        const key = segment.map((p) => p.join(',')).sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key); segment.forEach((p) => lines.push(...this.toCart(p).toArray()));
      }
      for (const polygon of locus.polygons || []) {
        const key = polygon.map((p) => p.join(',')).sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const points = polygon.map((p) => this.toCart(p).toArray());
        points.forEach((p, i) => edges.push(...p, ...points[(i + 1) % points.length]));
        for (let i = 1; i < points.length - 1; i++) triangles.push(...points[0], ...points[i], ...points[i + 1]);
      }
    }
    this.linePositions(this.lociLines, lines); this.linePositions(this.lociEdges, edges);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
    this.replaceGeometry(this.lociFill, geometry); this.lociFill.visible = triangles.length > 0;
  }
  beginHover() { this.hoverUntil = reducedMotion.matches ? 0 : performance.now() + 150; }
  refresh() {
    if (!this.atomMesh) return;
    const orbitSelected = typeof selected === 'number';
    const helper = this.matrixHelper;
    helper.quaternion.identity();
    this.spheres.forEach((p, i) => {
      const info = elements[p.species];
      const colour = new THREE.Color(palettes[theme][p.orbit]).lerp(new THREE.Color(info[0]), colourBlend);
      if (p.ghost) colour.lerp(this.background, GHOST_FADE);
      if (orbitSelected && p.orbit !== selected) colour.lerp(this.background, .65);
      if (!p.ghost && hovered?.orbit === p.orbit) colour.lerp(new THREE.Color('#FFFFFF'), .12);
      this.atomMesh.setColorAt(i, colour);
      const prim = primByMember.get(`${p.orbit}/${p.member}`);
      const specific = !p.ghost && hovered?.orbit === p.orbit && ((hovered.member !== undefined && hovered.member === p.member) || (hovered.member === undefined && hovered.prim !== undefined && hovered.prim === prim));
      const target = specific ? 1.12 : 1;
      const remaining = Math.max(0, this.hoverUntil - performance.now()) / 150;
      const scale = remaining ? THREE.MathUtils.lerp(this.hoverScales[i] || 1, target, .35) : target;
      this.hoverScales[i] = scale;
      helper.position.fromArray(p.cart); helper.scale.setScalar(info[1] * (p.ghost ? GHOST_RADIUS : scale));
      helper.updateMatrix(); this.atomMesh.setMatrixAt(i, helper.matrix);
    });
    this.atomMesh.instanceMatrix.needsUpdate = true; if (this.atomMesh.instanceColor) this.atomMesh.instanceColor.needsUpdate = true;
    this.links.forEach((b, i) => {
      const colour = this.bondColour.clone();
      if (b.a.site === -1 || b.b.site === -1) colour.lerp(this.background, GHOST_BOND_FADE);
      if (orbitSelected && (b.a.orbit !== selected || b.b.orbit !== selected)) colour.lerp(this.background, .5);
      this.bondMesh.setColorAt(i, colour);
    });
    if (this.bondMesh.instanceColor) this.bondMesh.instanceColor.needsUpdate = true;
    this.polyPool.forEach((p) => {
      p.fill.visible = p.edges.visible = p.active && showPolyhedra;
      if (!p.active) return;
      p.fill.material.color.set(palettes[theme][p.orbit]); p.edges.material.color.copy(p.fill.material.color);
      p.fill.material.opacity = orbitSelected && selected !== p.orbit ? .07 : .2;
      p.edges.material.opacity = orbitSelected && selected !== p.orbit ? .14 : .4;
    });
    this.cell.material.color.copy(selected === 'lattice' ? this.textColour : this.neutral);
    this.cell.material.linewidth = selected === 'lattice' ? CELL_WIDTH_SELECTED : CELL_WIDTH;
    if (orbitSelected) {
      const colour = palettes[theme][selected];
      this.lociLines.material.color.set(colour); this.lociEdges.material.color.set(colour); this.lociFill.material.color.set(colour);
      const frac = memberFracs(crystal.orbits[selected], model.free[selected])[0];
      this.ring.position.copy(this.toCart(frac));
      const radius = elements[crystal.orbits[selected].species][1] * 1.35;
      this.ring.scale.setScalar(radius * 2);
      const pixels = radius * this.host.clientHeight / (2 * this.camera.position.distanceTo(this.ring.position) * Math.tan(Math.PI / 12));
      const stroke = Math.min(16, 128 / Math.max(1, pixels));
      const signature = `${colour}/${stroke.toFixed(1)}`;
      if (signature !== this.ringSignature) {
        const ctx = this.ringCanvas.getContext('2d'); ctx.clearRect(0, 0, 128, 128);
        ctx.strokeStyle = colour; ctx.lineWidth = stroke; ctx.beginPath(); ctx.arc(64, 64, 64 - stroke / 2, 0, Math.PI * 2); ctx.stroke();
        this.ringTexture.needsUpdate = true; this.ringSignature = signature;
      }
    }
    this.ring.visible = orbitSelected;
  }
  fit(animated = true, keepDirection = false) {
    if (!this.spheres.length) return;
    const target = this.toCart([.5, .5, .5]);
    // Frame the cell (corners plus the largest cell-site sphere); the faint ghost shell may
    // spill slightly, so it only counts at 90%.
    let cell = 0, sphere = 0, shell = 0;
    for (const c of this.corners) cell = Math.max(cell, c.distanceTo(target));
    for (const p of this.sites) sphere = Math.max(sphere, elements[p.species][1]);
    for (const p of this.spheres) if (p.ghost) shell = Math.max(shell, new THREE.Vector3(...p.cart).distanceTo(target) + elements[p.species][1] * GHOST_RADIUS);
    const radius = Math.max(cell + sphere, shell * .9);
    const halfAngle = Math.min(Math.PI / 12, Math.atan(Math.tan(Math.PI / 12) * this.camera.aspect));
    this.fitDistance = radius / Math.sin(halfAngle) * 1.02;
    const az = THREE.MathUtils.degToRad(crystal.display.view.azimuth), el = THREE.MathUtils.degToRad(crystal.display.view.elevation);
    const direction = keepDirection ? this.camera.position.clone().sub(this.controls.target).normalize() : new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
    const position = target.clone().addScaledVector(direction, this.fitDistance);
    this.controls.minDistance = this.fitDistance * .75; this.controls.maxDistance = this.fitDistance * 1.6;
    this.camera.near = .1; this.camera.far = this.fitDistance * 12; this.camera.updateProjectionMatrix();
    // Clear any residual damping before a reset or refit.
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update(); this.controls.enableDamping = damping;
    this.controls.target.copy(target);
    if (animated && !reducedMotion.matches) this.cameraTween = { from: this.camera.position.clone(), to: position, start: performance.now() };
    else { this.cameraTween = null; this.camera.position.copy(position); this.camera.lookAt(target); }
    invalidate();
  }
  step(time) {
    let moving = false;
    if (this.cameraTween) {
      const t = Math.min(1, (time - this.cameraTween.start) / 320);
      this.camera.position.lerpVectors(this.cameraTween.from, this.cameraTween.to, 1 - (1 - t) ** 3);
      if (t === 1) this.cameraTween = null;
      moving = true;
    }
    moving = this.controls.update() || moving;
    return moving || time < this.hoverUntil;
  }
  render() { this.renderer.render(this.scene, this.camera); this.labels.render(this.scene, this.camera); }
  pick(event) {
    if (!this.atomMesh) return null;
    const box = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.atomMesh).find((h) => h.instanceId < this.sites.length);
    return hit ? this.sites[hit.instanceId] : null;
  }
  bindPointer() {
    const canvas = this.renderer.domElement;
    let start = null, dragged = false, touches = new Set(), multiTouch = false, lastTap = 0;
    canvas.addEventListener('pointerdown', (e) => { touches.add(e.pointerId); multiTouch ||= touches.size > 1; start = [e.clientX, e.clientY]; dragged = false; });
    canvas.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 4) { dragged = true; $('#drag-hint').hidden = true; }
      if (dragged || e.pointerType === 'touch') { setHover(null); $('#atom-tooltip').hidden = true; return; }
      const hit = this.pick(e), tip = $('#atom-tooltip');
      canvas.style.cursor = hit ? 'pointer' : '';
      if (!hit) { setHover(null); tip.hidden = true; return; }
      const o = crystal.orbits[hit.orbit], m = o.members[hit.member];
      setHover({ orbit: hit.orbit, member: hit.member, prim: primByMember.get(`${hit.orbit}/${hit.member}`) });
      tip.textContent = `${m.label} · ${o.wyckoff} · ${m.expr}`; tip.hidden = false;
      const box = this.host.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(8, Math.min(e.clientY - box.top + 12, box.height - tip.offsetHeight - 8))}px`;
    });
    canvas.addEventListener('pointerup', (e) => {
      touches.delete(e.pointerId);
      if (start && !dragged && !multiTouch) {
        const hit = this.pick(e); selectOrbit(hit?.orbit ?? null, null, true);
        if (e.pointerType === 'touch') { const now = performance.now(); if (now - lastTap < 320) this.fit(); lastTap = now; }
      }
      start = null; if (!touches.size) multiTouch = false;
    });
    canvas.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); start = null; multiTouch = false; });
    canvas.addEventListener('pointerleave', () => { setHover(null); $('#atom-tooltip').hidden = true; });
    canvas.addEventListener('dblclick', () => this.fit());
    this.host.addEventListener('keydown', (e) => {
      if (e.target !== this.host || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const offset = this.camera.position.clone().sub(this.controls.target);
      const rotation = new THREE.Quaternion().setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
      const spherical = new THREE.Spherical().setFromVector3(offset.applyQuaternion(rotation));
      const delta = THREE.MathUtils.degToRad(5);
      if (e.key === 'ArrowLeft') spherical.theta -= delta;
      if (e.key === 'ArrowRight') spherical.theta += delta;
      if (e.key === 'ArrowUp') spherical.phi -= delta;
      if (e.key === 'ArrowDown') spherical.phi += delta;
      spherical.makeSafe(); offset.setFromSpherical(spherical).applyQuaternion(rotation.invert());
      this.camera.position.copy(this.controls.target).add(offset); invalidate();
    });
  }
}

// UI, automation and keyboard controls all dispatch the same state changes.
$('#crystals').innerHTML = DATA.crystals.map((c, i) => `<button class="crystal-chip${i && DATA.crystals[i - 1].space_group.family !== c.space_group.family ? ' system-start' : ''}" data-crystal="${c.id}" aria-label="${c.formula} · ${c.name}" aria-pressed="false">${c.formula_html}</button>`).join('');
$('#crystals').querySelectorAll('button').forEach((button, index, buttons) => {
  button.addEventListener('click', () => selectCrystal(button.dataset.crystal));
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = buttons[(index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); selectCrystal(next.dataset.crystal);
  });
});
$('#polyhedra-toggle').addEventListener('click', () => setToggle('polyhedra', !showPolyhedra));
document.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', () => setToggle(el.dataset.mode, true)));
$('#reset').addEventListener('click', () => {
  if (reducedMotion.matches) { model = defaultState(crystal); syncNumbers(); invalidate(true); }
  else { resetAnimation = { from: structuredClone(model), start: performance.now() }; invalidate(); }
});
$('#drawer-toggle').addEventListener('click', () => {
  const open = $('#drawer-toggle').getAttribute('aria-expanded') !== 'true';
  $('#drawer-toggle').setAttribute('aria-expanded', String(open));
  $('#drawer-action').textContent = open ? 'Hide' : 'Show';
  $('#wyckoff-content').classList.toggle('open', open); $('#wyckoff-content').inert = !open;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') selectOrbit(null); });

const canvas = document.createElement('canvas');
// Test context availability before constructing the renderer to avoid a noisy
// renderer exception on devices where WebGL is disabled.
const context = canvas.getContext('webgl2', { antialias: true });
if (context) {
  view = new CrystalView($('#viewport'), canvas);
} else {
  const message = document.createElement('p'); message.className = 'webgl-message';
  message.textContent = 'The 3D view needs WebGL. You can still explore the orbits, coordinates and tokens below.';
  $('#viewport').append(message); $('#drag-hint').hidden = true;
}
selectCrystal(DATA.meta.default);

const query = new URLSearchParams(location.search);
if (!['light', 'dark'].includes(query.get('theme'))) {
  const system = matchMedia('(prefers-color-scheme: dark)');
  let source = null;
  try { source = window.frameElement?.closest('[data-theme]') || (window.frameElement && parent.document.body); } catch (_) { /* Cross-origin: use system theme. */ }
  const followTheme = () => setTheme(['light', 'dark'].includes(source?.dataset.theme) ? source.dataset.theme : system.matches ? 'dark' : 'light');
  if (source) new MutationObserver(followTheme).observe(source, { attributes: true, attributeFilter: ['data-theme'] });
  system.addEventListener('change', followTheme); followTheme();
}
if (query.get('embed') === '1' && window.parent !== window) {
  let pending = 0, lastHeight = 0;
  const postHeight = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      // Measure content, not the iframe's viewport, so a closed drawer can shrink it.
      const height = Math.ceil($('#explorer').getBoundingClientRect().bottom + window.scrollY);
      if (height !== lastHeight) { lastHeight = height; parent.postMessage({ type: 'orbit-explorer:height', height }, '*'); }
    });
  };
  new ResizeObserver(postHeight).observe($('#explorer'));
  document.fonts.ready.then(postHeight); postHeight();
}
window.orbitExplorer = {
  selectCrystal,
  selectOrbit: (index) => selectOrbit(index),
  setFree,
  setLattice,
  setToggle,
  setTheme,
  state: () => structuredClone({ crystal: crystal.id, selectedOrbit: typeof selected === 'number' ? selected : null,
    latticeSelected: selected === 'lattice', selectedPrim, free: model.free, lattice: model.lattice,
    edited: edited(), theme, toggles: { polyhedra: showPolyhedra, element: colourMode === 'element' } }),
};
