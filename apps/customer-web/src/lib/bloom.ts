/**
 * Placeholder artwork. The existing catalog contract carries no media, so a product tile shows a simple bloom drawn from the product's id — stable
 * between visits, different between products. When a media contract exists this is replaced by the real photograph; nothing else depends on it.
 */
/** deliberately neutral soft greens: the artwork is a placeholder and must never suggest a product's real colour */
export interface BloomPalette {
  /** the tile behind the flower */
  ground: string;
  petal: string;
  petalDeep: string;
  heart: string;
}

export const PALETTES: readonly BloomPalette[] = [
  { ground: '#E3ECE5', petal: '#BFD6C8', petalDeep: '#9DBBA9', heart: '#E5A00D' },
  { ground: '#E9EFEA', petal: '#CBDCD1', petalDeep: '#A8C3B2', heart: '#E5A00D' },
];

export interface BloomSpec {
  petals: number;
  rotation: number;
  palette: BloomPalette;
}

/** a small, stable 32-bit hash (FNV-1a) — art only, never anything security-related */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function bloomSpec(id: string): BloomSpec {
  const h = hash(id);
  return {
    petals: 5 + (h % 5),
    rotation: (h >>> 5) % 360,
    palette: PALETTES[(h >>> 11) % PALETTES.length]!,
  };
}
