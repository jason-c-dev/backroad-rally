# 6. Tests

[Index](README.md) · Previous: [How Claude Code did the work](05-how-claude-code-worked.md) · Next: [Hard problems](07-hard-problems.md)

The agents cannot play the game. Thus, most of the work was to make the game
measurable. The web port has five types of automatic test. The developer's own drive is
the sixth, and the most important.

## 1. The handling harness

`npm run test:handling` is a port of the test component from the Unreal game. It drives
every car through scripted manoeuvres on both surfaces, with no browser and no render:

- acceleration, brakes and coast-down;
- the R40 circle (a 40 m radius) for cornering grip;
- key taps, flicks and lane changes;
- handbrake turns, hairpins and power slides;
- light steering at high speed.

The run has 317 jobs and takes about 5 seconds. 221 jobs have a pass band from the
original game's `testtrack.json`. The other 96 jobs only report values. With
`--ue <file>`, the harness prints the original game's result under each line.

| Stage of the port | Pass | Fail |
|---|---|---|
| Vehicle core only (slice 2) | 154 | 69 |
| With the arcade layers (slice 3) | 221 | 0 |
| After handling 2 | 221 | 0 |

Some values against the original game:

| Value | Web | Unreal |
|---|---|---|
| swift, 0–100 km/h | 5.79 s | 5.73 s |
| swift, R40 circle on tarmac | 1.05 g | 1.09 g |
| swift, speed at the exit of a gravel flick, before handling 2 | 100 km/h | 84 km/h |
| The same, after handling 2 | 88 km/h | 84 km/h |

The bands did not show the flick difference, because no band covers it. The slice-3
agent found it in the original's printed results. The developer decided that the port
must match, and it became the main task of "handling 2".

## 2. The autopilot

The autopilot is a robot driver from the original game. It follows the road centreline
with "pure pursuit":

- It aims at a point 9 to 32 m ahead (0.8 s at the current speed).
- It steers in proportion to the heading error (full lock at 18°).
- It sets the target speed from the curvature ahead and the grip.

`tools/check/stage.mjs` runs the full stage in headless Chrome, four times faster than
real time. It prints the stage time for each car and direction, the resets, the spins
and the surfaces under the wheels.

The autopilot also proves that a change is read-only. Effects, audio and damage only
read the car. If the stage times stay the same to the millisecond, the change did not
touch the physics. After slice 6 and after the damage slice, all the times were the
same.

The finland times after handling 2 (autopilot at 120 km/h, minimum turn 0.3):

| Car | Forward | Reverse |
|---|---|---|
| swift | 1:51.650 | 1:49.400 |
| pip | 1:53.192 | 1:50.742 |
| lama | 1:49.592 | 1:47.825 |
| quint | 1:47.800 | 1:46.525 |
| kaze | 1:46.450 | 1:57.167 (one reset) |

All times are within about 1% of the original robot, except kaze in reverse. It runs
wide out of one S-bend.

## 3. Screenshot comparisons

`tools/check/look.mjs` puts the car on the road at fixed positions and takes a
screenshot. The positions and the camera are the same as in the look tests of the
original game. The spots are the start village at 62 m and the big crest at 759 m. Each condition gets a pair
of images, side by side.

The agents did not only compare by eye. They sampled small regions of both images with
ImageMagick and compared the numbers. That found a difference that no adjustment of
tone curve or saturation could fix: the original's colours followed the albedo to the
power 2.2. The [hard problems chapter](07-hard-problems.md#7-the-colours-were-wrong-in-a-way-no-curve-could-fix)
tells why.

## 4. Frame times

`tools/check/perf.mjs` drives the stage with the autopilot in real time for 45 s. It
prints the renderer, the quality tier, the mean, p99 and maximum frame time, and the
number of frames over 25 ms. It can use the integrated or the discrete GPU of a hybrid
laptop.

The agents learned some rules for these measurements:

- Report the p99 and the maximum, not only the mean. A shader problem was not visible
  in the mean at 1080p.
- Compare configurations with vsync off. With vsync on, the timer queries of the
  integrated GPU read too low.
- Run the same baseline at the start and at the end. Sometimes the integrated GPU ran
  about 1.75 times slower for a period, for no known reason.
- To measure a small cost, switch the feature on and off in one page every few
  seconds, and compare the two halves.

## 5. Audio and HUD checks

- `tools/check/audio.mjs` records an autopilot run through measurement taps in the
  page. It prints the loudness of each sound group in LUFS against the mix targets,
  the rev limiter cuts and any clicks. It also checks every loop seam after the codec.
- `tools/check/hud.mjs` sets sizes, settings, speed and damage, and reports any HUD
  panel that overlaps another or goes off the screen.
- `tools/check/rock.mjs` drives into the largest roadside rocks at 40 km/h. It checks
  that the car stops, does not fly up and can reverse away.
- Vitest unit tests cover the unit conversion, the road projection, the stage flow,
  damage, effects, the level-of-detail builder, the audio mix and more. There were 83
  unit tests after the damage slice.

## 6. A human drive

Robots do not drive like people. In the Unreal game, a power-slide change passed 119
feel tests and a 300-run autopilot comparison. Then the developer found it "practically
undrivable on the keyboard". The tests used analogue steering, and the robot eased the
throttle.

Since then, the autopilot also has keyboard modes (`&apkeys=1` or `2`) that steer with
digital keys and no finesse. But the plan still asks the developer to drive every
handling change on a keyboard before the next slice builds on it.
