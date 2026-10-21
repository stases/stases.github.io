// Fractional coordinates multiply the lattice's row vectors on the left.
const mod1 = (x) => ((x % 1) + 1) % 1;
const cartesian = (f, M) => [0, 1, 2].map((j) => f.reduce((s, x, i) => s + x * M[i][j], 0));
const key = (p) => `${p.orbit}/${p.member}/${p.image.join(',')}`;

export function defaultState(crystal) {
  return {
    free: crystal.orbits.map((o) => [...o.free_values]),
    lattice: Object.fromEntries(crystal.lattice.free.map((f) => [f.name, f.value])),
  };
}

export function latticeMatrix(crystal, lattice) {
  const p = { ...crystal.lattice.parameters };
  for (const f of crystal.lattice.free) p[f.name] = lattice[f.name] ?? f.value;
  const family = crystal.space_group.family;
  if (family === 'cubic') p.b = p.c = p.a;
  if (family === 'tetragonal' || family === 'hexagonal') p.b = p.a;
  if (family !== 'triclinic') p.alpha = p.gamma = 90;
  if (family !== 'triclinic' && family !== 'monoclinic') p.beta = 90;
  if (family === 'hexagonal') p.gamma = 120;
  const [ca, cb, cg] = [p.alpha, p.beta, p.gamma].map((v) => Math.cos(v * Math.PI / 180));
  const sg = Math.sin(p.gamma * Math.PI / 180);
  const cy = (ca - cb * cg) / sg;
  return [[p.a, 0, 0], [p.b * cg, p.b * sg, 0],
    [p.c * cb, p.c * cy, p.c * Math.sqrt(Math.max(0, 1 - cb * cb - cy * cy))]];
}

export function memberFracs(orbit, values) {
  return orbit.members.map((m) => m.W.map((row, i) => mod1(m.v[i] + row.reduce((s, w, j) => s + w * values[j], 0))));
}

export function cellSites(crystal, state) {
  const M = latticeMatrix(crystal, state.lattice);
  const sites = [];
  crystal.orbits.forEach((o, orbit) => memberFracs(o, state.free[orbit]).forEach((f, member) => {
    const images = f.map((x) => [0, ...(x <= 0.02 ? [1] : []), ...(x >= 0.98 ? [-1] : [])]);
    for (const i of images[0]) for (const j of images[1]) for (const k of images[2]) {
      const image = [i, j, k];
      const frac = f.map((x, a) => x + image[a]);
      sites.push({ orbit, member, species: o.species, image, frac, cart: cartesian(frac, M) });
    }
  }));
  return sites;
}

// Reciprocal-vector norms bound each fractional displacement for a Cartesian
// cutoff. Unlike a fixed image cube, this also covers strongly skewed cells.
function neighbourhood(crystal, state, sites) {
  const M = latticeMatrix(crystal, state.lattice);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const reciprocal = [cross(M[1], M[2]), cross(M[2], M[0]), cross(M[0], M[1])];
  const volume = Math.abs(M[0].reduce((s, v, i) => s + v * reciprocal[0][i], 0));
  const bounds = reciprocal.map((v) => Math.hypot(...v) / volume);
  const indices = new Map(sites.map((p, i) => [key(p), i]));
  const members = crystal.orbits.flatMap((o, orbit) => memberFracs(o, state.free[orbit]).map((frac, member) => ({ orbit, member, species: o.species, frac })));
  return (center, species, cutoff) => {
    const found = [];
    for (const m of members) {
      if (m.species !== species) continue;
      const lo = m.frac.map((x, i) => Math.ceil(center.frac[i] - x - cutoff * bounds[i] - 1e-9));
      const hi = m.frac.map((x, i) => Math.floor(center.frac[i] - x + cutoff * bounds[i] + 1e-9));
      for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
        const image = [i, j, k];
        const frac = m.frac.map((x, a) => x + image[a]);
        const cart = cartesian(frac, M);
        const length = Math.hypot(...cart.map((x, a) => x - center.cart[a]));
        if (length < 1e-8 || length > cutoff + 1e-9) continue;
        const endpoint = { orbit: m.orbit, member: m.member, image, frac, cart };
        endpoint.site = indices.get(key(endpoint)) ?? -1;
        found.push({ endpoint, length });
      }
    }
    return found;
  };
}

export function bonds(crystal, state, sites) {
  const neighbours = neighbourhood(crystal, state, sites);
  const result = [], seen = new Set();
  for (const rule of crystal.display.bonds) sites.forEach((p, site) => {
    const species = p.species === rule.a ? rule.b : p.species === rule.b ? rule.a : null;
    if (species === null) return;
    const a = { ...p, site };
    for (const { endpoint: b, length } of neighbours(p, species, rule.max)) {
      const id = [key(a), key(b)].sort().join('|');
      if (!seen.has(id)) {
        seen.add(id);
        result.push({ a, b, length, rule });
      }
    }
  });
  return result;
}

export function polyhedra(crystal, state, sites) {
  const neighbours = neighbourhood(crystal, state, sites);
  return crystal.display.polyhedra.flatMap((rule) => sites.flatMap((p, center) =>
    p.species === rule.center ? [{ center, ligands: neighbours(p, rule.ligand, rule.max).map((n) => n.endpoint), rule }] : []));
}
