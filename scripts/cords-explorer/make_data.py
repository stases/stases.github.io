#!/usr/bin/env python3
"""Export the CORDS figures' local molecular geometries and MultiMNIST scenes."""

import base64
from collections import Counter
from io import BytesIO
import json
from pathlib import Path
import re
import sys

# Dependencies and source datasets live outside this worktree and are read-only.
sys.dont_write_bytecode = True

from ase.build import molecule
import numpy as np
from PIL import Image
import torch

from cords.detection import make_scene
from cords.molecules import ATOMIC_NUMBERS, ELEMENTS, load_qm9_examples


HERE = Path(__file__).resolve().parent
SDF_DIR = Path("/home/thadziv/GitHub/cords-blog-work/specs/data")
RADII = {"H": 0.31, "C": 0.76, "N": 0.71, "O": 0.66, "F": 0.57}
ASE_URL = "https://ase-lib.org/ase/collections.html#g2"
QM9_URL = "https://doi.org/10.1038/sdata.2014.22"


def principal_positions(positions):
    """Centroid-centre and rotate to descending-spread, right-handed axes."""
    positions = np.asarray(positions, dtype=np.float64)
    centered = positions - positions.mean(axis=0)
    _, axes = np.linalg.eigh(centered.T @ centered)
    axes = axes[:, ::-1].copy()
    # Orient x and y so the atom with greatest absolute projection is positive.
    # First-index argmax breaks ties. Set z by a cross product: no reflection.
    for k in range(2):
        projected = centered @ axes[:, k]
        if projected[np.argmax(np.abs(projected))] < 0:
            axes[:, k] *= -1
    axes[:, 2] = np.cross(axes[:, 0], axes[:, 1])
    rotated = np.round(centered @ axes, 4)
    rotated[rotated == 0] = 0  # Do not serialize negative zero.
    return rotated.tolist()


def record(identifier, name, positions, symbols, bonds, source, source_url):
    counts = Counter(symbols)
    order = ["C", "H"] + sorted(set(symbols) - {"C", "H"}) if "C" in counts else sorted(counts)
    formula = "".join(symbol + (str(counts[symbol]) if counts[symbol] > 1 else "")
                      for symbol in order if counts[symbol])
    return dict(id=identifier, name=name, formula=formula,
                formula_html=re.sub(r"(\d+)", r"<sub>\1</sub>", formula),
                source=source, source_url=source_url, n_atoms=len(symbols),
                positions=principal_positions(positions),
                types=[ELEMENTS.index(symbol) for symbol in symbols], bonds=bonds)


def ase_record(identifier, name, key):
    atoms = molecule(key)
    symbols = atoms.get_chemical_symbols()
    positions = atoms.get_positions()
    bonds = [[i, j, 1] for i in range(len(atoms)) for j in range(i + 1, len(atoms))
             if np.linalg.norm(positions[i] - positions[j]) < 1.2 * (RADII[symbols[i]] + RADII[symbols[j]])]
    return record(identifier, name, positions, symbols, bonds, "ASE G2 geometry", ASE_URL)


def sdf_record(identifier, name, cid):
    """Read only the V2000 fixed-width atom/bond blocks; retain explicit H atoms."""
    path = SDF_DIR / f"{identifier}.sdf"
    lines = path.read_text().splitlines()
    if "V2000" not in lines[3] or lines[0].strip() != str(cid):
        raise ValueError(f"Expected PubChem CID {cid} in V2000 format: {path}")
    n_atoms, n_bonds = int(lines[3][:3]), int(lines[3][3:6])
    positions, symbols, bonds = [], [], []
    for line in lines[4:4 + n_atoms]:
        positions.append([float(line[k:k + 10]) for k in (0, 10, 20)])
        symbols.append(line[31:34].strip())
    for line in lines[4 + n_atoms:4 + n_atoms + n_bonds]:
        i, j, order = (int(line[k:k + 3]) for k in (0, 3, 6))
        if order not in (1, 2, 3, 4):
            raise ValueError(f"Unsupported SDF bond order {order}: {path}")
        bonds.append([i - 1, j - 1, 1.5 if order == 4 else order])
    if len(positions) != n_atoms or len(bonds) != n_bonds:
        raise ValueError(f"Truncated SDF: {path}")
    return record(identifier, name, positions, symbols, bonds, "PubChem 3D conformer",
                  f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}")


def molecules_data():
    records = [ase_record("acetonitrile", "Acetonitrile", "CH3CN")]
    qm9 = {m.name: m for m in load_qm9_examples()}
    for identifier, name, qm9_id in (
        ("trifluoropropyne", "Trifluoropropyne", "gdb_826"),
        ("ethanol", "Ethanol", "gdb_14"),
        ("acetamide", "Acetamide", "gdb_19"),
    ):
        m = qm9[qm9_id]
        symbols = [ELEMENTS[ATOMIC_NUMBERS.index(z)] for z in m.atomic_numbers.tolist()]
        bonds = [[i, j, (1, 2, 3, 1.5)[kind]]
                 for (i, j), kind in zip(m.bonds.tolist(), m.bond_types.tolist(), strict=True)]
        records.append(record(identifier, name, m.positions.numpy(), symbols,
                              bonds, f"QM9 {qm9_id}", QM9_URL))
    records.extend([
        ase_record("pyridine", "Pyridine", "C5H5N"),
        ase_record("benzene", "Benzene", "C6H6"),
        sdf_record("aspirin", "Aspirin", 2244),
        sdf_record("caffeine", "Caffeine", 2519),
    ])
    return dict(elements=list(ELEMENTS), default="ethanol", molecules=records)


def mnist_data():
    scenes = []
    for n in range(1, 21):
        for seed in range(4):
            scene = make_scene(seed=100 * n + seed, num_digits=n, image_size=128, overlap=False)
            pixels = np.rint(scene.image[0].numpy() * 255).astype(np.uint8)
            buffer = BytesIO()
            Image.fromarray(pixels).save(buffer, format="PNG", compress_level=9)
            scenes.append(dict(n=n, seed=seed,
                               png="data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"),
                               boxes=scene.boxes.to(torch.int64).tolist(), labels=scene.labels.tolist(),
                               centers=scene.centers.tolist(), sizes=scene.features[:, 10:].tolist()))
    return dict(image_size=128, classes=10, train_max=15, sigma=2.0,
                default=dict(n=7, seed=0), scenes=scenes)


def main():
    torch.set_num_threads(1)
    molecules, mnist = molecules_data(), mnist_data()
    (HERE / "data").mkdir(exist_ok=True)
    for filename, global_name, data in (("molecules.js", "CORDS_MOLECULES", molecules),
                                         ("mnist.js", "CORDS_MNIST", mnist)):
        path = HERE / "data" / filename
        payload = json.dumps(data, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
        path.write_text(f"window.{global_name} = {payload};\n", encoding="utf-8")
        print(f"{path}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
