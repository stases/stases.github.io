// Acceptance test for scripts/orbit-explorer/geometry.js (pure ES module, no DOM, no three.js).
// Run from the repository root:  node scripts/orbit-explorer/test_geometry.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "geometry.js"), "utf8");
if (/^\s*import\s/m.test(src)) throw new Error("geometry.js must not import anything");
const G = await import(`data:text/javascript,${encodeURIComponent(src)}`);
const text = fs.readFileSync(path.join(here, "crystals.js"), "utf8").trim();
const DATA = JSON.parse(text.slice("window.ORBIT_EXPLORER_DATA = ".length).replace(/;\s*$/, ""));
const byId = Object.fromEntries(DATA.crystals.map((c) => [c.id, c]));

let failures = 0;
const fail = (msg) => { failures += 1; if (failures <= 60) console.log("  -", msg); };
const check = (cond, msg) => { if (!cond) fail(msg); return cond; };
const pdist = (a, b) => Math.max(...a.map((x, i) => { const d = x - b[i]; return Math.abs(d - Math.round(d)); }));
const norm = (v) => Math.hypot(...v);
const angle = (u, v) => (Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / norm(u) / norm(v)) * 180) / Math.PI;
const params = (M) => [norm(M[0]), norm(M[1]), norm(M[2]), angle(M[1], M[2]), angle(M[0], M[2]), angle(M[0], M[1])];

for (const name of ["defaultState", "latticeMatrix", "memberFracs", "cellSites", "bonds", "polyhedra"]) {
  check(typeof G[name] === "function", `geometry.js must export ${name}()`);
}

// 1. Defaults reproduce the data exactly.
for (const c of DATA.crystals) {
  const s = G.defaultState(c);
  check(Array.isArray(s.free) && s.free.length === c.orbits.length, `${c.id}: defaultState().free has one entry per orbit`);
  check(c.lattice.free.every((f) => Math.abs(s.lattice[f.name] - f.value) < 1e-9), `${c.id}: defaultState().lattice`);
  const M = G.latticeMatrix(c, s.lattice);
  check(M.every((row, i) => row.every((x, j) => Math.abs(x - c.lattice.matrix[i][j]) < 1e-3)),
    `${c.id}: latticeMatrix(default) != lattice.matrix`);
  c.orbits.forEach((o, k) => {
    const fr = G.memberFracs(o, s.free[k]);
    check(fr.length === o.multiplicity, `${c.id} orbit ${k}: memberFracs length`);
    fr.forEach((f, j) => {
      check(pdist(f, o.members[j].frac) < 1e-5, `${c.id} orbit ${k} member ${j}: memberFracs != frac`);
      check(f.every((x) => x >= 0 && x < 1), `${c.id} orbit ${k} member ${j}: memberFracs outside [0,1)`);
    });
  });
}

// 2. Editing a free coordinate moves every member through its own map.
{
  const o = byId.rutile.orbits.find((x) => x.wyckoff === "4f");
  const want = [[0.35, 0.35, 0], [0.65, 0.65, 0], [0.15, 0.85, 0.5], [0.85, 0.15, 0.5]];
  const got = G.memberFracs(o, [0.35]);
  want.forEach((w, j) => check(pdist(got[j], w) < 1e-9, `rutile 4f at x=0.35: member ${j} ${got[j]} != ${w}`));
  const lasco = byId.lasco3.orbits.find((x) => x.d === 3);
  const moved = G.memberFracs(lasco, [0.1, 0.2, 0.3]);
  lasco.members.forEach((m, j) => {
    const f = [0, 1, 2].map((i) => m.v[i] + m.W[i][0] * 0.1 + m.W[i][1] * 0.2 + m.W[i][2] * 0.3);
    check(pdist(moved[j], f) < 1e-9, `lasco3 8d member ${j}: W u + v not honoured`);
  });
}

// 3. The lattice token only has the family's free entries; ties are enforced.
{
  const cases = [
    ["rutile", { a: 5, c: 3 }, [5, 5, 3, 90, 90, 90]],
    ["zno", { a: 3, c: 5 }, [3, 3, 5, 90, 90, 120]],
    ["cab6", { a: 4.5 }, [4.5, 4.5, 4.5, 90, 90, 90]],
    ["lasco3", { a: 5.5, b: 7.9, c: 5.7 }, [5.5, 7.9, 5.7, 90, 90, 90]],
    ["zro2", { a: 5.2, b: 5.3, c: 5.4, beta: 100 }, [5.2, 5.3, 5.4, 90, 100, 90]],
    ["cssnf3", { a: 5, b: 6, c: 7, alpha: 80, beta: 95, gamma: 110 }, [5, 6, 7, 80, 95, 110]],
  ];
  for (const [id, lat, want] of cases) {
    const M = G.latticeMatrix(byId[id], lat);
    const got = params(M);
    check(got.every((x, i) => Math.abs(x - want[i]) < 1e-6), `${id}: latticeMatrix(${JSON.stringify(lat)}) gives ${got.map((x) => x.toFixed(4))}`);
    check(Math.abs(M[0][1]) < 1e-12 && Math.abs(M[0][2]) < 1e-12 && Math.abs(M[1][2]) < 1e-12, `${id}: matrix must be lower triangular`);
  }
}

