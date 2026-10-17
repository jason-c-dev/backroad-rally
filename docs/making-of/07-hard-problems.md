# 7. Hard problems

[Index](README.md) · Previous: [Tests](06-tests.md) · Next: [Differences and lessons](08-differences-and-lessons.md)

This chapter gives ten problems from the web port. For each problem, it gives the
symptom, the cause and the fix, with the measured numbers.

## 1. The gravel road was grass

**Symptom.** On the first drive of finland, the wheels reported grass on the gravel road.

**Cause.** A ray cast against a Rapier trimesh does not tell which triangle it hit.
The feature ID is 0 for every triangle. A table of surfaces for each triangle thus
always gave the surface of triangle 0. A test with a mesh of four triangles confirmed
this.

**Fix.** Each terrain tile now has one trimesh collider for each surface. A map from
the collider handle gives the surface.

## 2. One shader program for each chunk

**Symptom.** The stage took a long time to load. The drive had hitches of 60 to
380 ms when new parts of the stage came into view.

**Cause.** In the three.js WebGPU renderer, an `InstancedMesh` with 1024 instances or
less gets its matrices as a uniform block with a unique name. Thus, each mesh gets its
own vertex program. The stage had about 1,200 instanced meshes and compiled 2,202
programs: 8 s at 1920 × 800 and 45 s at 3840 × 1600.

**Fix.** A plain `Mesh` with `InstancedBufferGeometry`, our own per-instance
attributes, and a TSL position node that places each instance. One material serves all
the chunks.

| | Before | After |
|---|---|---|
| Shader programs | 2,202 | 7 |
| Stage load | about 6.4 s | about 0.6 s |
| Draw calls (with culling for each chunk) | 727 | 330 |

## 3. Slides did not lose speed

**Symptom.** Slides cost less speed than in the original game. After a flick on
gravel, swift kept 100 km/h. The original kept 84 km/h. The developer decided that the
port must match the original here.

**Cause.** The agent read the source code of the Unreal vehicle physics and found
three differences:

1. **The throttle is squared.** Unreal limits the rate of each pedal and then gives the
   engine the throttle squared. At 0.3 throttle in a slide, the engine gets 0.09 of its
   torque. The port gave it 0.3, more than three times as much.
2. **Wheelspin means something different.** In Unreal, a wheel spins only when the
   drive torque is more than the tyre can transmit. A slip-curve tyre always slips a
   little while it pulls. Thus, the traction control of the port cut the throttle on
   straight roads, to about 45% in 3rd and 4th gear. The time from 100 to 150 km/h was
   two times too long.
3. **The traction-control load scale** in the original's logged traces was 0.72.

**Fix.** Rate-limited pedals (full in about 0.17 s), the squared throttle, and a
wheelspin value that copies the Unreal method. The load scale is 0.72. The flick exit
is now 88 km/h, and all 221 handling checks still pass.

## 4. The crowds made no sound

**Symptom.** The spectators cheered and jumped, but the developer heard nothing.

**Cause.** The original game puts the audio listener on the car, 1.5 m above it. The
port used the camera, 34 to 55 m behind the car on its arm. The crowd sound fades from
15 m to 105 m, so the crowds were 25 to 35 dB too quiet.

**Fix.** The listener is now on the car. The pan still follows the camera, so a sound
on the left of the screen is still in the left ear. Then the developer said the crowds
were "a little quiet", so their group volume went up by about 5 dB.

| Crowd loudness, 60 s autopilot run | LUFS |
|---|---|
| Listener on the camera | −50.5 |
| Listener on the car | −30.4 |
| Crowd group 0.8 → 1.4 | −25.7 |

## 5. 23 fps on an integrated GPU

**Symptom.** The developer's laptop runs desktop Chrome on its integrated GPU. Chrome on
Linux cannot use the discrete GPU there. The game ran at about 23 to 33 fps.

**Cause.** Tests that switched off one feature at a time found the costs. The trees
took about 34 ms of a 45 ms frame. Post-processing took only about 3 ms.

