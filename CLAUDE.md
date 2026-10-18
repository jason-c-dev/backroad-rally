# backroad rally (web)

A small top-down rally game with a diorama look, for the browser: three.js (WebGPURenderer,
WebGPU with a WebGL2 fallback, TSL shaders), Rapier physics, Vite, TypeScript. It is
published as a static site on GitHub Pages. The README tells what the game is; this file
tells Claude Code how to work on it.

## Read first

- `docs/reference.md`: how each system works (menus, stages, physics, look, weather,
  quality tiers, audio, saves), the URL options for development, the tests and the
  browser check scripts. Read the section for the system you change before you change it.
- `docs/making-of/`: how the game was built, and the lessons. Chapters 7 (hard problems)
  and 8 (differences and lessons) save time when something looks wrong.
- If `CLAUDE.local.md` exists, it has the maintainer's local notes. Follow it too.

## Commands

```sh
npm ci
npm run dev             # http://localhost:5173/
npm test                # unit tests (vitest)
npm run test:handling   # headless handling tests: every car, every surface, every weather
npm run build           # tsc + production build into dist/
```

## Layout

- `src/`: the game. `sim/` (car physics, road), `world/` (stage load), `look/` (materials,
  lighting, post-processing, quality), `game/`, `menu/`, `hud/`, `fx/`, `audio/`, `camera/`.
- `public/data/`: the game data as JSON (cars, stages, conditions, weather, career).
  `public/assets/`: the car, stage and environment models (GLB). `public/audio/`.
- `tools/check/`: browser checks with headless Chrome (playwright-core). They need a build
  served by `node tools/check/serve.mjs`; `vite preview` does not work for them.
- `tools/test/`: the handling tests. `tools/convert/`, `tools/blender/`: the asset converters.

## The assets

The data, models and audio were converted from an earlier version of the game in another
engine. That source is **not public**, so the converters in `tools/convert/` and
`tools/blender/` do not run in a fork. The converted files in `public/` are the source of
truth: change them directly, or add your own converter for new assets.

## How to work

- Make one change at a time, on a branch. Open a pull request.
- Keep the physics stable. After a change to `src/sim/`, `src/car/` or a car's data, run
  `npm run test:handling`, and drive a stage with the robot (`?autopilot=120`) before and
  after. If lap times move, say why.
- Prove a visual change with screenshots at the same camera before and after
  (`tools/check/shot.mjs`, `look.mjs`, `stages.mjs`), and look at them.
- Check the frame rate after a change to the look or the stages (`tools/check/perf.mjs`).
- Keep `docs/reference.md` true when a behaviour, an option or a tool changes. The docs
  are in ASD-STE100 Simplified Technical English: short sentences, one instruction each.
- Leave no dev servers or headless browsers running when you finish.
