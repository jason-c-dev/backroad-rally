# backroad rally

A small top-down rally game with a diorama look, built for the browser with
[three.js](https://threejs.org/). Five cars from four eras, six point-to-point
stages, changing times of day and weather, and a short career against simulated
rivals who also race as ghosts.

It is a non-commercial demo and a work in progress, built in vertical slices.

**Play:** <https://jason-c-dev.github.io/backroad-rally/> (a placeholder until
the first playable slice lands).

## Credits

- Rendering: [three.js](https://threejs.org/) (MIT).
- Sound effects and music generated with [ElevenLabs](https://elevenlabs.io/).
- Engine and UI sounds are synthesised by the project's own scripts.

## Licence

The code is MIT licensed; see [LICENSE](LICENSE). Third-party libraries and
fonts keep their own licences.

## Development

Needs Node 24+.

```sh
npm ci
npm run dev        # http://localhost:5173/
npm test           # unit tests
npm run test:handling   # headless handling tests (all cars, both surfaces)
npm run build      # production build into dist/, served under /backroad-rally/
```

The game opens on the first stage, finland: an intro card, a 3-2-1 countdown
(the clock starts on "go"), then about 3 km of gravel to the finish arch, and
the result. Straying more than 12 m off the road for 0.4 s puts the car back on it a few
metres behind, stopped, for +5 s; so does R (recover). Enter restarts the stage.

Keys: W/S throttle and brake, A/D steer, Space handbrake, R recover, T traction
assist, C camera, L livery, Enter restart, K next time of day, P post-processing
on or off. A gamepad works too: triggers, left
stick, L1 handbrake, Y recover, X camera.

URL options:

| Option | Effect |
|---|---|
| `?car=<id>` | the car: swift, pip, lama, quint, kaze |
| `?dir=reverse` | run the stage backwards |
| `?stage=test` | the flat handling test bench instead of a stage |
| `?draw=near\|medium\|far\|max` | draw distance (×1, 1.5, 2, 3 the base fade bands; default far) |
| `?cond=morning\|afternoon\|sunset\|night\|fog` | time of day (default afternoon); `?cond=stage` uses the stage's own choice (finland: sunset forward, afternoon in reverse) |
| `?quality=auto\|high\|medium\|low` | rendering quality (default auto: measures frame times and settles on what holds 60 fps; see Performance) |
| `?scale=0.5..1` | render scale: the canvas is drawn smaller and stretched to the window (pins it, also under auto) |
| `?upscale=fsr` | with a render scale below 1, upscale with FSR 1 in the post chain instead (sharper, costs more) |
| `?post=0` | no post-processing: the scene straight to the screen at the same exposure (P toggles) |
| `?ao=0`, `?dof=0`, `?bloom=0`, `?msaa=0`, `?cascades=1`, `?hlshadow=0`, `?shadowmap=1024`, `?shadowfar=100` | switch single effects off or down, on top of the quality preset |
| `?hide=tree,grass`, `?lodcuts=50,120,200`, `?lodblend=0.1`, `?shadowrange=180`, `?lookoff=fog,mask,lit` | development: hide instance categories, move the vegetation detail switches, turn shader features off (for measuring their cost) |
| `?hud=0` | hide every overlay (screenshots) |
| `?gputime` | measure GPU time per frame with timer queries (for the check scripts) |
| `?webgl` | force the WebGL2 renderer instead of WebGPU |
| `?autopilot=120` | a robot drives (pure pursuit on the centreline, at most 120 km/h); `&minturn=0.3`, `&apkeys=1` or `2` for a keyboard-style robot |
| `?timescale=4` | run the game four times faster than the clock (headless checks) |

### The look

Untextured, flat-shaded meshes coloured by their vertex colours, lit and graded per
time of day from `public/data/conditions.json`:

- **Materials** share one set of uniforms: a per-surface colour grade per condition,
  night glow, wind. Vegetation sways in the vertex shader (off beyond 90 m); trees,
  grass and props fade in with distance and foliage between the camera and the car
  dithers away so the car stays visible. Both fades are alpha-tested dithers, never
  blended, and shadows ignore them. Lakes take a lighter shore colour where they are
  shallow.
- **Lighting:** a sun with three shadow cascades, a hemisphere sky light, height fog
  that follows the car (with a glow toward the sun at sunset) and, at night, two
  headlight spots and lit windows.
- **Post-processing** (three.js TSL pipeline, WebGPU and WebGL2): tilt-shift depth of
  field focused on the car, ambient occlusion, bloom, colour grading and a filmic
  tone curve, vignette and grain. On WebGPU, where the depth buffer can't be both
  multisampled and sampled, the scene renders without MSAA and FXAA smooths it.

| Quality | Shadows | AO | DOF | Bloom | Anti-aliasing |
|---|---|---|---|---|---|
### Performance

The quality tiers (`src/look/quality.ts`):

| Quality | Shadows | AO | DOF | Bloom | Anti-aliasing | Fog | Vegetation |
|---|---|---|---|---|---|---|---|
| high | 3 cascades, 2048 | half res, 16 samples | 16 taps | on | MSAA 4× (WebGPU: FXAA) | per vertex | full detail to 110 m |
| medium | 2 cascades (1 at night), 2048 | half res, 8 samples | 12 taps | on | FXAA | per vertex | full detail to 70 m |
| low | 1 cascade to 130 m, 1536 | off | 8 taps | off | FXAA | per pixel, in the post chain | full detail to 50 m, diffuse-only foliage, ground cover to 0.75× the draw distance |

- **Vegetation detail.** Trees and shrubs have four levels, built at load time from the
  mesh itself (`src/world/lod.ts`): their foliage is made of single-triangle chips, and
  each lower level keeps an evenly spread 35%, 10% and 2.5% of them, each scaled up so the
  canopy covers the same area. Levels switch by distance with a short dithered
  cross-fade, never a pop. On the two far levels the trunk joins the foliage in one draw.
- **Shadows** come from separate shadow-only copies of the vegetation on layer 1, which
  only the shadow cameras see: full or reduced detail near the car, the coarser levels
  further out, and nothing beyond the shadow range. Tall grass stops casting below high.
- **Dithering costs.** A shader that can discard loses the GPU's early depth test, so
  trees that are fully faded in and away from the car's see-through zone draw with a
  twin material that never discards.
- **Auto quality** (`src/look/autoQuality.ts`, the default) starts from a guess by GPU
  and screen size (a discrete GPU: high, or medium above about 2560×1440; an integrated
  one: low, at 70% render scale on a big screen) and then walks a ladder: high, medium,
  low, then low at 85%, 70% and 55% render scale. While settling (the first ten seconds)
  it steps down as soon as a third of a 1.5 s window went to frames slower than 20 ms;
  later it needs two bad 3 s windows in a row. It steps up only with the GPU timer showing
  plenty of headroom for 20 s, and never back into a rung that failed. The HUD shows the
  tier, the scale and `(auto)`. `?quality=<tier>` pins it.
- **Render scale** draws a smaller canvas and lets the browser stretch it: free, where an
  upscale pass at full resolution cost several milliseconds on an integrated GPU.
- **The fast GPU.** The renderer asks for `powerPreference: 'high-performance'` (WebGPU
  adapter and WebGL2 context). Browsers may ignore it: desktop Chrome on Linux draws
  with the GPU it runs on, which on a hybrid laptop is the integrated one.

### Handling tests

`npm run test:handling` drives every car through the scripted manoeuvres in
`public/data/testtrack.json` (acceleration, the R40 circle, braking, coasting,
key taps, flicks, handbrake turns, hairpins, power slides, high-speed taps and
lane changes) and checks each against its pass band. Options: `--cars swift,pip`,
`--kinds corner,brake`, `--surfaces gravel`, `--quiet` (failures only).
`npx tsx tools/test/probe.ts <car> <throttle> <steer> <seconds>` prints the
car's state over a fixed input.

### Asset conversion

The game's data, meshes and audio come from an earlier engine version of the
game, kept outside this repository. Its location is passed to the converters
with `--ue <path>` or `BR_UE_ROOT`. The converted output is committed, so
building the site needs none of this.

| Script | Output |
|---|---|
| `node tools/convert/data.mjs` | `public/data/`: game data as JSON (engine units; `src/ue.ts` converts at load) |
| `blender -b -P tools/blender/export_car_glb.py -- --car all` | `public/assets/cars/<id>.glb` (Blender 5.2) |
| `node tools/convert/stage.mjs finland` | `public/data/stages/<id>.json` (road, variants, tiles) and `.bin` (instances, six floats each); prints the environment meshes the stage needs |
| `blender -b <source>/Art/Source/Stages/<id>.blend -P tools/blender/export_stage_glb.py -- --stage finland` | `public/assets/stages/<id>.glb`: terrain tiles, backdrop and bridges; material names are the surfaces |
| `blender -b -P tools/blender/export_env_glb.py -- --meshes <list> --name finland` | `public/assets/env/env_<id>.glb`: the stage's vegetation and props, one node per mesh |
| `node tools/convert/glb.mjs <in.glb> [out.glb]` | compresses a GLB for the web: drops the flat normals (kept on foliage, whose canopy normals shape the shading), welds, quantizes, meshopt |

The Blender scripts open the source files read-only and never save them.

### Checks in a browser

Build, then serve `dist/` under `/backroad-rally/` with any static server (for
example a folder holding a `backroad-rally` link to `dist/`, served by
`python -m http.server 4173`). Both scripts use headless Chrome through
playwright-core; set `CHROME_PATH` if Chrome lives elsewhere, and on Linux
`CHROME_ARGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist"` with
`--webgl` gets the GPU instead of software rendering. Headless Chrome can't
screenshot WebGPU.

- `node tools/check/shot.mjs [--webgl] [--size 1920x800] [--params "car=pip"] [--at <s>[,lateral]] [--still]`
  saves screenshots at rest and while driving; `--at` puts the car on the road
  at progress `s` metres first.
- `node tools/check/look.mjs [--webgl] [--conds morning,sunset] [--spots start:62,crest:759] [--sizes 1200x675,3840x1600] [--perf 5]`
  puts the car on the road at fixed spots, rolling at 25 km/h, and saves a
  screenshot per condition, spot and size with the HUD hidden; `--perf` holds
  each spot and prints frame times (add `--params gputime` for GPU time).
- `node tools/check/stage.mjs [--webgl] [--cars swift,pip] [--dirs fwd,rev] [--kmh 120] [--cond night] [--params "quality=medium"]`
  runs the whole stage with the autopilot (four times faster than real time)
  and prints the time per car and direction, resets, spins and the surfaces
  under the wheels. `--perf --size 3840x1600 --seconds 60` runs at real time
  and prints frame times, draw calls, visible instances and the cost of the
  instance update.
- `node tools/check/perf.mjs [--gpu igpu|dgpu] [--sizes 1920x1080,3840x1600] [--seconds 45] [--configs "quality=auto;quality=low"]`
  drives the stage with the autopilot at real time and prints, per configuration,
  the renderer string, the tier auto chose, frame times (mean, p99, max, frames over
  25 ms), GPU timer and CPU costs. `--gpu dgpu` sets the NVIDIA offload variables on a
  hybrid laptop; `--spots 759,1500` parks the car at fixed road positions instead
  (same views for every config); `--uncapped` turns vsync off, which gives the true
  GPU-bound cost for comparing configs; `--headed` measures in a normal fullscreen
  browser window on the desktop (fullscreen uses Hyprland's dispatcher).
