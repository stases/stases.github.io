#!/usr/bin/env python3
"""Export MP-20 crystals using Orbitol's tokens and frozen symmetry tables.

Run from the repository root:
  PYTHONPATH=<orbitol checkout> python scripts/orbit-explorer/make_data.py
MP20_RAW points to the MP-20 raw CSVs (default ~/GitHub/crystalite/data/mp20/raw).
Re-run whenever the crystal list changes; writes crystals.js beside this script.
"""
import csv
from datetime import date
from importlib.metadata import version
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys

# The external Orbitol checkout and its pinned Crystalite core are read-only inputs.
sys.dont_write_bytecode = True

import numpy as np
import orbitol.core  # Bind the pinned Crystalite core before importing Orbitol data.
from orbitol.contracts import CENTRINGS, FAMILIES
from orbitol.data import _selector, expand_tokens, ltri_to_lattice, tokenise
from orbitol.standardise import default_tables, species_permutation
from pymatgen.core import Element, Lattice, Structure
from pymatgen.core.operations import SymmOp
from pyxtal.symmetry import Group
import spglib


HERE = Path(__file__).resolve().parent
MP20 = Path(os.environ.get("MP20_RAW", Path.home() / "GitHub/crystalite/data/mp20/raw"))
COMMIT = "62ca92e"
CRYSTALS = [
    ("cab6", "Calcium hexaboride", "CaB6", "mp-865", 221,
     "Ca sits on the fixed corner site 1a. The six B atoms form one orbit on 6f, and its single free coordinate x sets the size of the B₆ octahedron."),
    ("ag2o", "Silver oxide", "Ag2O", "mp-353", 224,
     "Both orbits sit on fixed points. Once the skeleton is given, only the lattice constant a is left to generate."),
    ("pyrite", "Pyrite", "FeS2", "mp-226", 205,
     "Fe on 4a is fixed. S occupies 8c at (x, x, x), and the single number x sets the length of every S–S pair in the cell."),
    ("spinel", "Spinel", "MgAl2O4", "mp-3536", 227,
     "A face-centred cell: 56 atoms in the conventional cell, 14 in the primitive cell, three orbit tokens. Only the oxygen orbit on 32e has a free coordinate."),
    ("rutile", "Rutile", "TiO2", "mp-2657", 136,
     "Ti on 2a is fixed. One free number x places all four O atoms of the 4f orbit, each moving on its own line."),
    ("fese", "Iron selenide", "FeSe", "mp-20311", 129,
     "Fe on 2a is fixed. The Se orbit on 2c has one free coordinate, its height z above the Fe layer."),
    ("zno", "Zincite", "ZnO", "mp-2133", 186,
     "Zn and O occupy the same Wyckoff row, 2b, as two separate orbits, each with its own height z along the polar c axis."),
    ("quartz", "α-Quartz", "SiO2", "mp-7000", 152,
     "Si on 3a has one free coordinate and O on the general position 6c has three, so four numbers place all nine atoms."),
    ("lasco3", "Lanthanum scandate", "LaScO3", "mp-31116", 62,
     "An orthorhombic perovskite with tilted ScO₆ octahedra. Oxygen occupies two rows, 4c and the general position 8d, as two orbits."),
    ("zro2", "Baddeleyite", "ZrO2", "mp-2858", 14,
     "Every orbit sits on the general position 4e with three free coordinates. The monoclinic lattice token carries a, b, c and β."),
    ("cssnf3", "CsSnF3", "CsSnF3", "mp-998298", 1,
     "In P1 the only operation is the identity, so every orbit is a single atom with three free coordinates and the tokens are Crystalite's."),
]
PREFERRED = {"cab6": {"Ca": "1a", "B": "6f"}, "ag2o": {"O": "2a", "Ag": "4b"}}
FREE_LATTICE = {
    "cubic": ["a"], "tetragonal": ["a", "c"], "hexagonal": ["a", "c"],
    "orthorhombic": ["a", "b", "c"], "monoclinic": ["a", "b", "c", "beta"],
    "triclinic": ["a", "b", "c", "alpha", "beta", "gamma"],
}
TIES = {
    "cubic": "a = b = c, α = β = γ = 90°", "tetragonal": "a = b, α = β = γ = 90°",
    "hexagonal": "a = b, α = β = 90°, γ = 120°", "orthorhombic": "α = β = γ = 90°",
    "monoclinic": "α = γ = 90°", "triclinic": "none",
}
# First-shell sizes established from the MP-20 neighbour distances, not covalent radii.
# B has four intra-octahedron contacts and one inter-octahedron contact. Sn has
# three short Sn-F contacts (2.116-2.189 Å); the next three start at 2.612 Å.
BONDS = {
    "cab6": [("B", "B", 5)], "ag2o": [("Ag", "O", 2)],
    "pyrite": [("Fe", "S", 6), ("S", "S", 1)],
    "spinel": [("Mg", "O", 4), ("Al", "O", 6)], "rutile": [("Ti", "O", 6)],
    "fese": [("Fe", "Se", 4)], "zno": [("Zn", "O", 4)], "quartz": [("Si", "O", 4)],
    "lasco3": [("Sc", "O", 6)], "zro2": [("Zr", "O", 7)], "cssnf3": [("Sn", "F", 3)],
}
POLYHEDRA = {
    "ag2o": [("O", "Ag")], "pyrite": [("Fe", "S")], "spinel": [("Mg", "O"), ("Al", "O")],
    "rutile": [("Ti", "O")], "fese": [("Fe", "Se")], "zno": [("Zn", "O")],
    "quartz": [("Si", "O")], "lasco3": [("Sc", "O")],
}
FRAC = {"1/2": "½", "1/4": "¼", "3/4": "¾", "1/3": "⅓", "2/3": "⅔", "1/6": "⅙", "5/6": "⅚",
        "1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞"}


