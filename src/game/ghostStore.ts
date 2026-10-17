// The best-run ghosts in the save store (the original's URallyGhostSave, one slot per best-time key): one localStorage
// entry per key, `backroad-rally.ghost.<key>`, next to the save (`backroad-rally.save`) so the save itself stays small
// and a missing or bad ghost never costs the save. A ghost is the ghost codec (src/game/ghostCodec.ts) in base64:
// about 10-16 kB for a 2-minute stage at 15 Hz.
//
// localStorage holds about 5 MB per site. At most MAX_GHOSTS ghosts are kept (the oldest goes first), and a write
// that runs out of room drops the oldest ghosts until it fits.
import { fromBase64, pack, toBase64, unpack, type GhostSample } from './ghostCodec';

const PREFIX = 'backroad-rally.ghost.';
export const MAX_GHOSTS = 60;

export interface StoredGhost {
  v: 1;
  key: string;
  /** Stage time of the run (no penalties) and its total (with). */
  time: number;
  total: number;
  car: string;
  livery: number;
  hz: number;
  num: number;
  raw_bytes: number;
  /** Base64 of the packed bytes. */
  packed: string;
  /** Written at (ms since 1970), for the oldest-first clean-up. */
  at: number;
}

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Every stored ghost's key and age. */
export function listGhosts(): { key: string; at: number; bytes: number }[] {
  const s = store();
  if (!s) return [];
  const out: { key: string; at: number; bytes: number }[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const raw = s.getItem(k) ?? '';
      const at = Number(/"at":(\d+)/.exec(raw)?.[1] ?? 0);
      out.push({ key: k.slice(PREFIX.length), at, bytes: raw.length });
    }
  } catch {
    // storage blocked: none
  }
  return out;
}

export function removeGhost(key: string): void {
  try {
    store()?.removeItem(PREFIX + key);
  } catch {
    // fine
  }
}

/** Stores a run as the ghost of `key`; returns the bytes stored (0 = not stored). */
export async function saveGhost(key: string, samples: GhostSample[], meta: { time: number; total: number; car: string; livery: number; hz: number }): Promise<number> {
  const s = store();
  if (!s || samples.length < 2) return 0;
  const p = await pack(samples);
  const g: StoredGhost = {
    v: 1, key, time: meta.time, total: meta.total, car: meta.car, livery: meta.livery, hz: meta.hz, num: p.num, raw_bytes: p.rawBytes,
    packed: toBase64(p.packed), at: Date.now(),
  };
  const text = JSON.stringify(g);
  // room for this one: the oldest others go past the cap, then on a full store
  const others = listGhosts().filter((x) => x.key !== key).sort((a, b) => a.at - b.at);
  while (others.length >= MAX_GHOSTS) removeGhost(others.shift()!.key);
  for (;;) {
    try {
      s.setItem(PREFIX + key, text);
      return text.length;
    } catch {
      const old = others.shift();
      if (!old) return 0;
      removeGhost(old.key);
    }
  }
}

/** The stored ghost of `key`, decoded (null: none, or unreadable). */
export async function loadGhost(key: string): Promise<{ meta: StoredGhost; samples: GhostSample[]; bytes: number } | null> {
  let raw: string | null = null;
  try {
    raw = store()?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as StoredGhost;
    if (!g || g.v !== 1 || typeof g.packed !== 'string') return null;
    const bytes = fromBase64(g.packed);
    const samples = bytes ? await unpack(bytes, g.raw_bytes, g.num) : null;
    return samples ? { meta: g, samples, bytes: raw.length } : null;
  } catch {
    return null;
  }
}
