// Dashboard warning-light symbols for the damage lights, one lit and one off version per car part,
// drawn as white-on-transparent 128 x 128 SVGs (the original made the same shapes into texture masks).
// The HUD uses them as CSS masks and tints them: lit = a bold filled symbol in the light's colour,
// off = a thin outline of the same symbol.
import type { Part } from '../game/damage';

const W = '#FFFFFF';

// engine block (the "check engine" symbol): block body, top cap, left plug, right fan housing
const engine = (fill: string, stroke: string, sw: number) =>
  `<path d="M30 46 h14 v-8 h-8 v-8 h40 v8 h-8 v8 h22 l10 10 h10 v-8 h8 v40 h-8 v-8 h-10 l-10 14 h-50 l-8 -10 h-10 v10 h-8 v-36 h8 v10 h10 z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;

// tyre with a "!" (the tyre-pressure symbol): wheels and suspension
const tyre = (fill: string, stroke: string, sw: number, tw: number) =>
  `<path d="M34 28 C20 48 20 78 34 98 L40 104 L48 98 L56 104 L64 98 L72 104 L80 98 L88 104 L94 98 C108 78 108 48 94 28" fill="none" stroke="${W}" stroke-width="${tw}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<rect x="58" y="36" width="12" height="38" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>` +
  `<circle cx="64" cy="86" r="7" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

// top-down car: a slim body with a windscreen; the damaged side is a thick bar outside the body and,
// when lit, that third of the body filled solid, so left / right / front / rear read at a glance
const BARS: Record<string, string> = {
  front: 'x="34" y="3" width="60" height="15" rx="7"',
  rear: 'x="34" y="110" width="60" height="15" rx="7"',
  left: 'x="21" y="30" width="15" height="68" rx="7"',
  right: 'x="92" y="30" width="15" height="68" rx="7"',
};
const THIRDS: Record<string, string> = {
  front: 'x="40" y="20" width="48" height="24"',
  rear: 'x="40" y="84" width="48" height="24"',
  left: 'x="40" y="20" width="18" height="88"',
  right: 'x="70" y="20" width="18" height="88"',
};
const car = (side: string, lit: boolean) =>
  `<defs><clipPath id="b"><rect x="44" y="24" width="40" height="80" rx="13"/></clipPath></defs>` +
  `<rect x="44" y="24" width="40" height="80" rx="13" fill="none" stroke="${W}" stroke-width="${lit ? 6 : 4}"/>` +
  `<path d="M50 50 Q64 43 78 50 L76 60 Q64 56 52 60 Z" fill="${W}"/>` +
  (lit ? `<g clip-path="url(#b)"><rect ${THIRDS[side]} fill="${W}"/></g><rect ${BARS[side]} fill="${W}"/>`
    : `<rect ${BARS[side]} fill="none" stroke="${W}" stroke-width="4"/>`);

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">${body}</svg>`;
}

/** The symbol for a part as an SVG document. */
export function warningIcon(part: Part, lit: boolean): string {
  if (part === 'engine') return svg(lit ? engine(W, W, 4) : engine('none', W, 3));
  if (part === 'suspension') return svg(lit ? tyre(W, W, 2, 11) : tyre('none', W, 3, 3));
  return svg(car(part, lit));
}

/** The symbol as a CSS url() for mask-image. */
export function warningIconUrl(part: Part, lit: boolean): string {
  return `url("data:image/svg+xml,${encodeURIComponent(warningIcon(part, lit))}")`;
}