def pretty_component(comp):
    """Constant-first typography with Unicode fractions and minus signs."""
    terms = re.findall(r"[+-]?[^+-]+", comp.replace(" ", ""))
    const = [t for t in terms if not re.search(r"[xyz]", t)]
    var = [t for t in terms if re.search(r"[xyz]", t)]
    out = ""
    for term in const + var:
        sign = "−" if term.startswith("-") else "+"
        body = term.lstrip("+-")
        out += (sign if out or sign == "−" else "") + FRAC.get(body, body)
    return out or "0"


def pretty(xyz):
    return "(" + ", ".join(pretty_component(c) for c in xyz.split(",")) + ")"


def symbol_html(symbol):
    symbol = re.sub(r"_(\d)", r"<sub>\1</sub>", symbol)
    return re.sub(r"-(\d)", r'<span class="ov">\1</span>', symbol)


def rounded(values, decimals=6):
    return (np.round(values, decimals) + 0.0).tolist()


def fractional(values):
    # Rounding must never turn a periodic coordinate into the excluded endpoint 1.
    return np.mod(np.round(np.mod(values, 1.0), 6), 1.0).tolist()


def clip_polygon(poly, axis, bound, side):
    """Sutherland-Hodgman clipping to side * (coordinate - bound) >= 0."""
    out = []
    for p, q in zip(poly, poly[1:] + poly[:1]):
        dp, dq = side * (p[axis] - bound), side * (q[axis] - bound)
        if dp >= -1e-10:
            out.append(p)
        if (dp >= -1e-10) != (dq >= -1e-10):
            out.append(p + dp / (dp - dq) * (q - p))
    return out


def locus(W, v):
    """Wrap a chart segment/parallelogram into every closed unit cube it meets."""
    assert np.allclose(W, np.rint(W), atol=1e-12, rtol=0), "Noninteger locus W"
    d = W.shape[1]
    pieces = []
    if d == 1:
        direction = W[:, 0]
        cuts = {0.0, 1.0}
        for w, start in zip(direction, v):
            if w:
                lo, hi = sorted((start, start + w))
                cuts.update((n - start) / w for n in range(int(np.ceil(lo)), int(np.floor(hi)) + 1))
        cuts = sorted(cuts)
        for t0, t1 in zip(cuts, cuts[1:]):
            midpoint = v + direction * ((t0 + t1) / 2)
            cubes = []
            for w, x in zip(direction, midpoint):
                # A segment on a cell face also has an image on the opposite face.
                cubes.append([round(x) - 1, round(x)] if w == 0 and abs(x - round(x)) < 1e-10
                             else [int(np.floor(x))])
            for shift in itertools.product(*cubes):
                pieces.append(np.array([v + direction * t0, v + direction * t1]) - shift)
    else:
        assert d == 2
        poly = [v + W @ t for t in ([0, 0], [1, 0], [1, 1], [0, 1])]
        lo, hi = np.min(poly, axis=0), np.max(poly, axis=0)
        cubes = [range(int(np.ceil(x)) - 1, int(np.floor(y)) + 1) for x, y in zip(lo, hi)]
        for shift in itertools.product(*cubes):
            clipped = poly
            for axis, n in enumerate(shift):
                clipped = clip_polygon(clipped, axis, n, 1)
                clipped = clip_polygon(clipped, axis, n + 1, -1)
            if clipped:
                pieces.append(np.asarray(clipped) - shift)
    unique = {}
    for piece in pieces:
        # Remove repeated vertices introduced by clipping along a boundary.
        vertices = []
        for point in np.round(np.clip(piece, 0, 1), 6):
            if not any(np.array_equal(point, p) for p in vertices):
                vertices.append(point)
        if len(vertices) < d + 1:
            continue
        if d == 1:
            measure = np.linalg.norm(vertices[1] - vertices[0])
        else:
            measure = np.linalg.norm(sum(np.cross(p, q) for p, q in
                                         zip(vertices, vertices[1:] + vertices[:1]))) / 2
        if measure >= 1e-9:
            key = tuple(sorted(tuple(p) for p in vertices))
            unique[key] = rounded(vertices)
    assert unique, (W, v)
    return {"segments" if d == 1 else "polygons": list(unique.values())}


