// Runs cords.decode off the main thread for the CORDS figures.
// Message in:  {id, fields: {coords, density, features, weights, sigma, pixelMass}, seed}
// Message out: {id, result} or {id, error}
import { decode, makeRng, mat } from "./cords.js";

const asMat = (m) => mat(m.rows, m.cols, m.data);

self.onmessage = ({ data: { id, fields, seed } }) => {
  try {
    const result = decode(
      { ...fields, coords: asMat(fields.coords), features: asMat(fields.features) },
      { rng: makeRng(seed ?? 0) },
    );
    const buffers = [result.positions, result.features, result.initial].map((m) => m.data.buffer);
    self.postMessage({ id, result }, buffers);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};
