# Technical reference

This page gives the technical details of the web game: the controls, the URL options,
the systems and the tools. The text is in ASD-STE100 Simplified Technical English.
For the story of how the game was made, read [the making-of](making-of/README.md).

## Contents

- [Development](#development)
- [A stage run](#a-stage-run)
- [Keys and gamepad](#keys-and-gamepad)
- [URL options](#url-options)
- [The look](#the-look)
- [Quality tiers and performance](#quality-tiers-and-performance)
- [Effects](#effects)
- [Damage](#damage)
- [HUD](#hud)
- [Audio](#audio)
- [Handling tests](#handling-tests)
- [Asset conversion](#asset-conversion)
- [Checks in a browser](#checks-in-a-browser)

## Development

You need Node 24 or later.

```sh
npm ci
npm run dev        # http://localhost:5173/
npm test           # unit tests
npm run test:handling   # headless handling tests (all cars, both surfaces)
npm run build      # production build into dist/, served under /backroad-rally/
```

## A stage run

The game opens on the first stage, finland. A run has these steps:

1. An intro card shows.
2. A 3-2-1 countdown starts. The clock starts on "go".
3. You drive about 3 km of gravel to the finish arch.
4. The result shows.

These rules apply during the run:

- The car can go more than 12 m off the road for 0.4 s. Then the game puts it back on
  the road a few metres behind. The car is stopped, and you get a +5 s penalty.
- R (recover) does the same, with the same +5 s penalty.
- Enter restarts the stage.
- A sufficiently hard crash wrecks the car. The car coasts to a stop, and the run ends as
  "dnf · terminal damage".

## Keys and gamepad

| Key | Action |
|---|---|
| W / S | Throttle / brake |
| A / D | Steer |
| Space | Handbrake |
| R | Recover (+5 s) |
| T | Traction assist on or off |
| C | Camera |
| L | Livery |
| Enter | Restart |
| K | Next time of day |
| P | Post-processing on or off |
| U | Speed in km/h or mph |
| I | Speed as a number or a dial |
| F3 | The debug panel |
| M | Mute |
| V | The volume panel |
| . and , | Next and previous music track |

A gamepad also works:

| Gamepad | Action |
|---|---|
| Triggers | Throttle and brake |
| Left stick | Steer |
| L1 | Handbrake |
| Y | Recover |
| X | Camera |

## URL options

Add the options to the page address, for example `?car=pip&cond=night`.

| Option | Effect |
|---|---|
| `?car=<id>` | The car: swift, pip, lama, quint or kaze |
| `?dir=reverse` | Run the stage backwards |
| `?stage=test` | The flat handling test bench, not a stage |
| `?draw=near\|medium\|far\|max` | Draw distance: ×1, ×1.5, ×2 or ×3 the base fade bands. The default is far. |
| `?cond=morning\|afternoon\|sunset\|night\|fog` | Time of day. The default is afternoon. `?cond=stage` uses the stage's own choice (finland: sunset forward, afternoon in reverse). |
| `?quality=auto\|high\|medium\|low` | Render quality. The default is auto: it measures frame times and selects the tier that holds 60 fps (see [Quality tiers and performance](#quality-tiers-and-performance)). |
| `?scale=0.5..1` | Render scale: the game draws a smaller canvas, and the browser stretches it to the window. This pins the scale, also under auto. |
| `?upscale=fsr` | With a render scale below 1, upscale with FSR 1 in the post chain. This is sharper, but costs more. |
| `?post=0` | No post-processing: the scene goes straight to the screen at the same exposure. P toggles it. |
| `?ao=0`, `?dof=0`, `?bloom=0`, `?msaa=0`, `?cascades=1`, `?hlshadow=0`, `?shadowmap=1024`, `?shadowfar=100` | Switch off or reduce one effect, on top of the quality preset |
| `?hide=tree,grass`, `?lodcuts=50,120,200`, `?lodblend=0.1`, `?shadowrange=180`, `?lookoff=fog,mask,lit` | For development: hide instance categories, move the vegetation detail switches, and switch off shader features to measure their cost |
| `?damage=0\|0.5\|1` | Damage level: 1 is full (the default), 0.5 is half, 0 is off. With 0, hits still make sparks and sound. |
| `?startdamage=0.8` | For development: start the first run with damage (smoke from 0.35, fire from 0.7) |
| `?units=kmh\|mph`, `?speedo=number\|dial`, `?hud=80..130` | HUD speed units, speed display and HUD size (%) for this visit. The game does not save them. |
| `?hud=0` | Hide all overlays (for screenshots) |
| `?fx=0` | No effects (to measure their cost) |
| `?crowd=0` | No spectators (to measure their cost) |
| `?audio=0` | No sound |
| `?gputime` | Measure the GPU time for each frame with timer queries (for the check scripts) |
| `?webgl` | Use the WebGL2 renderer, not WebGPU |
| `?autopilot=120` | A robot drives: pure pursuit on the centreline, at 120 km/h maximum. Add `&minturn=0.3`, or `&apkeys=1` or `2` for a keyboard-style robot. |
| `?timescale=4` | Run the game four times faster than the clock (for headless checks) |

## The look

The meshes have no textures. They are flat-shaded and use their vertex colours. The
lighting and the colour grade change with the time of day, from
`public/data/conditions.json`.

### Materials

- All materials share one set of uniforms: a colour grade for each surface and
  condition, the night glow and the wind.
- Vegetation sways in the vertex shader. The sway stops beyond 90 m.
- Trees, grass and props fade in with distance. Foliage between the camera and the car
  dithers away, so the car stays visible.
- Both fades are alpha-tested dithers. They are never blended, and the shadows ignore
  them.
- Lakes have a lighter shore colour where the water is shallow.

### Lighting

- A sun with three shadow cascades.
- A hemisphere sky light.
- Height fog that follows the car. At sunset the fog glows toward the sun.
- At night, two headlight spots and lit windows.

### Post-processing

The post chain uses the three.js TSL pipeline, on WebGPU and on WebGL2. It has these
steps:

- tilt-shift depth of field, with the focus on the car;
- ambient occlusion;
- bloom;
- colour grade and a filmic tone curve;
- vignette and grain.

On WebGPU, the depth buffer cannot be multisampled and also sampled. Thus, on WebGPU the
scene renders without MSAA, and FXAA makes the edges smooth.

## Quality tiers and performance

The quality tiers are in `src/look/quality.ts`:

| Quality | Shadows | AO | DOF | Bloom | Anti-aliasing | Fog | Vegetation |
|---|---|---|---|---|---|---|---|
| high | 3 cascades, 2048 | half resolution, 16 samples | 16 taps | on | MSAA 4× (WebGPU: FXAA) | for each vertex | full detail to 110 m |
| medium | 2 cascades (1 at night), 2048 | half resolution, 8 samples | 12 taps | on | FXAA | for each vertex | full detail to 70 m |
| low | 1 cascade to 130 m, 1536 | off | 8 taps | off | FXAA | for each pixel, in the post chain | full detail to 50 m, diffuse-only foliage, ground cover to 0.75× the draw distance |

### Vegetation detail

- Trees and shrubs have four levels of detail. The game builds them from the mesh when
  it loads (`src/world/lod.ts`).
- The foliage is made of single-triangle chips. Each lower level keeps an evenly spread
  35%, 10% and 2.5% of the chips. Each kept chip is larger, so the canopy covers the
  same area.
- The levels change with distance through a short dithered cross-fade. They never pop.
- On the two far levels, the trunk and the foliage are one draw.

### Shadows

- The shadows come from separate shadow-only copies of the vegetation on layer 1. Only
  the shadow cameras see layer 1.
- Near the car, the copies have full or reduced detail. Further out, they use the
  coarser levels. Beyond the shadow range there are no copies.
- Tall grass casts no shadow below the high tier.

### The cost of dither

A shader that can discard pixels loses the early depth test of the GPU. Thus, trees
that are fully faded in, and away from the see-through zone around the car, use a twin
material that never discards.

### Auto quality

Auto quality is the default (`src/look/autoQuality.ts`).

1. It starts from a guess by GPU and screen size:
   - a discrete GPU: high, or medium above about 2560 × 1440;
   - an integrated GPU: low, at 70% render scale on a big screen.
2. It then moves along a ladder: high, medium, low, then low at 85%, 70% and 55% render
   scale.
3. During the first ten seconds, it steps down when a third of a 1.5 s window has frames
   slower than 20 ms.
4. After that, it steps down only after two bad 3 s windows in sequence.
5. It steps up only when the GPU timer shows sufficient headroom for 20 s. It never
   steps back into a rung that failed.

The HUD shows the tier, the scale and `(auto)`. `?quality=<tier>` pins the tier.

### Render scale and the GPU

- **Render scale** draws a smaller canvas, and the browser stretches it. This costs
  nothing. An upscale pass at full resolution cost several milliseconds on an
  integrated GPU.
- **The fast GPU.** The renderer asks for `powerPreference: 'high-performance'` for the
  WebGPU adapter and the WebGL2 context. Browsers can ignore it. Desktop Chrome on Linux
  draws with the GPU that it runs on. On a hybrid laptop, that is the integrated GPU.

## Effects

The effects are in `src/fx/` and `src/world/crowd.ts`. The values are in
`public/data/fx.json`.

### Particle pools

| Pool | Size | Notes |
|---|---|---|
| Dust | 3072 | |
| Puffs | 512 | Kept for rain splashes |
| Chips | 1536 | |
| Sparks | 384 | |
| Flames | 256 | |

The CPU simulates the particles. Each pool is one instanced draw. Each frame, the live
particles move to the front of their buffers, and only that part goes to the GPU. When
a pool is full, its oldest particle starts again.

### Dust

- Dust comes from each wheel on loose ground from 12 km/h. It is at full rate at
  110 km/h, and there is more when the car slides.
- Each surface has its own colour, rate, size and life. On tarmac, dust comes only
  while the car slides. Each time of day adds a tint.
- The puffs are soft, translucent spheres. They fade toward their silhouette.
- Seen from the game camera, the puffs break into fine dots at the edge from 16 to 26 m
  away.
- They fade where they meet the ground (0.6 m, from the depth buffer). This fade is off
  on the low tier.
- The sun and the sky light them without direction, and a little glow makes them
  visible at night.

### Chips and flecks

- Gravel chips fly back from a wheel that slides or spins.
- Grass and earth flecks come off the road at speed. They bounce, then lie flat.
- A landing after 0.3 s or more in the air makes a ring of dust.
- A crash makes sparks and a puff of dust.

### Skid marks

- A ring of 6144 quads of 35 cm each.
- A tyre makes marks while it slides sideways, spins or locks, or while the handbrake is
  on.
- The marks stay for 25 s, then fade over 12 s. The shader does the fade from the time
  when each mark started.
- Where marks overlap, they do not get darker: a new mark fails the depth test where an
  earlier mark already lies.

### Breakables and solid objects

- The car drives through roadside bushes, which go away in a burst of leaves.
- The car knocks marker posts over. They tumble and then lie on the ground.
- Breakables use a proximity test and no colliders, as in the original
  (`src/world/breakables.ts`). A restart puts them back.
- Trees, rocks and boulders within 30 m of the road are solid, and stop the car
  (`src/world/colliders.ts`):
  - trees are capsules;
  - rocks are boxes the size of the mesh;
  - boulders are their convex hull.

### Exhaust

The exhaust pops on a quick lift at high revs, on hard upshifts and on downshifts. The
turbo cars also have an anti-lag crackle. The flames are bright enough for bloom.

### Spectators

- The spectators stand in the stage's crowd groups off the road (finland: 292).
- They hop when the car passes near and fast, and they step away from it.
- They react as a group: cheers, a near miss, a gasp, a groan after a crash near them,
  and applause at the finish.
- As in the original, they have no colliders.

### Events

`src/game/events.ts` is a small typed event bus with these events: `landing`, `impact`,
`backfire`, `splash` and `crowdReaction`. The audio code listens to them. The events
only watch the car, so the autopilot times and the handling tests are the same with or
without them.

### Cost and check

- On an integrated GPU at 1920 × 1080 (low), the effects cost about 0.3 to 0.8 ms of GPU
  time. On a laptop RTX at 3840 × 1600 (high), they cost 0.35 ms. They cost much less
  than 0.1 ms of CPU time for each frame.
- `?fx=0` switches off the effects, and `?crowd=0` the spectators, for measurement.
- `node tools/check/fx.mjs [--scenes straight,slide,landing,crowd,bush,post,crash] [--size 1920x800] [--cond night]`
  drives scenes on finland (WebGL2). With `--webgpu --noshot`, it checks that the
  shaders compile on WebGPU. It saves screenshots, and prints the live particles, the
  skid segments and the events of each scene.

## Damage

The damage code is in `src/game/damage.ts`. The numbers are in
`public/data/damage.json`.

### Hits

- Hits come from the contact impulses of the car body in the physics solver
  (`src/game/contacts.ts`). The code reads them before each 120 Hz step and does not
  change the simulation.
- The size of a hit is the velocity change that it caused (impulse divided by mass), in
  km/h.
- Hits within 0.2 s become one hit, with the size of the largest.
- Contacts with the ground while the car is upright (landings, scrapes) do not count.

### Damage from each hit

Damage = ((km/h − 15) / 85)² × the damage level.

A head-on stop at 60 km/h thus costs about 0.28 at full damage. A total of 1, or one
hit of 110 km/h or more, wrecks the car and ends the run.

### Effects of damage

- Engine torque × (1 − 0.3 × damage), or × 0.15 when the car is wrecked.
- A small steering pull to one side (0.05 × damage^1.5). The first real hit sets the
  side.
- The paint gets dirty, toward a mud colour. Dust on loose ground adds a little too.
- Smoke from the engine from 0.35, darker and thicker as the damage increases.
- Flames from 0.7.

### Parts, restart and events

- The game also divides each hit between six parts, by where the hit was on the car:
  front, rear, left, right, engine and suspension. The parts only control the HUD
  warning lights. Every effect uses the total value.
- A restart (Enter) repairs the car. No damage carries between stages yet.
- Events:
  - `damage { part, amount, total, parts, kmh, terminal, stage }` on each hit that
    causes damage;
  - `finish { dnf, time, reason }` when a run finishes or retires.

## HUD

The HUD is an HTML and CSS overlay, in `src/hud/stageHud.ts`. Its layout comes from
`public/data/hud.json`. Sizes are in units of a screen 1080 pixels tall, scaled by the
shortest side of the window and by the HUD size setting.

| Position | Contents |
|---|---|
| Top right | The stage time, in a panel of fixed width (tabular digits, so the width never changes). Under it: a +5.0 s pop for each penalty, and the penalties until now. Slots for the live position, the ghost delta and the best time wait below, hidden until the career and the ghosts exist. |
| Left | The stage progress: the start at the bottom, the finish at the top |
| Bottom left | Six damage warning lights (front, rear, engine; left, right, suspension). Off, flashing yellow for a scratch, yellow for damage, flashing red for major damage, red when broken. All red when the car is wrecked. `?damage=0` hides them. |
| Bottom centre | The gear gate: an H pattern with the current gear lit. Reverse is red. |
| Bottom right | The speed, as a number or a dial, in km/h or mph |

### Settings

- The settings stay in the browser (`src/settings.ts`), with one `localStorage` key for
  each section:
  - `backroad-rally.hud`: units, speed display, HUD size and the debug panel;
  - `backroad-rally.audio`: the volumes.
- U, I and F3 change and save the settings. The URL options apply to one visit only.

### Check

`node tools/check/hud.mjs [--webgl] [--shots spec.json]` sets the window size, the HUD
settings, the speed and the damage for each shot. It reports each HUD panel that
overlaps another panel or goes outside the window.

## Audio

Sound starts on the first key or click, because browsers keep audio off until then. A
hint tells you this. **M** mutes. **V** opens the volume panel, with a master slider and
one slider for each group, kept in the browser. **.** and **,** skip the music.
`?audio=0` switches off the sound.

### The audio code

The audio code is in `src/audio/` and uses Web Audio.

- **Engine.** Each car has loops at different revs, for on-throttle and off-throttle.
  They crossfade at equal power by a "sound rpm". The sound rpm is higher than the
  simulation's, with a lead, a blip on a downshift, and free revs during wheelspin and
  in the air.
- **Rev limiter.** Its cuts are scheduled on the audio clock.
- **Tyres.** The roll and skid sounds follow the surface under each wheel.
- **Stage sounds.** The stage adds the ambience (day or night), the crowd from the
  nearest spectators, the bridge rumble, the countdown and the finish.
- **Event sounds.** Crowd reactions, impacts, landings and backfires come from
  `src/game/events.ts`.
- **Music.** The music streams, and gets slightly quieter at full throttle.
- The audio code only reads the game. The simulation runs the same with or without it.

### The mix

Final volume = level × 10^(dB/20) × group × user.

- The groups and the curves come from `public/audio/mix.json`.
- One measured calibration is added: `CALIBRATION_DB` in `src/audio/mix.ts`.
- The targets are levels relative to the engine at full throttle. The music is about
  4 dB below it. The targets are measured, not set by ear.

### Audio conversion

`node tools/convert/audio.mjs [--no-music]` writes `public/audio/`:

- every effect, engine and interface sound as Ogg Opus, plus an AAC copy for browsers
  without Opus (decoded at load);
- the music for the stages that exist now, as Opus only (streamed);
- `manifest.json` and `mix.json`.

The converter pads each loop with its own wrap-around, so the codec cannot put a click
at the seam. It removes all tags.

### Audio checks

- `node tools/check/audio.mjs --loops` checks the seam of each loop after an encode and
  decode.
- `npm run build && node tools/check/audio.mjs [--cars swift,pip] [--secs 40] [--jump-at 32] [--out dir]`
  records a headless autopilot run for each car through measurement taps. It serves
  `dist/` itself on port 4183. It saves `<car>.wav`, and prints:
  - the loudness of each group against the targets;
  - the cuts and the rate of the rev limiter;
  - any clicks.

## Handling tests

`npm run test:handling` drives every car through the scripted manoeuvres in
`public/data/testtrack.json`, and checks each result against its pass band. The
manoeuvres are acceleration, the R40 circle, brakes, coast-down, key taps, flicks,
handbrake turns, hairpins, power slides, light steering at high speed and lane changes.

| Option | Effect |
|---|---|
| `--cars swift,pip` | Only these cars |
| `--kinds corner,brake` | Only these manoeuvres |
| `--surfaces gravel` | Only this surface |
| `--quiet` | Show only failures |
| `--ue <file>` | Print the original game's result for the same job under each line |
| `--trace` | Print the state of the car ten times each second |

`npx tsx tools/test/probe.ts <car> <throttle> <steer> <seconds>` prints the state of the
car for a fixed input.

### The pedals and the traction assists

The pedals work like the vehicle physics of the original:

- Throttle and brake move toward the key or trigger value at a limited rate. They reach
  full in about 0.17 s and release in 0.1 s.
- The engine gets the throttle squared, so a slide at part throttle loses speed.

Traction control and the power-slide assist react to wheelspin only when the drive is
more than the tyre can transmit. They do not react to the small slip that a tyre always
has while it pulls.

## Asset conversion

The game's data, meshes and audio come from an earlier version of the game in another
engine. That version is not in this repository. Give its location to the converters
with `--ue <path>` or `BR_UE_ROOT`. The converted output is committed, so a build of the
site does not need it.

| Script | Output |
|---|---|
| `node tools/convert/data.mjs` | `public/data/`: the game data as JSON, in engine units. `src/ue.ts` converts them at load. |
| `blender -b -P tools/blender/export_car_glb.py -- --car all` | `public/assets/cars/<id>.glb` (Blender 5.2) |
| `node tools/convert/stage.mjs finland` | `public/data/stages/<id>.json` (road, variants, tiles) and `.bin` (instances, six floats each). It prints the environment meshes that the stage needs. |
| `blender -b <source>/Art/Source/Stages/<id>.blend -P tools/blender/export_stage_glb.py -- --stage finland` | `public/assets/stages/<id>.glb`: terrain tiles, backdrop and bridges. The material names are the surfaces. |
| `blender -b -P tools/blender/export_env_glb.py -- --meshes <list> --name finland` | `public/assets/env/env_<id>.glb`: the stage's vegetation and props, one node for each mesh |
| `node tools/convert/glb.mjs <in.glb> [out.glb]` | Compresses a GLB for the web: removes the flat normals (but keeps them on foliage, where the canopy normals shape the shading), welds, quantizes, and applies meshopt |
| `node tools/convert/fonts.mjs` | `public/fonts/`: the HUD's Inter faces (regular, semibold) as WOFF2, with their licence. It needs `woff2_compress`. |

The Blender scripts open the source files as read-only and never save them.

## Checks in a browser

### Set up

1. Build the site.
2. Serve `dist/` under `/backroad-rally/` with a static server. For example, make a
   folder with a `backroad-rally` link to `dist/`, and serve that folder with
   `python -m http.server 4173`.

The check scripts use headless Chrome through playwright-core:

- If Chrome is in a different location, set `CHROME_PATH`.
- On Linux, set `CHROME_ARGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist"`
  and use `--webgl`. This gets the GPU, not software rendering.
- Headless Chrome cannot take screenshots of WebGPU.

### The scripts

- `node tools/check/shot.mjs [--webgl] [--size 1920x800] [--params "car=pip"] [--at <s>[,lateral]] [--still]`
  saves screenshots at rest and while the car moves. `--at` first puts the car on the
  road at progress `s` metres.
- `node tools/check/look.mjs [--webgl] [--conds morning,sunset] [--spots start:62,crest:759] [--sizes 1200x675,3840x1600] [--perf 5]`
  puts the car on the road at fixed spots, at 25 km/h. It saves a screenshot for
  each condition, spot and size, with the HUD hidden. `--perf` holds each spot and
  prints frame times. Add `--params gputime` for the GPU time.
- `node tools/check/stage.mjs [--webgl] [--cars swift,pip] [--dirs fwd,rev] [--kmh 120] [--cond night] [--params "quality=medium"]`
  runs the full stage with the autopilot, four times faster than real time. It prints
  the time for each car and direction, the resets, the spins and the surfaces under the
  wheels. With `--perf --size 3840x1600 --seconds 60`, it runs at real time and prints
  frame times, draw calls, visible instances and the cost of the instance update.
- `node tools/check/rock.mjs [--webgl] [--car swift] [--kmh 40] [--meshes SM_Rock_B,SM_Boulder_A]`
  drives into the largest roadside rocks of each type at 40 km/h. It checks that the car
  stops at each rock, does not fly up, and can reverse away. It saves a screenshot at
  each rock.
- `node tools/check/perf.mjs [--gpu igpu|dgpu] [--sizes 1920x1080,3840x1600] [--seconds 45] [--configs "quality=auto;quality=low"]`
  drives the stage with the autopilot at real time. For each configuration, it prints
  these values:
  - the renderer string and the tier that auto selected;
  - the frame times (mean, p99, maximum, frames over 25 ms);
  - the GPU timer and the CPU costs.
  - `--gpu dgpu` sets the NVIDIA offload variables on a hybrid laptop.
  - `--spots 759,1500` parks the car at fixed road positions, so every configuration
    has the same views.
  - `--uncapped` switches off vsync. This gives the true GPU cost for a comparison of
    configurations.
  - `--headed` measures in a normal fullscreen browser window on the desktop. The
    fullscreen uses the Hyprland dispatcher.