def pyxtal_row(tables, r, wp):
    """Cross-check the chart and match display operations to frozen member order."""
    a = tables.arrays
    d, m = int(a["row_dof"][r]), int(a["row_mult"][r])
    axes = _selector(tuple(a["row_A"][r].ravel()), d)
    assert wp.letter == a["row_letter"][r] and wp.multiplicity == m and wp.get_dof() == d
    assert np.allclose(wp.ops[0].rotation_matrix[:, axes], a["row_A"][r, :, :d])
    assert np.allclose(wp.ops[0].translation_vector, a["row_b"][r])
    unused = list(wp.ops)
    ordered = []
    for W, v in zip(a["row_W"][r, :m, :, :d], a["row_v"][r, :m]):
        assert np.allclose(W, np.rint(W), atol=1e-12, rtol=0), f"Noninteger W in row {r}"
        matches = [j for j, op in enumerate(unused)
                   if np.allclose(W, op.rotation_matrix[:, axes], atol=1e-12, rtol=0)
                   and np.max(np.abs((v - op.translation_vector) - np.rint(v - op.translation_vector))) < 1e-12]
        assert len(matches) == 1, (r, wp.get_label(), matches)
        ordered.append(unused.pop(matches[0]))
    assert not unused
    return axes, ordered


def read_mp20():
    csv.field_size_limit(10**9)
    wanted = {c[3] for c in CRYSTALS}
    rows = {}
    for split in ("train", "val", "test"):
        with (MP20 / f"{split}.csv").open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                if row["material_id"] in wanted:
                    assert row["material_id"] not in rows, "Duplicate MP-20 material"
                    rows[row["material_id"]] = (split, row)
    assert set(rows) == wanted, wanted - set(rows)
    return rows


def display_rules(cid, structure):
    neighbors = structure.get_all_neighbors(6.0)
    bonds, reports = [], []
    for center, ligand, coordination in BONDS[cid]:
        distances = [sorted(n.nn_distance for n in neighbors[i] if n.specie.symbol == ligand)
                     for i, s in enumerate(structure) if s.specie.symbol == center]
        assert distances and all(len(ds) > coordination for ds in distances)
        shell_min = min(ds[0] for ds in distances)
        shell_max = max(ds[coordination - 1] for ds in distances)
        next_min = min(ds[coordination] for ds in distances)
        assert shell_max < next_min, (cid, center, ligand, "Overlapping shells")
        cutoff = round(shell_max + min(0.1, (next_min - shell_max) / 4), 2)
        assert shell_max < cutoff < next_min
        assert all(sum(d < cutoff for d in ds) == coordination for ds in distances)
        bonds.append(dict(a=center, b=ligand, max=cutoff))
        reverse = sorted({sum(n.specie.symbol == center and n.nn_distance < cutoff for n in neighbors[i])
                          for i, s in enumerate(structure) if s.specie.symbol == ligand})
        reports.append(f"{center}-{ligand} cutoff={cutoff:.2f} Å, CN {center}={coordination}, {ligand}={reverse}; "
                       f"shell={shell_min:.3f}–{shell_max:.3f} Å, next={next_min:.3f} Å")
    polyhedra = [dict(center=c, ligand=l, max=next(b["max"] for b in bonds if {b["a"], b["b"]} == {c, l}))
                 for c, l in POLYHEDRA.get(cid, [])]
    return dict(bonds=bonds, polyhedra=polyhedra, view=dict(azimuth=30, elevation=18)), reports


