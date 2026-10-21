#!/usr/bin/env python3
"""Acceptance check for scripts/orbit-explorer/crystals.js (the Wyckoff-orbit explorer data).

Checks the exported crystals independently of make_data.py: schema, counts, member maps,
symmetry invariance, lattice ties, loci, the Wyckoff table, and a match against the
MP-20 structure itself.

Run from the repository root:
  python scripts/orbit-explorer/check_data.py   (MP20_RAW as for make_data.py)
"""
import csv
import json
import os
import sys
from pathlib import Path

import numpy as np
import spglib
from pymatgen.analysis.structure_matcher import StructureMatcher
from pymatgen.core import Lattice, Structure

HERE = Path(__file__).resolve().parent
DATA = HERE / "crystals.js"
MP20 = Path(os.environ.get("MP20_RAW", Path.home() / "GitHub/crystalite/data/mp20/raw"))
PREFIX = "window.ORBIT_EXPLORER_DATA = "

EXPECTED = [
    ("cab6", "mp-865", 221), ("ag2o", "mp-353", 224), ("pyrite", "mp-226", 205),
    ("spinel", "mp-3536", 227), ("rutile", "mp-2657", 136), ("fese", "mp-20311", 129),
    ("zno", "mp-2133", 186), ("quartz", "mp-7000", None), ("lasco3", "mp-31116", 62),
    ("zro2", "mp-2858", 14), ("cssnf3", "mp-998298", 1),
]
FREE_LATTICE = {
    "cubic": ["a"], "tetragonal": ["a", "c"], "hexagonal": ["a", "c"],
    "orthorhombic": ["a", "b", "c"], "monoclinic": ["a", "b", "c", "beta"],
    "triclinic": ["a", "b", "c", "alpha", "beta", "gamma"],
}
CRYSTAL_KEYS = {"id", "name", "formula", "formula_html", "material_id", "split", "note", "space_group",
                "lattice", "counts", "orbits", "atoms", "wyckoff_table", "display"}
SG_KEYS = {"number", "symbol", "symbol_html", "family", "crystal_system", "point_group", "point_group_html",
           "centring", "order", "hall_number", "polar", "operations"}
ORBIT_KEYS = {"index", "species", "Z", "row_id", "wyckoff", "letter", "multiplicity", "multiplicity_prim",
              "site_symmetry", "site_symmetry_html", "d", "free_names", "free_values", "chart", "chart_raw",
              "members", "loci"}
MEMBER_KEYS = {"label", "expr", "expr_raw", "W", "v", "frac", "prim"}

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
    return cond


def pdist(a, b):
    """Largest componentwise periodic difference between fractional points."""
    d = np.asarray(a, float) - np.asarray(b, float)
    return float(np.max(np.abs(d - np.rint(d))))


def lattice_params(m):
    m = np.asarray(m, float)
    a, b, c = np.linalg.norm(m, axis=1)
    ang = lambda u, v: np.degrees(np.arccos(np.dot(u, v) / np.linalg.norm(u) / np.linalg.norm(v)))
    return a, b, c, ang(m[1], m[2]), ang(m[0], m[2]), ang(m[0], m[1])


def on_locus(point, W, v):
    """True if point = W t + v (mod 1) for some real t."""
    W = np.asarray(W, float)
    for n in np.array(np.meshgrid(*[range(-2, 3)] * 3)).T.reshape(-1, 3):
        rhs = np.asarray(point, float) + n - np.asarray(v, float)
        t, *_ = np.linalg.lstsq(W, rhs, rcond=None)
        if np.max(np.abs(W @ t - rhs)) < 1e-6:
            return True
    return False


def cell_images(f):
    """The point and its periodic images that lie in the closed cell [0, 1]^3."""
    f = np.asarray(f, float)
    out = []
    for n in np.array(np.meshgrid(*[range(-1, 2)] * 3)).T.reshape(-1, 3):
        g = f + n
        if np.all(g > -1e-9) and np.all(g < 1 + 1e-9):
            out.append(g)
    return out


