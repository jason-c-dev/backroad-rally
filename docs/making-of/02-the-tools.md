# 2. The tools

[Index](README.md) · Previous: [The idea](01-the-idea.md) · Next: [The Unreal Engine game](03-the-unreal-game.md)

Claude Code controlled every tool from a terminal. It used no graphical interface and
no plugin for the engine or for Blender. All the work was in scripts and files, so the
next agent could read it, run it again and change it.

## The agent

| Tool | Maker | Use |
|---|---|---|
| [Claude Code](https://claude.com/claude-code) | Anthropic | The agent. It wrote the code, ran the tools, read the results and made commits. |
| Claude Opus 5.5 | Anthropic | The model for all the sessions and all the background agents |
| Max 20x plan | Anthropic | The subscription that paid for the work (see [By the numbers](09-by-the-numbers.md)) |

Claude Code ran in its "auto" permission mode. Allow rules in the project settings let
the long build and cook commands run without a prompt.

## How the developer works with Claude

The developer uses the same setup for all projects, not only for this game.

| Tool | Maker | Use |
|---|---|---|
| [Omarchy](https://omarchy.org/) | Omarchy project | The desktop: Arch Linux with the Hyprland window manager, on each computer |
| [Herdr](https://herdr.dev/) | Herdr project | A terminal workspace for AI agents. Each Claude Code session has its own pane, and Herdr shows the state of each agent: working, blocked on a question, or done. |
| [claude-code-status](https://github.com/jason-c-dev/claude-code-status) | The developer | A status line below the Claude Code prompt. It shows the computer, the folder, the model, the git branch, the context fill and the session cost. |
| [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) | claude-kit | A Claude Code mod. It shows a progress bar above the prompt and a live panel of the background agents, with their model, progress, context and estimated cost. |
| [Obsidian](https://obsidian.md/) | Obsidian | A shared notes vault about the computers and the tools. Each Claude reads it first and writes what it learns, so the next session does not find the same problem again. |
| Claude Code skills | | Small instruction packs, for example for Herdr, for the Omarchy configuration and for the notes vault |

### A fleet of agents

One Claude Code session is the **orchestrator**. It talks with the developer, writes a
brief for each slice of work and starts a **background agent** for it. The developer
can see the agents in the progress panel while they work. Each agent ends with a
report. The orchestrator reads the report, examines the screenshots, runs the tests
and makes the commit. The orchestrator does not read large files itself, so its
context stays small for many days.

When the developer wants to see or control a second session, Herdr opens it in a new
pane. Examples are a long test run, or a second Claude on a different task. A
background agent is better when only the orchestrator needs the result.
[How Claude Code did the work](05-how-claude-code-worked.md) gives the details.

### Some rules

- The developer gives the ideas and makes the decisions. Claude asks when a decision
  belongs to the developer.
- Each change goes through a pull request. No session pushes to `main`.
- Before each push, Claude checks the change for personal data, because this
  repository is public.
- Each Claude writes durable facts to the notes vault, not only to its own memory.

## The Unreal Engine game

| Tool | Maker | Use |
|---|---|---|
| [Unreal Engine 5.8.3](https://www.unrealengine.com/) | Epic Games | The engine, prebuilt for Linux, from the C++ vehicle template |
| C++ | | All the gameplay: about 27,600 lines in the final project |
| Editor Python | Epic Games | Asset import, level builds and screenshots, sent to the open editor through remote execution |
| [Blender 5.2](https://www.blender.org/) | Blender Foundation | All the meshes, from about 13,500 lines of Python generator scripts that run headless (`blender -b -P script.py`) |
| [ElevenLabs](https://elevenlabs.io/) | ElevenLabs | Sound effects and music from text prompts, through the API |
| Python with numpy | | The engine sounds and the interface sounds, made by synthesis |

## The web version

| Tool | Maker | Use |
|---|---|---|
| [three.js](https://threejs.org/) r186 | three.js authors | The renderer: `WebGPURenderer` with TSL node materials. It falls back to WebGL2. |
| [Rapier](https://rapier.rs/) 0.21 | Dimforge | Physics: the car body, the terrain and the colliders. The vehicle model is our own code on top. |
| [Vite](https://vite.dev/) 8 and TypeScript | | The build. About 17,500 lines of TypeScript in `src/`. |
| Vitest | | Unit tests |
| Playwright with Chrome | | Headless browser checks: screenshots, frame times, audio recordings |
| glTF Transform and meshoptimizer | | GLB compression for the web |
| ffmpeg | | Audio encode to Ogg Opus, with an AAC copy |
| [GitHub](https://github.com/jason-c-dev/backroad-rally) Pages and Actions | GitHub | The public repository, the pull requests and the published game |

## How the agent "sees" its work

An agent cannot look at the window of a game while it runs. Thus, every result became a file that
the agent could read:

| Result | Check |
|---|---|
| A Blender asset | Renders from three or four angles to PNG; the agent reads the images. The script prints the polygon count, the dimensions and the material slots. |
| An Unreal level | A screenshot from a script-controlled camera |
| C++ code | The exit code and the output of the compiler |
| The game at run time | The log file, and dev console commands that print the state |
| The web game | Headless Chrome screenshots, and a read-only handle on the page that gives the car state |
| Handling | Tables of measured values against pass bands |
| Audio | Loudness per sound group, measured from a recorded run |

## How the sound was made

The game has three types of sound:

1. **Sound effects from ElevenLabs.** A Python script holds one text prompt for each
   sound, for example tyres on loose gravel. Each prompt also says what must not be in
   the sound: "no engine sound, no music, no voices". The script sends the prompts to
   the ElevenLabs sound-effect API and keeps the results. A second script trims them,
   makes the loops seamless and sets each sound to −16 LUFS.
2. **Music from ElevenLabs.** The same script sends music prompts to the ElevenLabs
   music model. The prompts give the style, the tempo and the instruments for each
   location. They never name an artist or a song. Each track has tags: menu, stage,
   calm or night.
3. **Synthesised engine and interface sounds.** A numpy script models each engine. It
   makes exhaust pulses in the firing order of each car, then filters them with an
   exhaust response for each car. Each loop is 2.4 s of complete engine cycles, so
   the pitch stays correct at all speeds.

The API key stayed in a local file with mode 600. It was never in a commit. After each
audio task, a search of all the files for the key confirmed this.

## The hardware

- A laptop with an integrated GPU and a discrete RTX 5070 Ti laptop GPU. All the
  development happened on this laptop.
- A desktop with an RTX 5090 and a 2.40:1 ultrawide monitor, for playtests.

The ultrawide monitor was important. The developer plays at 3840 × 1600, so every check
of the look and of the frame time also used the 2.40:1 aspect ratio.
