#!/usr/bin/env python3
"""Validate both browser data globals without executing JavaScript or fetching data."""

import base64
from collections import Counter
from io import BytesIO
import json
import math
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True

from PIL import Image


HERE = Path(__file__).resolve().parent
EXPECTED = [
    ("acetonitrile", "Acetonitrile", 6, "C2H3N", "ASE G2 geometry"),
    ("trifluoropropyne", "Trifluoropropyne", 7, "C3HF3", "QM9 gdb_826"),
    ("ethanol", "Ethanol", 9, "C2H6O", "QM9 gdb_14"),
    ("acetamide", "Acetamide", 9, "C2H5NO", "QM9 gdb_19"),
    ("pyridine", "Pyridine", 11, "C5H5N", "ASE G2 geometry"),
    ("benzene", "Benzene", 12, "C6H6", "ASE G2 geometry"),
    ("aspirin", "Aspirin", 21, "C9H8O4", "PubChem 3D conformer"),
    ("caffeine", "Caffeine", 24, "C8H10N4O2", "PubChem 3D conformer"),
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def vector(value, length):
    return isinstance(value, list) and len(value) == length and all(finite(x) for x in value)


def load(filename, name):
    path = HERE / "data" / filename
    text = path.read_text(encoding="utf-8").strip()
    prefix = f"window.{name} = "
    require(text.startswith(prefix) and text.endswith(";"), f"Invalid JS wrapper: {path}")
    return json.loads(text[len(prefix):-1])


def check_molecules(data):
    elements = data["elements"]
    require(elements == ["H", "C", "N", "O", "F"], "element vocabulary")
    require(data["default"] == "ethanol", "default molecule")
    require([m["id"] for m in data["molecules"]] == [row[0] for row in EXPECTED], "molecule order")
    for m, (identifier, name, count, formula, source) in zip(data["molecules"], EXPECTED, strict=True):
        require(m["n_atoms"] == count and type(m["n_atoms"]) is int, f"{identifier}: atom count")
        require(m["name"] == name, f"{identifier}: name")
        require(m["source"] == source and m["source_url"].startswith("https://"), f"{identifier}: source")
        if source.startswith("QM9 "):
            require(m["source_url"] == "https://doi.org/10.1038/sdata.2014.22", f"{identifier}: QM9 source URL")
        require(m["formula"] == formula, f"{identifier}: formula {m['formula']} != {formula}")
        require(m["formula_html"] == re.sub(r"(\d+)", r"<sub>\1</sub>", formula), f"{identifier}: HTML formula")
        positions, types = m["positions"], m["types"]
        require(len(positions) == count and len(types) == count, f"{identifier}: array lengths")
        require(all(vector(p, 3) for p in positions), f"{identifier}: finite XYZ positions")
        require(all(type(t) is int and 0 <= t < 5 for t in types), f"{identifier}: element indices")
        counts = Counter(elements[t] for t in types)
        formula_counts = {s: int(n or 1) for s, n in re.findall(r"([A-Z][a-z]?)(\d*)", formula)}
        require(counts == formula_counts, f"{identifier}: formula does not match atom types")
        require(all(abs(sum(p[k] for p in positions) / count) <= 5.1e-5 for k in range(3)),
                f"{identifier}: centroid (allowing four-decimal rounding)")
        require(all(abs(x - round(x, 4)) < 1e-12 for p in positions for x in p), f"{identifier}: four decimals")
        covariance = [[sum(p[i] * p[j] for p in positions) / count for j in range(3)] for i in range(3)]
        require(covariance[0][0] + 1e-3 >= covariance[1][1] >= covariance[2][2] - 1e-3,
                f"{identifier}: descending principal spreads")
        require(all(abs(covariance[i][j]) < 1e-3 for i in range(3) for j in range(i)),
                f"{identifier}: principal axes")
        seen = set()
        require(bool(m["bonds"]), f"{identifier}: missing bonds")
        for bond in m["bonds"]:
            require(vector(bond, 3), f"{identifier}: bond tuple")
            i, j, order = bond
            require(type(i) is int and type(j) is int and 0 <= i < count and 0 <= j < count and i != j,
                    f"{identifier}: bond endpoints")
            require(order in (1, 1.5, 2, 3), f"{identifier}: bond order")
            pair = tuple(sorted((i, j)))
            require(pair not in seen, f"{identifier}: repeated bond")
            seen.add(pair)
        print(f"OK {identifier}: {count} atoms, {formula}, {len(seen)} bonds, {source}")


def check_mnist(data):
    require((data["image_size"], data["classes"], data["train_max"], data["sigma"]) == (128, 10, 15, 2.0),
            "MNIST metadata")
    require(data["default"] == dict(n=7, seed=0), "MNIST default")
    scenes = data["scenes"]
    require(len(scenes) == 80, "expected 80 scenes")
    require([(s["n"], s["seed"]) for s in scenes] == [(n, seed) for n in range(1, 21) for seed in range(4)],
            "scene counts/order/seeds")
    for scene in scenes:
        n, seed = scene["n"], scene["seed"]
        name = f"n={n} seed={seed}"
        require(type(n) is int and type(seed) is int, f"{name}: integer count and seed")
        require(all(len(scene[key]) == n for key in ("boxes", "labels", "centers", "sizes")), f"{name}: lengths")
        for box, label, center, size in zip(scene["boxes"], scene["labels"], scene["centers"], scene["sizes"], strict=True):
            require(vector(box, 4) and all(type(x) is int for x in box), f"{name}: pixel box")
            x0, y0, x1, y1 = box
            require(0 <= x0 < x1 <= 128 and 0 <= y0 < y1 <= 128, f"{name}: box bounds")
            require(type(label) is int and 0 <= label <= 9, f"{name}: label")
            require(vector(center, 2) and center == [(x0 + x1) / 2, (y0 + y1) / 2], f"{name}: center")
            require(vector(size, 2) and size == [(x1 - x0) / 128, (y1 - y0) / 128], f"{name}: normalized size")
        for i, a in enumerate(scene["boxes"]):
            for b in scene["boxes"][:i]:
                require(a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1], f"{name}: overlapping boxes")
        prefix = "data:image/png;base64,"
        require(scene["png"].startswith(prefix), f"{name}: PNG data URI")
        png = base64.b64decode(scene["png"][len(prefix):], validate=True)
        with Image.open(BytesIO(png)) as image:
            require(image.format == "PNG" and image.size == (128, 128) and image.mode == "L", f"{name}: 128x128 grayscale PNG")
            image.load()
            require(image.getextrema()[1] > 0, f"{name}: blank image")
        if seed == 3:
            print(f"OK n={n}: 4 scenes, {n} boxes/labels/centers/sizes each, 128x128 grayscale PNGs")
    size = (HERE / "data/mnist.js").stat().st_size
    require(size < 600_000, f"MNIST export exceeds 600 KB: {size} bytes")


def main():
    check_molecules(load("molecules.js", "CORDS_MOLECULES"))
    check_mnist(load("mnist.js", "CORDS_MNIST"))
    print("ALL PASSED: 8 molecules and 80 scenes")


if __name__ == "__main__":
    main()
