// The loading indicator: lowercase "loading" (or what is loading) and three dots that pulse, quiet, in the menus'
// soft ink. One look everywhere a wait is longer than a moment: the boot screen (index.html), the menus' curtain
// while the diorama builds or swaps, the loading card of a stage, the garage while a car model loads.
//
// Pure CSS (src/style.css .busy): it waits 0.25 s before it fades in, so a short wait shows nothing, and its
// animation is opacity only, which the compositor runs while the main thread is busy building shaders. It lives
// inside the curtain or the card, so it fades with them and is display: none once they are gone.
//
// Between two pages of the game (start a stage, quit, the career's next stage, another backdrop) the page that goes
// writes its curtain and card to sessionStorage (`handOff`); index.html puts them back before the first paint of the
// next page, with the indicator already showing, and the next page's own menus replace them (`takeBoot`).

const KEY = 'backroad-rally.boot';

/** A loading indicator in `parent`. `now`: show at once, without the delay (a wait that is already going on). */
export function busy(parent: Element | null, text = 'loading', now = false): HTMLElement {
  const e = document.createElement('div');
  e.className = now ? 'busy now' : 'busy';
  e.setAttribute('role', 'status');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = text;
  const d = document.createElement('span');
  d.className = 'dots';
  d.setAttribute('aria-hidden', 'true');
  d.innerHTML = '<i>.</i><i>.</i><i>.</i>';
  e.append(t, d);
  parent?.appendChild(e);
  return e;
}

/** While the shaders build and auto quality settles (a few seconds on a first visit): rally jobs, in a random order. */
export const GETTING_READY: readonly string[] = [
  'warming the engine',
  'aligning the wheels',
  'checking the oil',
  'reading the pace notes',
  'topping up the fuel',
  'checking the tyre pressures',
  'tightening the wheel nuts',
  'cleaning the windscreen',
  'briefing the co-driver',
  'adjusting the mirrors',
  'fitting the mud flaps',
  'polishing the headlights',
  'raking the gravel',
  'sweeping the stage',
  'waving the marshals through',
  'shooing the sheep off the road',
  'testing the handbrake',
  'warming the tyres',
];

/** Seconds that each phrase of a list shows. */
const PHRASE_S = 2.5;
const cycles = new WeakMap<Element, number>();

/**
 * What is loading: a text ("loading stage"), or a list of phrases that the indicator shows in a random order, one
 * every PHRASE_S. The swap is a timer on the main thread, so a phrase can stay longer while shaders build; the dots
 * are CSS and keep moving.
 */
export function setBusyText(e: Element | null | undefined, text: string | readonly string[]): void {
  const t = e?.querySelector('.t');
  if (!t) return;
  const old = cycles.get(t);
  if (typeof text === 'string') {
    if (old !== undefined) {
      clearInterval(old);
      cycles.delete(t);
    }
    if (t.textContent !== text) t.textContent = text;
    return;
  }
  if (old !== undefined || !text.length) return; // already cycling
  let bag: string[] = [];
  const next = () => {
    if (!bag.length) bag = shuffle(text.filter((s) => s !== t.textContent));
    t.textContent = bag.pop()!;
  };
  next();
  // stops once the curtain or card is gone (display: none), so no timer runs during a stage
  const id = window.setInterval(() => {
    if ((t as HTMLElement).offsetParent) return next();
    clearInterval(id);
    cycles.delete(t);
  }, PHRASE_S * 1000);
  cycles.set(t, id);
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Let the page draw once (a new indicator text) before a long task on the main thread. */
export const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/**
 * Remove the boot screen (index.html) once this page's own curtain is up. True when its indicator shows already (a
 * hand-off from the last page, or a boot past the delay): the page's own indicator then shows at once too.
 */
export function takeBoot(): boolean {
  const b = document.getElementById('boot');
  const shown = !!b && (b.classList.contains('handoff') || performance.now() > 250);
  b?.remove();
  return shown;
}

/**
 * Leaving for another page of the game: keep this menu root's curtain and card (shown, at full cover) for the next
 * page's first paint, with the indicator showing at once.
 */
export function handOff(root: HTMLElement): void {
  try {
    const c = root.cloneNode(true) as HTMLElement;
    for (const ch of [...c.children] as HTMLElement[]) {
      const curtain = ch.classList.contains('curtain');
      if (curtain) {
        ch.style.opacity = '1';
        ch.style.display = '';
      } else if (!ch.classList.contains('loading') || ch.style.display === 'none') ch.remove();
      else ch.style.opacity = '1';
    }
    for (const b of c.querySelectorAll('.busy')) b.classList.add('now');
    sessionStorage.setItem(KEY, JSON.stringify({ cls: c.className, style: c.getAttribute('style') ?? '', html: c.innerHTML }));
  } catch {
    // no sessionStorage: the next page starts on the plain boot screen
  }
}