**Fix.** Several changes, each measured:

- **Tree levels of detail, built at load time.** The foliage is made of single-triangle
  chips. Each lower level keeps an even 35%, 10% or 2.5% of the chips and makes them
  larger, so the canopy covers the same area. No new assets were necessary.
- **Shadow-only copies** of the vegetation that only the shadow cameras see.
- **No discard on fully visible trees.** A shader that can discard pixels loses the early
  depth test. A twin material without the discard saved 2.5 to 4.5 ms on canopies.
- **A cheaper low tier:** fog for each pixel in post-processing (fog for each vertex
  cost about 3 ms), and diffuse-only foliage.
- **Render scale:** a smaller canvas that the browser stretches. An FSR upscale pass
  cost about 3 ms and removed most of the gain.
- **Adaptive quality** that measures real frame times and steps down until the game
  holds 60 fps.

| Integrated GPU, 1080p, 45 s drive | Frames over 25 ms |
|---|---|
| Before | 1,035 of 1,070 |
| After (auto quality settles on low) | 3 of 2,694 |

## 6. Ambient occlusion failed only on WebGPU

**Symptom.** Ambient occlusion and depth of field worked on WebGL2 but failed on WebGPU.

**Cause.** With 4× MSAA, the WebGPU scene pass keeps a multisampled depth texture. The
ambient occlusion shader cannot read it, so its pipeline is not valid. WebGL2 resolves
the depth and shows no error.

**Fix.** On WebGPU, the scene pass has no MSAA, and FXAA at the end of the chain makes
the edges smooth.

## 7. The colours were wrong in a way no curve could fix

**Symptom.** The web colours were less saturated than the original. No change of tone
curve or saturation made them match.

**Cause.** The agent sampled the same regions in both screenshots and fitted the
numbers. The original's output followed the albedo to the power 2.2. The original
converted the vertex colours from sRGB to linear two times.

**Fix.** The port does the same double conversion, because that saturated look is the
look that the developer approved. It also uses the original's filmic tone curve.

## 8. Rocks did not stop the car

**Symptom.** The car drove through roadside rocks.

**Cause.** In Unreal, a mesh with "box" collision and no box given uses its bounding
box. The data export only carried explicit boxes, so most rocks had no collider.

**Fix.** The rocks now take boxes from their mesh bounds, and boulders keep convex
hulls. finland got 651 more rock colliders. A check drives into the largest rocks at
40 km/h.

## 9. Loops clicked at the seam

**Symptom.** Engine and surface loops that were seamless as WAV files clicked after
the encode to Opus or AAC.

**Cause.** A lossy codec does not know that a file loops. The last and the first
samples have independent coding errors. On a quiet engine idle, the step at the seam
was four times the 99th percentile step.

**Fix.** The converter encodes each loop with about 0.1 s of its own wrap-around on
each side. The game plays only the original window, and after the decode it crossfades
the last 256 samples. A check decodes every loop and measures the seam.

## 10. The rev limiter sounded uneven

**Symptom.** The rev limiter cuts sounded irregular.

**Cause.** The limiter cuts at 15 to 24 Hz. The game updated the sound once for each
frame, at 60 Hz, so the cuts aliased.

**Fix.** Each cut is now scheduled on the audio clock, with a volume dip and a pitch
dip as value curves. The check logs the scheduled times to measure the real rate.

## Smaller problems

- **HUD text 25% too small.** Unreal font sizes are points, not pixels. A size of 30 is
  a 40 px em at 1080p.
- **2,447 bushes were missing.** Scenery bushes shared mesh names with breakable bushes,
  and the breakables replaced them.
- **The robot lost 20 s at 4× speed.** It controlled the car once for each frame, not
  once for each physics step. At 4× speed it held one input for up to 30 steps. Now all
  game logic runs inside the physics step.
- **A window resize during the load was lost.** A game that went fullscreen while it
  loaded kept the old canvas size.
- **`vite preview` returned 404 for module scripts.** The checks now serve `dist/` with
  a simple static server.