def piece_contains(piece, p, tol=1e-6):
    """Point on a segment (two vertices) or inside a planar convex polygon (three or more)."""
    P = np.asarray(piece, float)
    if len(P) == 2:
        a, b = P
        ab = b - a
        s = np.clip(np.dot(p - a, ab) / max(np.dot(ab, ab), 1e-30), 0.0, 1.0)
        return np.linalg.norm(a + s * ab - p) < tol
    normal = np.cross(P[1] - P[0], P[2] - P[0])
    for i in range(2, len(P) - 1):
        if np.linalg.norm(normal) > 1e-12:
            break
        normal = np.cross(P[1] - P[0], P[i + 1] - P[0])
    normal /= np.linalg.norm(normal)
    if abs(np.dot(p - P[0], normal)) > tol:
        return False
    signs = [np.dot(np.cross(P[(i + 1) % len(P)] - P[i], p - P[i]), normal) for i in range(len(P))]
    return all(s > -tol for s in signs) or all(s < tol for s in signs)


def load():
    text = DATA.read_text().strip()
    check(text.startswith(PREFIX), f"{DATA.name} must start with '{PREFIX}'")
    body = text[len(PREFIX):].rstrip().rstrip(";")
    return json.loads(body)


def mp20_rows():
    csv.field_size_limit(10**9)
    rows = {}
    want = {mp for _, mp, _ in EXPECTED}
    for split in ("train", "val", "test"):
        with open(MP20 / f"{split}.csv", newline="") as fh:
            for row in csv.DictReader(fh):
                if row["material_id"] in want:
                    rows[row["material_id"]] = (split, row)
    return rows