def crystal_record(spec, split, source, tables):
    cid, name, formula, mp_id, expected_group, note = spec
    a = tables.arrays
    original = Structure.from_str(source["cif"], fmt="cif")
    tokens = tokenise(original, tables, mp_id=mp_id)

    def occupied(t):
        return {Element.from_Z(int(z)).symbol: f"{a['row_mult'][r]}{a['row_letter'][r]}"
                for r, z in zip(t["row"], t["A0"])}

    origin = "unchanged"
    if cid in PREFERRED and occupied(tokens) != PREFERRED[cid]:
        shifted = original.copy()
        shifted.translate_sites(range(len(shifted)), [0.5, 0.5, 0.5], frac_coords=True, to_unit_cell=True)
        tokens = tokenise(shifted, tables, mp_id=mp_id)
        origin = "input shifted by (½,½,½)"
        assert occupied(tokens) == PREFERRED[cid], (cid, occupied(tokens))

    G = int(tokens["G"])
    assert G == expected_group == int(source["spacegroup.number"]), (cid, G)
    group = Group(G)
    hall = int(a["group_hall"][G])  # Operations use the frozen setting, not the input dataset's Hall number.
    assert group.hall_number == hall
    sg_type = spglib.get_spacegroup_type(hall)
    symbol = sg_type.international_short
    assert symbol.replace("_", "") == str(a["group_symbol"][G])
    family = FAMILIES[int(tokens["family"])]
    order = int(a["group_ops_count"][G])
    operations = [dict(xyz=SymmOp.from_rotation_and_translation(R, t).as_xyz_str().replace(" ", ""),
                       R=R.astype(int).tolist(), t=rounded(t))
                  for R, t in zip(a["group_ops_R"][G, :order], a["group_ops_t"][G, :order])]
    space_group = dict(number=G, symbol=symbol, symbol_html=symbol_html(symbol), family=family,
                       crystal_system=group.lattice_type, point_group=group.point_group,
                       point_group_html=symbol_html(group.point_group), centring=CENTRINGS[int(a["group_centring"][G])],
                       order=order, hall_number=hall, polar=bool(a["group_polar"][G].any()), operations=operations)

    matrix = ltri_to_lattice(tokens["lat"])
    lat = Lattice(matrix)
    params = {k: round(float(v), 4 if i < 3 else 3)
              for i, (k, v) in enumerate(zip(("a", "b", "c", "alpha", "beta", "gamma"), lat.parameters))}
    lattice = dict(parameters=params, matrix=rounded(matrix, 4), latent=tokens["lat"].tolist(),
                   free=[dict(name=k, value=params[k], unit="Å" if k in ("a", "b", "c") else "°")
                         for k in FREE_LATTICE[family]], ties=TIES[family])

    wyckoff_table, row_display = [], {}
    start, count = int(a["group_row_start"][G]), int(a["group_row_count"][G])
    assert {w.letter for w in group} == set(a["row_letter"][start:start + count])
    for wp in group:  # Pyxtal's display order is general position first.
        r = tables.row_id(G, wp.letter)
        axes, ops = pyxtal_row(tables, r, wp)
        symmetry = wp.get_site_symmetry_object().name
        row_display[r] = (axes, ops, symmetry)
        wyckoff_table.append(dict(wyckoff=wp.get_label(), letter=wp.letter, multiplicity=int(a["row_mult"][r]),
                                  site_symmetry=symmetry, site_symmetry_html=symbol_html(symmetry),
                                  d=int(a["row_dof"][r]), representative=pretty(ops[0].as_xyz_str()), occupied_by=[]))

    items = sorted(zip(tokens["row"], tokens["A0"], tokens["U"]),
                   key=lambda item: (str(a["row_letter"][item[0]]), Element.from_Z(int(item[1])).symbol))
    orbits, atoms, labels = [], [], {}
    cent = a["group_cent_vecs"][G, :int(a["group_ncent"][G])]
    class_offset = 0
    for index, (r, z, u) in enumerate(items):
        r, z = int(r), int(z)
        species = Element.from_Z(z).symbol
        d, m, mprim = int(a["row_dof"][r]), int(a["row_mult"][r]), int(a["row_mprim"][r])
        axes, ops, symmetry = row_display[r]
        W, v = a["row_W"][r, :m, :, :d], a["row_v"][r, :m]
        frac = np.mod(W @ u[:d] + v, 1.0)
        display_u = np.zeros(3)
        display_u[list(axes)] = u[:d]
        pyxtal_frac = np.array([op.operate(display_u) for op in ops])
        species_permutation(frac, np.full(m, z), pyxtal_frac, np.full(m, z))
        members, classes = [], {}
        for j in range(m):
            labels[species] = labels.get(species, 0) + 1
            label = f"{species}{labels[species]}"
            expr = ops[j].as_xyz_str().replace(" ", "")
            member = dict(label=label, expr=pretty(expr), expr_raw=expr, W=np.rint(W[j]).astype(int).tolist(),
                          v=rounded(v[j]), frac=fractional(frac[j]), prim=bool(a["row_prim_mask"][r, j]))
            # Same affine map modulo centring => same primitive atom, for every free value.
            offset_key = min(tuple(np.rint(np.mod(v[j] + c, 1) * 48).astype(int) % 48) for c in cent)
            key = (tuple(W[j].ravel()), offset_key)
            assert member["prim"] == (key not in classes), (cid, r, j, "Primitive mask mismatch")
            if key not in classes:
                classes[key] = class_offset + len(classes)
            members.append(member)
            atoms.append(dict(label=label, species=species, orbit=index, member=j, frac=member["frac"],
                              prim_class=classes[key]))
        assert len(classes) == mprim
        class_offset += mprim
        letter = str(a["row_letter"][r])
        orbits.append(dict(index=index, species=species, Z=z, row_id=r, wyckoff=f"{m}{letter}", letter=letter,
                           multiplicity=m, multiplicity_prim=mprim, site_symmetry=symmetry,
                           site_symmetry_html=symbol_html(symmetry), d=d, free_names=["xyz"[ax] for ax in axes],
                           free_values=np.mod(np.round(u[:d], 5), 1).tolist(), chart=members[0]["expr"],
                           chart_raw=members[0]["expr_raw"], members=members,
                           loci=[locus(w, offset) for w, offset in zip(W, v)] if d in (1, 2) else None))
        next(w for w in wyckoff_table if w["letter"] == letter)["occupied_by"].append(index)

    xyz, types = expand_tokens(tokens["row"], tokens["A0"], tokens["U"], tables)
    species_permutation([atom["frac"] for atom in atoms], [orbits[atom["orbit"]]["Z"] for atom in atoms], xyz, types)
    n_cell, K = len(original), len(orbits)
    assert class_offset == tokens["n_prim"] and len(atoms) == tokens["n_conv"]
    counts = dict(n_cell=n_cell, n_conv=int(tokens["n_conv"]), n_prim=int(tokens["n_prim"]), n_orbits=K,
                  crystalite=dict(tokens=n_cell + 1, types=n_cell, coords=3 * n_cell, lattice=6),
                  orbitol=dict(tokens=K + 1, types=K, coords=sum(o["d"] for o in orbits), lattice=len(lattice["free"])))
    # Measure neighbours in the exported cell, so cutoffs describe exactly what the viewer draws.
    structure = Structure(lattice["matrix"], [atom["species"] for atom in atoms], [atom["frac"] for atom in atoms])
    display, bond_reports = display_rules(cid, structure)
    record = dict(id=cid, name=name, formula=formula, formula_html=re.sub(r"(\d+)", r"<sub>\1</sub>", formula),
                  material_id=mp_id, split=split, note=note, space_group=space_group, lattice=lattice, counts=counts,
                  orbits=orbits, atoms=atoms, wyckoff_table=wyckoff_table, display=display)
    print(f"{cid:8} {G:3} {symbol:10} n_cell/conv/prim={n_cell}/{len(atoms)}/{class_offset}, K={K}; "
          f"pyxtal=OK; origin={origin}")
    for o in orbits:
        print(f"  {o['species']:2} {o['wyckoff']:4} site={o['site_symmetry']:5} d={o['d']} "
              f"free={dict(zip(o['free_names'], o['free_values']))}")
    for report in bond_reports:
        print("  " + report)
    return record


def main():
    checkout = Path(orbitol.core.__file__).resolve().parents[1]
    head = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    assert head.startswith(COMMIT), (checkout, head)
    for package, pinned in (("pyxtal", "1.1.2"), ("spglib", "2.7.0")):
        assert version(package) == pinned, (package, version(package))
    tables = default_tables()
    rows = read_mp20()
    crystals = [crystal_record(spec, *rows[spec[3]], tables) for spec in CRYSTALS]
    data = dict(meta=dict(default="rutile", generated=date.today().isoformat(), script="scripts/orbit-explorer/make_data.py",
                          sources=dict(mp20="MP-20 raw CSVs", orbitol_commit=COMMIT, orbitol_tables_sha256=tables.sha256,
                                       pyxtal=version("pyxtal"), spglib=version("spglib"))), crystals=crystals)
    text = "window.ORBIT_EXPLORER_DATA = " + json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + ";\n"
    assert len(text.encode("utf-8")) < 1_500_000
    output = HERE / "crystals.js"
    output.write_text(text, encoding="utf-8")
    print(f"Wrote {output}: {len(crystals)} crystals, {output.stat().st_size} bytes.")


if __name__ == "__main__":
    main()
