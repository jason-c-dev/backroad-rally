# 8. Differences and lessons

[Index](README.md) · Previous: [Hard problems](07-hard-problems.md) · Next: [By the numbers](09-by-the-numbers.md)

## What is not the same as the Unreal game yet

The web game is a work in progress. This list gives the known differences on
16 October 2026.

### Content

- All six stages are playable in the two directions. You select them with keys or the
  URL, because there is no stage select yet.
- There is no rain or snow, no menus, no garage, no career and no ghosts yet.
- On arizona, the car bounces longer after a landing in the wash dips (0.8 s, against
  0.55 s in UE). Thus some robot runs there are more than 5% slower than in UE.
- The animals do not move, and the canyon shade on arizona is too dark.

### Handling

- When the car coasts through a bend, it rotates 42 to 45°. The original rotates 51 to
  63°. A full port of the Unreal lateral tyre force fixes this, but it then fails the
  flick and lane-change bands.
- The handbrake turn takes about 2 s to exit. lama has less power than in the original,
  and pip reaches only 147 km/h.
- On finland in reverse, the kaze autopilot runs wide out of one S-bend and needs one
  reset.
- Boulders use convex hull colliders. The original used their exact shape.

### Look

- Forest floors are darker, because the web has no global illumination.
- At sunset the road is less orange.
- At night the dust is warmer in colour, and the dust ring after a landing is weak.
- Smoke from a damaged car looks like one dark shape from above. Fire gives no light,
  because a new light causes all the materials to compile again.
- Skid marks on gravel look light orange. A darker colour is in the queue.

### Performance and browsers

- At 3840 × 1600 on an integrated GPU, about 5% of frames take more than 25 ms.
- A change of quality tier compiles the shaders again: a hitch of 0.1 to 0.75 s.
- Chrome on Linux has no WebGPU by default, so it uses WebGL2.
- Safari before version 18.4 cannot play Ogg Opus, so it has no music.

## Lessons

### About the agents

1. **Give each slice to a briefed agent.** The orchestrator keeps a small context and
   does the reviews. When it did the work itself, its context filled up.
2. **Quote the human word for word.** "Like driving on ice" pointed at the cause. A
   summary did not.
3. **Read notes as symptoms, not as instructions.** A request for upscalers became a
   search for the real cause of a stutter.
4. **Look at the screenshots yourself.** A report can say "done" for a picture that is
   wrong. Small visual tasks took two or three passes.
5. **Base every pull request on `main`.** Stacked pull requests merged into the wrong
   branch, and the published game did not get them.

### About the tests

1. **Make the harness first.** The handling bands, the autopilot and the screenshot
   scripts let the agents test without a human. They paid back many times.
2. **Measure before you tune.** Every handling, audio and performance brief asked for a
   table before and after the change.
3. **Read the source of the original engine.** The Unreal vehicle code ships with the
   engine. The squared throttle was in it. Adjustments by eye did not find it.
4. **Robots do not drive like people.** Add a keyboard-style robot, and get a human
   to drive before the next slice.
5. **Test at the player's screen.** A 2.40:1 screen shows about 82° across, against
   66° at 16:9. Its corners see much further, so draw distance and frame time differ.
6. **Set the mix as measured dB targets.** In the Unreal game, the mix swung three
   times when single volumes changed. A mix computed from volume numbers was 3.5 dB
   away from the real signal.
7. **Use exact results to prove that code is read-only.** Effects, audio and damage
   left the autopilot times the same to the millisecond.

### About performance

1. **Remove features one at a time before you optimise.** The trees took about 34 ms of
   a 45 ms frame. The post-processing took only about 3 ms.
2. **Know which GPU the browser uses.** On a hybrid laptop, desktop Chrome draws with
   the GPU that the compositor uses, which is the integrated one.
3. **Use a frame cap by default.** Without a cap, the Unreal game paced frames
   unevenly, and that felt like stutter, also on an RTX 5090.
