# The making-of backroad rally

backroad rally is a small top-down rally game with a diorama look. You can play it in a
browser at <https://jason-c-dev.github.io/backroad-rally/>.

An AI coding agent, [Claude Code](https://claude.com/claude-code), wrote almost all of
it. One developer gave the ideas, made the decisions and played each build. The work
had two parts:

1. **An Unreal Engine 5 game** for the desktop, in C++ and Python, with assets from
   Blender scripts. It took about four days, from 11 to 14 October 2026.
2. **A web version** of the same game, in TypeScript with three.js and Rapier. It
   took about three days, from 14 to 17 October 2026, in eleven slices.

Claude Code used one model, **Claude Opus 5.5**, for all the work, on a **Max 20x**
plan. The [numbers chapter](09-by-the-numbers.md) gives the tokens and the cost.

![A handbrake slide on the finland stage at sunset, with dust behind the car](../images/slide-sunset.jpg)

## Chapters

| # | Chapter | What it tells |
|---|---|---|
| 1 | [The idea and the inspiration](01-the-idea.md) | Where the game came from, and what it must feel like |
| 2 | [The tools](02-the-tools.md) | Claude Code, Unreal Engine, Blender, ElevenLabs, three.js, Rapier, Vite |
| 3 | [The Unreal Engine game](03-the-unreal-game.md) | Eight phases, about 37 agent runs and five playtests in four days |
| 4 | [The port to the web](04-the-web-port.md) | Why the game moved to the browser, and how |
| 5 | [How Claude Code did the work](05-how-claude-code-worked.md) | The orchestrator, the briefs, the agents and the human decisions |
| 6 | [Tests](06-tests.md) | The handling harness, the autopilot, screenshots and frame times |
| 7 | [Hard problems](07-hard-problems.md) | Ten problems, their causes and the fixes, with numbers |
| 8 | [Differences and lessons](08-differences-and-lessons.md) | What slices 8 to 11 added, what is not the same as the Unreal game, and what we learned |
| 9 | [By the numbers](09-by-the-numbers.md) | Tokens, cost, sessions and agents, and how to count them |

## The short version

- The developer wanted a calm rally game with a diorama look. The model was a
  commercial game that he likes, [art of rally](https://artofrally.com/).
- Claude Code wrote a design, a technical specification and a build plan. Then it
  started background agents. Each agent did one part of the work and wrote a report.
- Art and audio agents worked in parallel. Only one agent at a time worked in Unreal
  Engine.
- The developer played each build and wrote notes. His notes became the next phase.
- Later, the game moved to the browser. The Unreal project became a read-only
  reference, and the agents converted its data, meshes and sound.
- Automatic tests compare the web game with the Unreal game. There are 221 handling
  checks, an autopilot that drives the full stage, and screenshots from the same camera.
- The last four slices (weather, menus, career and ghosts, polish) ran overnight. The
  orchestrator checked and merged each one, and the developer tested the result.

## About this text

This text uses ASD-STE100 Simplified Technical English (STE). STE is a controlled
language from the aerospace industry. It makes technical text easy to read, also for
readers with English as a second language. These are its main rules:

- Use one word for one meaning, and use approved words and technical names.
- Write instructions in sentences of 20 words or less.
- Write descriptions in sentences of 25 words or less.
- Use the active voice, and write only one instruction in each sentence.
- Write paragraphs of six sentences or less.

Technical names such as "shader", "collider" and "autopilot" are permitted. The quotes
from the developer are in his own words.

> [!NOTE]
> backroad rally is a free, non-commercial project with original assets. It is
> inspired by art of rally. art of rally is a game by Funselektor Labs. This project
> has no connection with its makers.
