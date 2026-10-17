# 3. The Unreal Engine game

[Index](README.md) · Previous: [The tools](02-the-tools.md) · Next: [The port to the web](04-the-web-port.md)

The first version of the game was a desktop game in Unreal Engine 5.8.3. Claude Code
made it in about four days, from day 2 to day 5. The developer was away for long
periods and slept at night, while the agents continued.

## Three documents first

Before the first agent started, the main Claude Code session wrote three documents:

| Document | Contents |
|---|---|
| Game design (GDD) | What the player sees and does: the cars, the stages, the career, the look, the audio and the menus |
| Technical specification | The contracts: folders, asset names, every JSON data file and its keys, units and axes |
| Build plan | The phases, as tables: which agent does what, when it is done, and what it waits for |

Each agent added an "as delivered" note to the specification at the end of its work.
Thus, the contracts stayed true, and the next agent started from correct data.

## Why some agents ran in parallel and some did not

Blender work can run in parallel, but Unreal work cannot. Each project has only one
editor, the build script needs the editor closed, and Linux has no Live Coding. Thus:

- art and audio agents ran at the same time, each in its own folder;
- only one "core" agent at a time owned the C++ code and the editor.

## The phases

| Phase | Day | Agents | Result |
|---|---|---|---|
| 1. Foundations | Day 2 | cars, vegetation, props, stages, audio, core-1 | 5 cars, about 70 trees, plants and props, the finland and japan layouts, the first sounds, a drivable car on a test track |
| 2. One stage end to end | Day 2 | core-2, core-3, core-4 | The stage runtime, materials, the look for 5 times of day, dust, skid marks, damage, crowds |
| 3. The game | Day 2 | core-5, verify | Career, quick stage, time attack, menus, saves, settings, a packaged Linux build |
| After playtest 1 | Day 2 | feel-1, music-2 | Better dry-road handling, new music |
| 4. Excitement and control | Day 2 | audio-3, core-6 | Energetic stage music, crowd reactions, a new handbrake |
| 5. Weather | Day 2 | core-7 | Clear, rain and snow, with grip, looks and sound for each |
| 6. Four new stages | Days 2–3 | stages-2, veg-3, props-2, audio-4, core-8, verify-2 | alps, wales, arizona and vermont |
| 7. Polish | Day 3 | core-9, stages-3, perf-1, core-10, verify-3 | A new HUD, a ghost of the best run, smooth frame pacing |
| 8. Playtest-4 polish | Days 4–5 | core-11 to core-15 | Engine sound, rival ghosts, power oversteer, a traction assist, longer draw distance |

In total, about 37 agent runs came from 33 briefs. The project had 95 commits, about
920 Unreal assets and about 2.6 GB of binary files in Git LFS.

## The playtest loop

Each phase ended with a "verify" agent. It ran all the tests, fixed small bugs, made a
packaged build and wrote a playtest guide. Then the developer played the build and
wrote notes. The orchestrator copied his notes word for word into the build plan, and
each note became part of a brief.

Some notes from the five playtests, in his words:

- After the first build: the car felt "like driving on ice".
- After playtest 2: the music was "a beautiful drive in the countryside", not rally
  excitement.
- After playtest 3: "Overall car control is good."
- After playtest 4: "No stutter now, even on Epic at 120 fps." Also: "The ghost works
  well and encourages competing with yourself."
- After core-13: the new power oversteer was "practically undrivable on the keyboard".

## Examples of feedback to fixes

| Note | Cause that the agent found | Fix |
|---|---|---|
| "like driving on ice" | Too much engine brake, a squared steering curve, and less rear grip than front grip | feel-1 measured lateral g and yaw response, then fixed all three with numbers |
| Music drowned by effects at "sfx 20%" | The engine had its own volume group, so "sfx" did not include it | "effects" now includes everything except music |
| An occasional jump in the picture, also on an RTX 5090 | Uneven frame pacing when the GPU ran without a frame cap | A 60 fps cap by default, with 120 and 144 as options |
| "practically undrivable on the keyboard" | Six causes. The worst: a 0.15 s key tap gave 5° of wheel at 100 km/h. A fast bend needs about 1°. | Softer key steering at speed, traction control by gear, and a "traction assist" setting |
| Trees "pop in" near the car | Short, fixed cull distances with no fade | Longer cull distances for each preset, a dithered fade, and a "draw distance" setting |

## The test harness

Claude Code cannot play the game. Thus, the agents made tools that let them test it
without the developer:

- **Tuning in JSON files**, with notes in each file. The C++ code reads them, and a
  dev command loads them again while the game runs.
- **Dev console commands** that set the state (damage, weather, camera) and print
  values (HUD geometry, audio levels, engine revs).
- **A script runner** in the game: timed key presses, mouse clicks, commands and
  screenshots. It tests the menus and the career through the real interface.
- **An autopilot** that drives any stage, car and weather at a fixed step. A 100 s stage
  takes about 8 s. Its runs gave the rival target times and the rival ghost lines.
- **Feel tests as pass bands:** 119 checks of lateral g, brakes, flick recovery,
  handbrake and power slides, for each car, surface and weather.
- **A performance capture** on the packaged build: average frame time, 1% and 0.1% lows,
  and spikes per minute.

## The handoff

On day 5 the developer decided to make a web version. The main session wrote a
handoff document of about 7,800 words for it. It listed what carries over unchanged:

- the design and the tuning decisions from five playtests;
- every JSON data file;
- the Blender generator scripts;
- the audio sources and the prompts;
- the handling test bands.

It also listed what does not carry over:

- the Chaos vehicle physics and Lumen global illumination;
- the instanced foliage culling and the Slate interface;
- about 27,600 lines of C++. The next chapter tells how the port replaced them.
