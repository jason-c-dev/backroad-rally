// Small flat flags beside the stage name (menu.json "flags": location -> code), as the original's
// Art/Scripts/ui/flags.py draws them: 3:2, simplified (the US canton has a grid of dots, the Welsh dragon
// is a single path), with a faint outline so the white ones read on the paper panel.
const W = 36;
const H = 24;

function us(): string {
  const s = H / 13;
  let out = `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`;
  for (let i = 0; i < 13; i += 2) out += `<rect x="0" y="${(i * s).toFixed(3)}" width="${W}" height="${s.toFixed(3)}" fill="#B22234"/>`;
  const cw = W * 0.4, ch = (H * 7) / 13;
  out += `<rect x="0" y="0" width="${cw.toFixed(2)}" height="${ch.toFixed(3)}" fill="#3C3B6E"/>`;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) out += `<circle cx="${((cw * (c + 0.5)) / 6).toFixed(2)}" cy="${((ch * (r + 0.5)) / 5).toFixed(2)}" r="0.42" fill="#FFFFFF"/>`;
  }
  return out;
}

const DRAGON = `<path fill="#D30731" d="M8.2 9.2 l2.2 -1.6 l1.4 0.6 l1.2 -0.9 l0.4 1.3 l-0.9 1.1 l1.1 1.0 l5.5 -0.3 l3.6 -2.6 l3.4 -1.4 l-1.2 2.4
 l2.6 -0.6 l-1.8 2.2 l2.2 0.4 l-2.6 1.2 l1.8 1.6 l2.6 -1.0 l1.4 -2.4 l0.9 0.5 l-1.0 2.6 l-3.0 1.8 l-2.6 -0.6 l-1.4 1.3
 l0.8 2.6 l1.3 0.5 l-2.2 0.3 l-1.2 -2.6 l-2.6 0.2 l-0.8 2.5 l1.2 0.5 l-2.1 0.3 l-0.7 -2.7 l-2.3 -0.8 l-1.9 1.9 l0.7 1.9
 l-1.9 0.2 l-0.4 -2.2 l1.5 -2.8 l-1.4 -1.6 l-1.2 0.9 l-1.4 -0.5 l0.6 -1.2 l-1.6 -0.4 z"/>`;

const FLAGS: Record<string, string> = {
  FI: `<rect width="${W}" height="${H}" fill="#FFFFFF"/><rect x="10" y="0" width="6" height="${H}" fill="#003580"/><rect x="0" y="9" width="${W}" height="6" fill="#003580"/>`,
  JP: `<rect width="${W}" height="${H}" fill="#FFFFFF"/><circle cx="${W / 2}" cy="${H / 2}" r="${(H * 0.3).toFixed(2)}" fill="#BC002D"/>`,
  FR: `<rect width="12" height="${H}" fill="#0055A4"/><rect x="12" width="12" height="${H}" fill="#FFFFFF"/><rect x="24" width="12" height="${H}" fill="#EF4135"/>`,
  Wales: `<rect width="${W}" height="${H / 2}" fill="#FFFFFF"/><rect y="${H / 2}" width="${W}" height="${H / 2}" fill="#00AD36"/>${DRAGON}`,
  US: us(),
};

/** An inline SVG flag for a code ('' when unknown). */
export function flagSvg(code: string | undefined): string {
  const body = code ? FLAGS[code] : undefined;
  if (!body) return '';
  const outline = `<rect x="0.25" y="0.25" width="${W - 0.5}" height="${H - 0.5}" fill="none" stroke="#000000" stroke-opacity="0.22" stroke-width="0.5"/>`;
  return `<svg class="flag" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">${body}${outline}</svg>`;
}