// 4. Cell contents include periodic images on faces, edges and corners. An atom within EDGE (fractional)
// of a face is also drawn at the opposite face, so near-boundary atoms (ZnO's Zn at z = 0.0006) look right.
const EDGE = 0.02;
const siteKey = (s) => `${s.orbit}/${s.member}/${s.image.join(",")}`;
for (const c of DATA.crystals) {
  const s = G.defaultState(c);
  const M = G.latticeMatrix(c, s.lattice);
  const sites = G.cellSites(c, s);
  let expected = 0;
  c.orbits.forEach((o, k) => G.memberFracs(o, s.free[k]).forEach((f) => {
    expected += f.reduce((n, x) => n * (x < EDGE || x > 1 - EDGE ? 2 : 1), 1);
  }));
  check(sites.length === expected, `${c.id}: cellSites gives ${sites.length}, expected ${expected} with boundary images`);
  check(new Set(sites.map(siteKey)).size === sites.length, `${c.id}: duplicate sites`);
  for (const t of sites) {
    check(t.frac.every((x) => x > -EDGE - 1e-12 && x < 1 + EDGE + 1e-12), `${c.id}: site outside the cell window`);
    const cart = [0, 1, 2].map((j) => t.frac[0] * M[0][j] + t.frac[1] * M[1][j] + t.frac[2] * M[2][j]);
    check(norm(cart.map((x, j) => x - t.cart[j])) < 1e-6, `${c.id}: site cart != frac . M`);
    check(t.species === c.orbits[t.orbit].species, `${c.id}: site species`);
  }
}
check(G.cellSites(byId.rutile, G.defaultState(byId.rutile)).length === 15, "rutile: 9 Ti (corners + centre) + 6 O sites");
check(G.cellSites(byId.cab6, G.defaultState(byId.cab6)).length === 14, "cab6: 8 Ca corners + 6 B sites");

// 5. Bonds and polyhedra reproduce the first coordination shells.
const CN = {
  cab6: [["B", "B", 5]], ag2o: [["Ag", "O", 2], ["O", "Ag", 4]], pyrite: [["Fe", "S", 6], ["S", "S", 1]],
  spinel: [["Mg", "O", 4], ["Al", "O", 6]], rutile: [["Ti", "O", 6]], fese: [["Fe", "Se", 4]],
  zno: [["Zn", "O", 4]], quartz: [["Si", "O", 4]], lasco3: [["Sc", "O", 6]], zro2: [["Zr", "O", 7]],
  cssnf3: [["Sn", "F", 3]],
};
const endKey = (e) => `${e.orbit}/${e.member}/${e.image.join(",")}`;
for (const c of DATA.crystals) {
  const s = G.defaultState(c);
  const sites = G.cellSites(c, s);
  const bonds = G.bonds(c, s, sites);
  const seen = new Set();
  for (const b of bonds) {
    const k = [endKey(b.a), endKey(b.b)].sort().join("|");
    check(!seen.has(k), `${c.id}: bond listed twice`);
    seen.add(k);
    check(b.a.site >= 0 || b.b.site >= 0, `${c.id}: bond with neither end in the cell`);
    check(Math.abs(norm(b.a.cart.map((x, j) => x - b.b.cart[j])) - b.length) < 1e-6, `${c.id}: bond length`);
  }
  for (const [a, bSp, n] of CN[c.id]) {
    sites.forEach((t, i) => {
      if (t.species !== a || t.image.some((x) => x !== 0)) return;
      const count = bonds.filter((b) => (b.a.site === i && c.orbits[b.b.orbit].species === bSp)
        || (b.b.site === i && c.orbits[b.a.orbit].species === bSp)).length;
      check(count === n, `${c.id}: ${a} site ${i} has ${count} ${bSp} bonds, expected ${n}`);
    });
  }
  const polys = G.polyhedra(c, s, sites);
  for (const rule of c.display.polyhedra) {
    const n = CN[c.id].find(([a, b]) => (a === rule.center && b === rule.ligand) || (a === rule.ligand && b === rule.center));
    const want = n && n[0] === rule.center ? n[2] : null;
    const base = polys.filter((p) => sites[p.center].species === rule.center && sites[p.center].image.every((x) => x === 0));
    check(base.length > 0, `${c.id}: no ${rule.center}-${rule.ligand} polyhedra`);
    if (want) base.forEach((p) => check(p.ligands.length === want, `${c.id}: ${rule.center} polyhedron has ${p.ligands.length} ligands, expected ${want}`));
  }
}

// 6. Edited states stay consistent: moving rutile's O orbit moves every O site.
{
  const c = byId.rutile, s = G.defaultState(c);
  const k = c.orbits.findIndex((o) => o.wyckoff === "4f");
  s.free[k] = [0.25];
  const sites = G.cellSites(c, s).filter((t) => t.orbit === k);
  check(sites.every((t) => pdist(t.frac, G.memberFracs(c.orbits[k], [0.25])[t.member]) < 1e-9), "rutile edited: O sites follow x");
}

if (failures) {
  console.log(`FAIL: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`OK: geometry checks passed for ${DATA.crystals.length} crystals`);
