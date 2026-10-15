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

Add `?webgl` to the URL to force the WebGL2 renderer instead of WebGPU, and
`?car=<id>` to pick a car (swift, pip, lama, quint, kaze). Keys: W/S throttle
and brake, A/D steer, Space handbrake, R reset, C camera, L livery. A gamepad
works too: triggers, left stick, L1 handbrake, Y reset, X camera.

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
| `blender -b -P tools/blender/export_car_glb.py -- --car swift` | `public/assets/cars/<id>.glb` (Blender 5.2) |

`node tools/check/shot.mjs` drives a production build in headless Chrome and
saves screenshots. Serve `dist/` under `/backroad-rally/` first.