def check_crystal(c, mp):
    cid = c.get("id", "?")
    check(CRYSTAL_KEYS <= set(c), f"{cid}: missing keys {sorted(CRYSTAL_KEYS - set(c))}")
    sg, lat, counts, orbits, atoms = c["space_group"], c["lattice"], c["counts"], c["orbits"], c["atoms"]
    check(SG_KEYS <= set(sg), f"{cid}: space_group missing {sorted(SG_KEYS - set(sg))}")
    check(isinstance(c["note"], str) and len(c["note"]) > 20, f"{cid}: note missing")

    # Lattice: matrix, parameters, ties, free entries.
    M = np.asarray(lat["matrix"], float)
    check(M.shape == (3, 3) and abs(np.linalg.det(M)) > 1e-3, f"{cid}: bad lattice matrix")
    p = lat["parameters"]
    got = lattice_params(M)
    want = (p["a"], p["b"], p["c"], p["alpha"], p["beta"], p["gamma"])
    check(np.allclose(got[:3], want[:3], atol=2e-4) and np.allclose(got[3:], want[3:], atol=2e-3),
          f"{cid}: lattice parameters {want} disagree with matrix {np.round(got, 4)}")
    check(abs(M[0, 1]) < 1e-9 and abs(M[0, 2]) < 1e-9 and abs(M[1, 2]) < 1e-9,
          f"{cid}: matrix must be lower triangular (a along x, b in the xy plane)")
    latent = np.asarray(lat["latent"], float)
    rebuilt = np.array([[np.exp(latent[0]), 0, 0], [latent[1], np.exp(latent[2]), 0],
                        [latent[3], latent[4], np.exp(latent[5])]])
    check(np.allclose(rebuilt, M, atol=2e-4), f"{cid}: matrix is not ltri_to_lattice(latent)")
    fam = sg["family"]
    check(fam in FREE_LATTICE, f"{cid}: unknown family {fam}")
    names = [f["name"] for f in lat["free"]]
    check(names == FREE_LATTICE.get(fam), f"{cid}: free lattice entries {names} for {fam}")
    for f in lat["free"]:
        check(abs(f["value"] - p[f["name"]]) < 2e-3, f"{cid}: free {f['name']} {f['value']} != {p[f['name']]}")
    a, b, cc, al, be, ga = want
    ties = {
        "cubic": abs(a - b) < 1e-3 and abs(a - cc) < 1e-3 and max(abs(al - 90), abs(be - 90), abs(ga - 90)) < 1e-3,
        "tetragonal": abs(a - b) < 1e-3 and max(abs(al - 90), abs(be - 90), abs(ga - 90)) < 1e-3,
        "hexagonal": abs(a - b) < 1e-3 and max(abs(al - 90), abs(be - 90)) < 1e-3 and abs(ga - 120) < 1e-3,
        "orthorhombic": max(abs(al - 90), abs(be - 90), abs(ga - 90)) < 1e-3,
        "monoclinic": max(abs(al - 90), abs(ga - 90)) < 1e-3,
        "triclinic": True,
    }
    check(ties.get(fam, False), f"{cid}: lattice violates the {fam} ties: {np.round(want, 4)}")
    check(isinstance(lat.get("ties"), str), f"{cid}: lattice.ties must be a string")

    # Operations of the group in the conventional cell.
    ops = sg["operations"]
    check(len(ops) == sg["order"], f"{cid}: {len(ops)} operations but order {sg['order']}")
    Rs = [np.asarray(o["R"], float) for o in ops]
    ts = [np.asarray(o["t"], float) for o in ops]

    # Orbits and members.
    check(counts["n_orbits"] == len(orbits), f"{cid}: n_orbits")
    for k, o in enumerate(orbits):
        check(ORBIT_KEYS <= set(o), f"{cid} orbit {k}: missing {sorted(ORBIT_KEYS - set(o))}")
        d = o["d"]
        check(o["index"] == k, f"{cid} orbit {k}: index")
        check(len(o["free_names"]) == d and len(o["free_values"]) == d, f"{cid} orbit {k}: free length")
        check(o["wyckoff"] == f"{o['multiplicity']}{o['letter']}", f"{cid} orbit {k}: wyckoff label")
        check(len(o["members"]) == o["multiplicity"], f"{cid} orbit {k}: member count")
        check(sum(m["prim"] for m in o["members"]) == o["multiplicity_prim"], f"{cid} orbit {k}: prim count")
        u = np.asarray(o["free_values"], float)
        for j, m in enumerate(o["members"]):
            check(MEMBER_KEYS <= set(m), f"{cid} orbit {k} member {j}: missing {sorted(MEMBER_KEYS - set(m))}")
            W = np.asarray(m["W"], float).reshape(3, d)
            check(np.allclose(W, np.rint(W)), f"{cid} orbit {k} member {j}: W not integer")
            f = (W @ u if d else np.zeros(3)) + np.asarray(m["v"], float)
            check(pdist(f, m["frac"]) < 1e-5, f"{cid} orbit {k} member {j}: frac != W u + v")
            check(all(0 <= x < 1 for x in m["frac"]), f"{cid} orbit {k} member {j}: frac outside [0,1)")
        # The members are exactly the images of the first member under the group.
        rep = np.asarray(o["members"][0]["frac"], float)
        images = [np.mod(R @ rep + t, 1.0) for R, t in zip(Rs, ts)]
        for j, m in enumerate(o["members"]):
            check(min(pdist(im, m["frac"]) for im in images) < 1e-5,
                  f"{cid} orbit {k} member {j}: not an image of the representative")
        for im in images:
            check(min(pdist(im, m["frac"]) for m in o["members"]) < 1e-5,
                  f"{cid} orbit {k}: an image of the representative is not a member")
        # Loci of the free coordinates.
        if d in (0, 3):
            check(o["loci"] is None, f"{cid} orbit {k}: loci must be null for d={d}")
        else:
            key = "segments" if d == 1 else "polygons"
            check(isinstance(o["loci"], list) and len(o["loci"]) == o["multiplicity"],
                  f"{cid} orbit {k}: one locus per member")
            for j, (m, locus) in enumerate(zip(o["members"], o["loci"] or [])):
                pieces = locus.get(key, [])
                check(len(pieces) > 0, f"{cid} orbit {k} member {j}: empty locus")
                W = np.asarray(m["W"], float).reshape(3, d)
                for piece in pieces:
                    check(len(piece) == 2 if d == 1 else len(piece) >= 3, f"{cid} orbit {k} member {j}: bad piece")
                    for pt in piece:
                        check(all(-1e-9 <= x <= 1 + 1e-9 for x in pt), f"{cid} orbit {k}: locus point outside cell")
                        check(on_locus(pt, W, m["v"]), f"{cid} orbit {k} member {j}: point {pt} off its locus")
                check(any(piece_contains(piece, im) for piece in pieces for im in cell_images(m["frac"])),
                      f"{cid} orbit {k} member {j}: the member does not lie on its drawn locus")

    # Atoms of the conventional cell.
    check(counts["n_conv"] == len(atoms) == sum(o["multiplicity"] for o in orbits), f"{cid}: n_conv")
    check(counts["n_prim"] == sum(o["multiplicity_prim"] for o in orbits), f"{cid}: n_prim")
    classes = {a["prim_class"] for a in atoms}
    check(classes == set(range(counts["n_prim"])), f"{cid}: prim_class must be 0..n_prim-1")
    for a in atoms:
        o = orbits[a["orbit"]]
        check(a["species"] == o["species"], f"{cid}: atom species")
        check(pdist(a["frac"], o["members"][a["member"]]["frac"]) < 1e-9, f"{cid}: atom frac != member frac")
    fr = np.asarray([a["frac"] for a in atoms], float)
    for i in range(len(fr)):
        for j in range(i + 1, len(fr)):
            check(pdist(fr[i], fr[j]) > 1e-3, f"{cid}: atoms {i} and {j} coincide")

    # Counts of the two representations.
    n_cell, K = counts["n_cell"], len(orbits)
    check(counts["crystalite"] == dict(tokens=n_cell + 1, types=n_cell, coords=3 * n_cell, lattice=6),
          f"{cid}: crystalite counts {counts['crystalite']}")
    check(counts["orbitol"] == dict(tokens=K + 1, types=K, coords=sum(o["d"] for o in orbits),
                                    lattice=len(lat["free"])), f"{cid}: orbitol counts {counts['orbitol']}")
    check(n_cell == counts["n_prim"], f"{cid}: n_cell {n_cell} != n_prim {counts['n_prim']} (MP-20 cell not primitive?)")

    # Wyckoff table of the group.
    table = c["wyckoff_table"]
    check(table[0]["d"] == 3, f"{cid}: wyckoff table must start with the general position")
    labels = [w["wyckoff"] for w in table]
    check(len(labels) == len(set(labels)), f"{cid}: duplicate rows in wyckoff table")
    for k, o in enumerate(orbits):
        rows = [w for w in table if w["wyckoff"] == o["wyckoff"]]
        check(len(rows) == 1 and k in rows[0]["occupied_by"], f"{cid}: orbit {k} not marked in wyckoff table")
        if rows:
            check(rows[0]["site_symmetry"] == o["site_symmetry"] and rows[0]["d"] == o["d"],
                  f"{cid}: orbit {k} disagrees with its wyckoff-table row")
    occupied = sorted(k for w in table for k in w["occupied_by"])
    check(occupied == list(range(K)), f"{cid}: occupied_by must list every orbit once")

    # Display rules.
    disp = c["display"]
    species = {o["species"] for o in orbits}
    check(len(disp.get("bonds", [])) > 0, f"{cid}: no bond rules")
    for bnd in disp.get("bonds", []):
        check(bnd["a"] in species and bnd["b"] in species and 0.5 < bnd["max"] < 4.0, f"{cid}: bad bond rule {bnd}")
    for poly in disp.get("polyhedra", []):
        check(poly["center"] in species and poly["ligand"] in species, f"{cid}: bad polyhedron rule {poly}")

    # The exported cell is the MP-20 material, and spglib finds the same group.
    if check(mp is not None, f"{cid}: material not found in MP-20"):
        split, row = mp
        check(c["split"] == split, f"{cid}: split {c['split']} != {split}")
        ref = Structure.from_str(row["cif"], fmt="cif")
        check(len(ref) == n_cell, f"{cid}: n_cell {n_cell} != {len(ref)} sites in the MP-20 cif")
        ours = Structure(Lattice(M), [a["species"] for a in atoms], [a["frac"] for a in atoms])
        check(StructureMatcher().fit(ours, ref), f"{cid}: exported cell does not match MP-20 {c['material_id']}")
        cell = (M, np.asarray([a["frac"] for a in atoms]), [ours[i].specie.Z for i in range(len(ours))])
        got_sg = spglib.get_symmetry_dataset(cell, symprec=1e-3).number
        check(got_sg == sg["number"], f"{cid}: spglib finds {got_sg}, data says {sg['number']}")
        check(int(row["spacegroup.number"]) == sg["number"], f"{cid}: MP-20 lists group {row['spacegroup.number']}")


def main():
    data = load()
    crystals = data["crystals"]
    ids = [c["id"] for c in crystals]
    check(ids == [e[0] for e in EXPECTED], f"crystal ids/order {ids}")
    check(data["meta"].get("default") in ids, "meta.default must name a crystal")
    mp = mp20_rows()
    for c, (cid, mpid, number) in zip(crystals, EXPECTED):
        check(c["material_id"] == mpid, f"{cid}: material id {c['material_id']} != {mpid}")
        if number is not None:
            check(c["space_group"]["number"] == number, f"{cid}: group {c['space_group']['number']} != {number}")
        check_crystal(c, mp.get(mpid))
    size = DATA.stat().st_size
    check(size < 1_500_000, f"crystals.js is {size} bytes; keep it under 1.5 MB")
    if failures:
        print(f"FAIL: {len(failures)} problem(s)")
        for f in failures[:60]:
            print("  -", f)
        sys.exit(1)
    print(f"OK: {len(crystals)} crystals, {sum(len(c['atoms']) for c in crystals)} atoms, {size} bytes")


if __name__ == "__main__":
    main()
