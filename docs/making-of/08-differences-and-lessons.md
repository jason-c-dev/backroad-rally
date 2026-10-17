# 8. Differences and lessons

[Index](README.md) · Previous: [Hard problems](07-hard-problems.md) · Next: [By the numbers](09-by-the-numbers.md)

## What slices 8 to 11 changed

After the six stages (slice 7), four more slices made the full game.

- **Slice 8, rain and snow.** Each stage can have clear weather, rain or snow. The
  weather changes the grip, the handling, the look, the effects and the sound. Snow puts
  ice on the tarmac, at the same places as in the original, because the port uses the
  same random numbers.
- **Slice 9, the menus.** A title screen over a live diorama, a garage, a stage select,
  pause, results and settings. The game keeps best times and settings in the browser.
  Each change between the menus and a stage is a new page load, so the browser frees all
  the memory of the old stage.
- **Slice 10, career and ghosts.** Four seasons of rallies against nine rivals, with
  points and unlocks. You race the ghost of your best run and the rival ghosts. The ghost
  format is the same as in the original, byte for byte.
- **Slice 11, polish.** This slice fixed what a player sees first:
  - **The white flash.** Auto quality changed the render scale in the first seconds of a
    stage. Each change cleared the canvas, and for one frame the light page background
    showed. Now auto quality selects the tier behind the loading curtain and remembers it
    for the next visit. During the run, it changes only the render scale, and it draws in
    the same frame as the resize. Before: one blank frame and a hitch of 0.8 s after the
    curtain in a forced test. After: no blank frame and no gap over 50 ms on all six
    stages.
  - **Shaders during the run.** The finland lake compiled its shader when it came into
    view, a hitch of 100 to 150 ms. The warm-up now draws every mesh of the stage once.
  - **Old files after a deploy.** Each data file now has a content hash in its URL, so a
    reload gets the new file at once.
  - **Download size.** The models are compressed with gzip: the title downloads 6.4 MB,
    not 7.5 MB, and a stage 5.4 MB, not 6.6 MB.
  - **Open items.** The canyon shade on arizona, the colour of the cherry trees on japan,
    the damage smoke and flames, grazing animals, paler ghosts, and the rival ghosts after
    a restart.

## What is not the same as the Unreal game

This list gives the known differences on 17 October 2026.

### Content

- On arizona, the car bounces longer after a landing in the wash dips (0.8 s, against
  0.55 s in UE). Thus some robot runs there are more than 5% slower than in UE. This is
  a question about the suspension, for a human driver to decide.
- The wheels of the ghost cars do not turn.
- The animals nod and breathe, as in the original, but from the chase camera the
  movement is small.

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

- Forest floors are darker, because the web has no global illumination. On arizona, a
  stronger sky light with a red ground colour stands in for the bounce light in the
  canyon.
- At sunset the road is less orange.
- At night the dust is warmer in colour, and the dust ring after a landing is weak.
- Fire gives no light, because a new light causes all the materials to compile again.
- Damage smoke drifts away from the car in a light breeze. The original had no wind.

### Performance and browsers

- At 3840 × 1600 on an integrated GPU, the game uses low quality at a reduced render
  scale.
- A change of quality tier still compiles the shaders again (0.7 to 1.4 s). Thus the
  game changes the tier only behind the loading curtain, or when you change the setting.
- Chrome on Linux has no WebGPU by default, so it uses WebGL2. With WebGPU switched on,
  Chrome on an integrated GPU can fall back to a software renderer (about 2 fps). The
  game finds this and uses WebGL2 on the GPU.
- Firefox on Linux has no WebGPU yet, so it uses WebGL2.
- Safari before version 18.4 cannot play Ogg Opus, so it has no music. Safari was not
  tested.

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
4. **Change what costs a hitch where the player cannot see it.** A change of shader tier
   stopped the game for up to 1.4 s, also for a tier that the page used before. The
   loading curtain was the only place for it.
5. **Count the frames that the screen shows.** A screen recording of the composited
   frames found the blank frame. The frame times in the page did not show it.
