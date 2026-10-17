# Technical reference

This page gives the technical details of the web game: the controls, the URL options,
the systems and the tools. The text is in ASD-STE100 Simplified Technical English.
For the story of how the game was made, read [the making-of](making-of/README.md).

## Contents

- [Development](#development)
- [Menus](#menus)
- [A stage run](#a-stage-run)
- [Settings](#settings)
- [Saves](#saves)
- [Stages](#stages)
- [Keys and gamepad](#keys-and-gamepad)
- [URL options](#url-options)
- [The look](#the-look)
- [Weather](#weather)
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

## Menus

The game opens on the title screen. The menus are in `src/menu/`. They are lowercase
Inter text on light panels, as in the original.

| Screen | Contents |
|---|---|
| Title | career, quick stage, time attack, settings |
| Career | A card that tells what the career will be. The career comes in slice 10. |
| Garage | The car and its livery, the spec sheet and the bio, "choose stage", "back" |
| Stage select | The stage (with its flag), the direction, the time of day, the weather, the best time, "start", "back" |
| Loading card | The stage name, the location, the length, the direction, the time of day, the weather, the mode, the car and the controls |

- **Quick stage** has half damage (`menu.json` `quick_damage_level`). **Time attack** has no
  damage. The best-run ghost of time attack comes in slice 10.
- **Time of day and weather.** "(default)" is the stage's own choice for the direction.
- **Locked cars and liveries.** A fresh save has the swift and the pip (`career.json`
  `start_cars`). The other cars and the bonus liveries are locked, as in the original: the
  car is out of focus under a turning padlock, and "choose stage" is refused. The career
  unlocks them (slice 10). `?unlockall` unlocks all of them for development.
- **The backdrop** is a live diorama: the stage of the selected location, with the selected
  car parked on the road and a camera that turns around it (`menu.json` `diorama`). The car,
  the livery and the time of day change at once. A different location or weather loads the
  page again behind the curtain, with the menu as it was. The diorama has no crowd, no
  effects and no engine sound.
- **Music.** The menu tracks play (`audio_mix.json` `menu`). The song continues when the
  backdrop changes. The bottom right shows the song.
- **Input.** Keyboard, mouse and gamepad move one highlight:

| Action | Keyboard | Mouse | Gamepad |
|---|---|---|---|
| Choose a row | Up / Down (or W / S) | Hover, or the wheel | D-pad or left stick |
| Change a value | Left / Right (or A / D) | Click the value or ‹ ›, right click for −1, hold an arrow to repeat | D-pad or left stick |
| Select | Enter or Space | Click | A |
| Back | Esc or Backspace | | B |
| Next song | . (, for the previous) | | Right shoulder |

### Page flow

The menus and a stage run are separate page loads. When you start a stage, quit a stage
or change the backdrop, the page loads again. Thus the old stage releases all its memory.
`sessionStorage` keeps the screen, the selections and the song for the next page. A stage
run from the menus has an address like
`?mode=quick&stage=wales&car=pip&livery=1&cond=stage&weather=stage`. An address with
`?stage=`, `?car=` or `?autopilot=` and no `?mode=` goes directly to the stage, as before
the menus (for development and the check scripts).

## A stage run

A run has these steps:

1. The loading card stays until the stage draws steadily: 45 frames in sequence under
   25 ms (at least 1.5 s, at most 6 s). Then it fades out in 0.6 s. The simulation does not
   start before this.
2. An intro card shows for 2.5 s.
3. A 3-2-1 countdown starts. The clock starts on "go".
4. You drive about 3 km to the finish arch.
5. The car coasts for 3 s. Then the results show: the time, the penalties, the total and,
   in quick stage and time attack, the best time ("new best time" when you beat it). Select
   "restart stage", "choose another stage" or "main menu".

**Pause.** Esc or the gamepad's Start opens the pause menu: resume, restart stage, recover
car (+5 s), settings, quit to menu. The pause stops the simulation, the stage clock, the
effects and all sounds except the music and the menu sounds.

These rules apply during the run:

- The car can go more than 12 m off the road for 0.4 s. Then the game puts it back on
  the road a few metres behind. The car is stopped, and you get a +5 s penalty.
- R (recover) does the same, with the same +5 s penalty.
- Enter restarts the stage (outside the menus).
- A sufficiently hard crash wrecks the car. The car coasts to a stop, and the run ends as
  "dnf · terminal damage".

## Settings

The settings screen is in the title menu and in the pause menu
(`src/menu/settingsPanel.ts`). A change applies at once and is saved at once.

| Page | Row | Values (default) |
|---|---|---|
| settings | camera | near / default / far / top (default) |
| | field of view | 30–56° in steps of 2 (the camera's own, 40°) |
| | stability assist | off–100% in steps of 25 (100%) |
| | counter-steer assist | off–100% in steps of 25 (100%) |
| | traction assist | on / off (on) |
| | speed units | km/h / mph |
| | speed display | number / dial |
| | hud size | 80–130% (100%) |
| | ghost of best run | on / off (on). Slice 10 draws the ghost. |
| | rival ghosts | off / 3 / all (3). It cannot change until slice 10. |
| sound | master, music, effects, engine, tyres and surface, crowd, ambience, weather, interface | off–100% in steps of 10 (master 80%, the groups 100%); sound on / muted |
| display & graphics | display | window / fullscreen |
| | graphics quality | auto / low / medium / high (auto) |
| | frame-rate limit | 30 / 60 / 120 / 144 fps / uncapped (60) |
| | render resolution | auto / 100% to 50% in steps of 5 (auto) |
| | draw distance | near / medium / far / max (far) |

- The assists multiply the car's own assist values (`cars_tuning.json`). At 100%, the car
  is the same as in the handling tests.
- **Graphics quality.** Auto is the adaptive ladder (see
  [Auto quality](#auto-quality)). The original's highest tier, "epic", is high here: the
  web version has no higher tier.
- **Render resolution and draw distance are separate knobs.** Render resolution draws fewer
  pixels, and the browser stretches them to the window. "Auto" lets the quality ladder set
  it. Draw distance sets how far trees, shrubs and plants show.
- **Frame-rate limit.** The game loop skips the display's frames that come too early. Auto
  quality then counts a frame as slow only when it is later than the limit allows.
- **The debug panel** (F3) is off by default.
- The original had four volume rows on page 1. The web version shows all nine mix groups
  on their own page.

The settings stay in the browser (`src/settings.ts`), with one `localStorage` key for each
section:

| Key | Contents |
|---|---|
| `backroad-rally.hud` | `v`, units, speed display, HUD size, the debug panel |
| `backroad-rally.game` | camera, field of view, stability, counter-steer, traction assist, ghost, rival ghosts |
| `backroad-rally.display` | quality, frame-rate limit, render resolution, draw distance |
| `backroad-rally.audio` | master, mute, the volume of each group |
| `backroad-rally.run` | the last selections: stage, direction, time of day, weather, car, livery |

## Saves

The save is in `src/game/save.ts`, under the `localStorage` key `backroad-rally.save`. It
has a version number (now 1).

| Field | Contents |
|---|---|
| `best` | The best total time (penalties included) for each mode, stage, direction, car and weather, for example `quick:finland:fwd:swift:clear`, with the car and the date. The original kept one time for each car group. |
| `unlocks` | `groups`, `cars`, and `liveries` (the cars with an unlocked bonus livery) |
| `career` | The career slot for slice 10 (empty) |

- A missing, unreadable or damaged save loads as the defaults. The game keeps each field
  that is still valid.
- An older save is migrated. A save from a newer version keeps the fields that this version
  knows.
- Only finished runs in quick stage and time attack record a best time. A retirement does not.

## Stages

There are six point-to-point stages of about 3 km. You can drive each stage forward or
in reverse. Select them in the stage select, or use `?stage=` and `?dir=reverse`, or N and B
in the game. The game downloads only the stage that you select. A stage is 4.4–5.1 MB:
the terrain, its props and plants, the instance table and the road.

| Stage | Road | Features |
|---|---|---|
| finland | gravel | crest jump, lakeside meadow, wooden bridge and log chicane, yumps |
| japan | tarmac with lines | cherry-blossom avenue, a ladder of four hairpins, river bridge |
| alps | tarmac | five switchbacks, snow poles, a tarn, cows with bells |
| wales | gravel | stone walls, a ford through a stream, the moor, a slate quarry, sheep |
| arizona | gravel, with a cracked-tarmac start | wash dips with four jumps, a one-lane canyon, buttes on the skyline |
| vermont | gravel | a covered bridge over the river, the sugar-maple tunnel, a pond |

- **Fords.** The water slows the car when it is below the wheels' depth and faster than
  8 km/h. The drag is 0.15 × the speed, per second. The car throws spray to the two
  sides, and you hear a splash.
- **Canyon walls.** While the car is in the canyon, the walls between the camera and the
  car dither out. The roof of the covered bridge does the same. It casts no shadow while
  the car is under it.
- **Each stage has its own** ambience and music, location sounds near the animals
  (cowbells, sheep), water colour, and light for each time of day. `?cond=stage` selects
  the stage's own time for each direction.
- **Instance table.** The table holds each plant and prop as x, y, z, heading, scale and
  tint. The converter quantizes the values to 16 bits (about 5 cm on a 3 km stage) and
  compresses the table with gzip. The browser's `DecompressionStream` unpacks it at load.
  The converter removes some dense scatter far from the road, as the original did at load
  (the trees on vermont and the cherry trees on japan).

## Keys and gamepad

| Key | Action |
|---|---|
| W / S | Throttle / brake |
| A / D | Steer |
| Space | Handbrake |
| R | Recover (+5 s) |
| Esc | Pause menu |
| T | Traction assist on or off |
| C | Camera |
| L | Livery |
| Enter | Restart |
| K | Next time of day |
| J | Next weather: clear, rain, snow (the game keeps the choice and loads the stage again) |
| P | Post-processing on or off |
| U | Speed in km/h or mph |
| I | Speed as a number or a dial |
| F3 | The debug panel |
| M | Mute |
| V | The volume panel |
| . and , | Next and previous music track |
| N / Shift+N | Next / previous stage (development) |
| B | The other direction (development) |

A gamepad also works:

| Gamepad | Action |
|---|---|
| Triggers | Throttle and brake |
| Left stick | Steer |
| L1 | Handbrake |
| Y | Recover |
| X | Camera |
| Start | Pause menu |

## URL options

Add the options to the page address, for example `?car=pip&cond=night`.

| Option | Effect |
|---|---|
| `?car=<id>` | The car: swift, pip, lama, quint or kaze. Goes directly to the stage. |
| `?livery=<n>` | The livery (0 is the first) |
| `?mode=quick\|attack` | A stage run from the menus: quick stage (half damage) or time attack (no damage). The results offer "choose another stage", and a finish records the best time. |
| `?menu` | Open the menus, also with stage options in the address |
| `?unlockall` | For development: unlock all cars and bonus liveries in the save |
| `?fps=<n>` | Frame-rate limit for one visit (0 = uncapped). Runs with `?autopilot` or `?timescale` are always uncapped. |
| `?stage=<id>` | The stage: finland (the default), japan, alps, wales, arizona or vermont |
| `?dir=reverse` | Run the stage backwards |
| `?stage=test` | The flat handling test bench, not a stage |
| `?draw=near\|medium\|far\|max` | Draw distance for one visit: ×1, ×1.5, ×2 or ×3 the base fade bands. The default is the setting (far). |
| `?cond=morning\|afternoon\|sunset\|night\|fog` | Time of day. The default is afternoon. `?cond=stage` uses the stage's own choice for each direction (finland: sunset forward, afternoon in reverse). |
| `?weather=clear\|rain\|snow\|stage` | The weather. The default is the last choice of the J key, else clear. `?weather=stage` uses the stage's own weather for each direction: alps forward snow, wales forward rain, vermont reverse rain, else clear. |
| `?quality=auto\|high\|medium\|low` | Render quality for one visit. The default is the setting, auto: it measures frame times and selects the tier that holds 60 fps (see [Quality tiers and performance](#quality-tiers-and-performance)). |
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
| `?autopilot=120` | A robot drives: pure pursuit on the centreline, at 120 km/h maximum. Add `&minturn=0.3`. `&apkeys=1` drives as a good keyboard player (it taps toward the steer that it wants). `&apkeys=2` drives as a heavy-handed player (it holds the key). |
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

## Weather

The weather is clear, rain or snow. It is a second setting next to the time of day, so
every stage has 15 looks. The values are in `public/data/weather.json`. The code is in
`src/game/weather.ts`.

### Selection

- `?weather=` selects it for one visit. The J key selects the next weather, keeps it in
  the browser (`backroad-rally.run` in `src/settings.ts`) and loads the stage again. The
  stage select (slice 9) will set the same value.
- The intro card shows the weather after the time of day.

### Grip and handling

| | Tarmac | Gravel | Dirt | Grass | Rock |
|---|---|---|---|---|---|
| Rain | × 0.70 | × 0.86 | × 0.80 | × 0.73 | × 0.75 |
| Snow | × 0.45 | × 0.69 | × 0.65 | × 0.64 | × 0.60 |

- The weather grip multiplies the clear-weather friction of the surface under each wheel.
- The handbrake turns the car more: the handbrake yaw help is × 1.8 in rain and × 2.6 in
  snow. In snow, the rear grip with the handbrake on is × 0.85. The countersteer help is
  × 1.1 in rain and × 1.15 in snow.
- **Ice.** In snow, the tarmac has ice patches: 2.5 for each km, 14–30 m long, with grip
  0.30. The ends blend over 3 m. They are not in the first and last 150 m, in a ford or
  on a bridge. The original's random stream places them, so each stage has the same
  patches in each run (japan: 7, alps: 7; the other stages have no tarmac).
- The robot driver drives at √(weather grip) of its speed and looks up to 60 m ÷ grip
  ahead for turns.

### Look

The weather changes the condition's light, fog and grade (`look` in `weather.json`).

- **Rain:** the sun is × 0.1, the fog is × 2 and starts nearer, the colours are less
  saturated. The roads are × 0.5 darker and the ground × 0.78, and both are glossier.
  Puddles lie in the road's dips. 2600 streaks fall around the camera, and splashes come
  up from the ground around the car. The car body is glossier, with small glints.
- **Snow:** faces that point up are white: the cover starts where the normal's up
  component is 0.5 and is full at 0.78, with a 3 m noise on the edge. The road is packed
  snow with two wheel ruts. Lakes and the ford freeze. Grass tufts and flowers are not
  shown. 4400 flakes fall and sway. Ice patches show as blue-grey glossy areas.
- The rain streaks and the flakes are brighter in the car's headlight cone.
- The depth of field is stronger than in clear weather, as in the original.
- The weather code is in the shaders only in rain and snow. Clear weather has no cost from
  it.
- Each weather and time of day has a calibration of the exposure, the sky light and a
  colour tint (`WEATHER_CALIB` in `src/look/look.ts`). It was measured against the
  original's screenshots.

### Effects

The weather's `fx` block replaces parts of `fx.json`:

- Rain: less dust, smaller and darker dust, and darker chips and skid marks. The skid
  marks on gravel and dirt are near-black, as in clear weather (the data converter sets
  this, `tools/convert/data.mjs`).
- Snow: white snow powder from every surface (also tarmac), white chips and flecks, and
  white tyre tracks behind every wheel. They stay for 60 s. The powder is darker on its
  lower side, so that it shows against the snow.
- Frozen fords have no drag, no spray and no splash.

### Sound

- Rain: the rain ambience replaces the stage's ambience, and rain sounds on the car (the
  `weather` volume group, 0.6).
- Snow: the snow wind replaces the ambience. A low-pass filter at 3500 Hz muffles the
  crowd, effects and surface groups.
- In both, the dry tyre roll is quieter (× 0.6 in rain, × 0.35 in snow), and wet, snow and
  slush loops follow the surface under each wheel.

### Handling tests in weather

`npm run test:handling` runs all the tests in clear, rain and snow. Rain and snow use
the pass bands in `testtrack.json` `targets.weather`, and the slower hairpin and power
slide entries of each weather. Add `--weather clear` (or `rain`, `snow`) for one weather.

### Performance in weather

The rain streaks and the snow flakes are one draw each. The vertex shader moves them, so
the CPU does no work for each particle. All quality tiers draw all particles
(`PRECIP_SCALE` in `src/main.ts` can draw fewer). Snow hides the grass and flowers, so it
draws fewer triangles than clear weather.

`tools/check/perf.mjs`, 45 s from the start, frames at a 60 Hz cap. GPU is the
timer-query mean / p95 in ms.

| Stage | Weather | Integrated GPU, 1920×1080, auto | Over 25 ms | Laptop RTX, 3840×1600, high | Over 25 ms |
|---|---|---|---|---|---|
| alps | clear | low, GPU 10.3 / 12.9 | 0 of 2700 | GPU 11.5 / 15.8 | 83 of 2612 |
| alps | rain | low, GPU 10.3 / 12.7 | 1 | GPU 12.0 / 16.7 | 122 of 2573 |
| alps | snow | low, GPU 9.7 / 11.5 | 1 | GPU 10.6 / 15.8 | 42 of 2648 |
| vermont | clear | low, GPU 10.9 / 13.7 | 16 of 2682 | GPU 10.8 / 14.9 | 35 of 2660 |
| vermont | rain | low, GPU 10.9 / 14.1 | 28 of 2671 | GPU 10.9 / 15.2 | 37 of 2658 |
| vermont | snow | low, GPU 10.5 / 13.2 | 10 of 2689 | GPU 9.9 / 13.3 | 4 of 2690 |
| finland | clear | low, GPU 10.5 / 12.3 | 1 | GPU 12.5 / 14.4 | 15 of 2681 |
| finland | rain | low, GPU 10.7 / 12.6 | 1 | GPU 12.4 / 14.6 | 22 of 2673 |
| finland | snow | low, GPU 10.5 / 12.1 | 1 | GPU 12.5 / 14.2 | 15 of 2677 |

The weather adds less than the noise between runs. The alps larch forest stays the
heaviest part at high on the laptop RTX.

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

### Performance on each stage

`tools/check/perf.mjs --stage <id>` drives 45 s from the start, with frames at a 60 Hz
cap. GPU is the timer-query mean / p95 in ms. On an integrated GPU, this value is too low.

| Stage | Integrated GPU, 1920×1080, auto | Over 25 ms | Laptop RTX, 3840×1600, high | Over 25 ms |
|---|---|---|---|---|
| finland | low, GPU 10.5 / 12.4 | 2 of 2696 | GPU 12.3 / 14.3 | 13 of 2688 |
| japan | low, GPU 10.3 / 11.4 | 0 | GPU 10.8 / 12.8 | 0 |
| alps | low, GPU 9.9 / 12.6 | 0 | GPU 11.7 / 15.8 | 85–90 of ~2610 |
| wales | low, GPU 9.4 / 10.7 | 2 | GPU 9.1 / 11.7 | 1 |
| arizona | low, GPU 9.2 / 10.1 | 0 | GPU 8.9 / 11.3 | 0 |
| vermont | low, GPU 10.8 / 13.9 | 24 of 2675 | GPU 11.1 / 14.8 | 33–46 of ~2660 |

The heaviest parts are the larch forest on alps (s 600–1000) and the sugar-maple tunnel
on vermont (s 900–1800). Their dense canopies use 14–16 ms of GPU time. On full-stage
runs, alps dropped 1 frame in total (high), and vermont dropped 7 (integrated GPU).

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

- The spectators stand in the stage's crowd groups off the road (182–292 on each stage).
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

U, I and F3 change and save the HUD settings. The settings screen has the same rows (see
[Settings](#settings)). The URL options apply to one visit only.

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
- **Stage sounds.** The stage adds the ambience (the stage's own by day, one night
  sound for all stages), the crowd from the nearest spectators, the wooden-bridge rumble,
  the countdown and the finish. Cowbells and sheep sound from time to time near the
  animals.
- **Event sounds.** Crowd reactions, impacts, landings, ford splashes and backfires come from
  `src/game/events.ts`.
- **Music.** The music streams: the stage's own tracks, and calm night tracks at night.
  It gets slightly quieter at full throttle.
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
- the music (menu, night and the tracks of each stage, about 69 MB), as Opus only
  (streamed, one track at a time);
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
| `node tools/convert/stage.mjs <id>` | `public/data/stages/<id>.json` (road, variants, tiles, fords, water) and `.bin` (the instance table, quantized and compressed with gzip). It prints the environment meshes that the stage needs. |
| `blender -b <source>/Art/Source/Stages/<id>.blend -P tools/blender/export_stage_glb.py -- --stage <id>` | `public/assets/stages/<id>.glb`: terrain tiles, backdrop and bridges. The material names are the surfaces. |
| `blender -b -P tools/blender/export_env_glb.py -- --meshes <list> --name <id>` | `public/assets/env/env_<id>.glb`: the stage's vegetation and props, one node for each mesh |
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
- `node tools/check/stages.mjs [--webgl] [--stages japan,wales] [--dirs fwd,rev] [--conds morning,night,stage] [--weathers clear,rain,snow] [--headed]`
  loads each stage for each direction and time of day. It reports console errors, load
  and build times, instances, colliders, fords, bridges and canyon zones. It saves a
  screenshot at the start. `--headed` opens a normal window, for WebGPU.
- `node tools/check/stage.mjs [--webgl] [--stage japan] [--cars swift,pip] [--dirs fwd,rev] [--kmh 120] [--cond night] [--params "quality=medium"]`
  runs the full stage with the autopilot, four times faster than real time. It prints
  the time for each car and direction, the resets, the spins and the surfaces under the
  wheels. With `--perf --size 3840x1600 --seconds 60`, it runs at real time and prints
  frame times, draw calls, visible instances and the cost of the instance update.
- `node tools/check/flow.mjs [--size 1920x1080] [--input keys|pad|mouse] [--webgpu] [--noshot] [--headed]`
  walks the game: title, garage (also a locked car), stage select (also a backdrop change),
  the loading card, the stage, pause, the three settings pages, the results, back to the
  stage select and the title. It saves a screenshot of each screen, checks that the clock
  stops during the pause, and prints the console errors. `--input pad` uses a simulated
  gamepad. With `--webgpu --noshot` it walks on WebGPU in headless Chrome.
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
