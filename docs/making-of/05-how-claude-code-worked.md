# 5. How Claude Code did the work

[Index](README.md) · Previous: [The port to the web](04-the-web-port.md) · Next: [Tests](06-tests.md)

## Roles

| Who | Does |
|---|---|
| The developer | Gives the idea and the taste. Plays the builds. Makes the decisions. Reviewed and merged the pull requests up to #19. |
| The orchestrator | One main Claude Code session. It plans with the developer, writes the briefs, starts the agents, checks their results and makes the commits. From #20, it also merges its own pull requests after the checks. |
| The agents | Background Claude Code agents. Each agent does one slice of work from a written brief and ends with a report. |

## The orchestrator stays small

A Claude Code session has a limited context. Large files, long logs and test traces
fill it quickly. Thus, the orchestrator does not read large sources itself. An agent
reads them, does the work and returns only a short report.

In the Unreal game, the orchestrator used only about 10 to 15% of its context, and
compacted it once. In the first web session, the orchestrator did slices 1 to 3
itself, and its context grew. The developer stopped it: "you're not breaking this down
as sub agents and managing context like we did with UE version". From slice 4, every
slice went to a briefed agent.

## The brief

Each brief is a Markdown file of about 600 to 1,400 words. The orchestrator writes it,
shows it to the developer and waits for a "yes". The brief has these parts:

1. **The role:** the agent name, the job, the folders that it owns, and the other
   agents that work at the same time.
2. **Read first:** the handoff file, the parts of the plan and the wiki notes that apply.
3. **The developer's notes, word for word.** A summary lost the meaning twice in the
   Unreal game. His exact words often pointed straight at the cause.
4. **The tasks:** what to do, why, and how to verify it. For feel or performance,
   the brief says "measure first".
5. **Verification:** the tests to run, the screenshots to take and read, and the
   tables to report.
6. **Rules:** do not commit, do not push, leave no browser or server open, and do a
   check for personal data.
7. **The report:** what the agent must tell at the end.

## One agent cycle

1. The orchestrator writes the brief and gets a "yes" from the developer.
2. The orchestrator starts a background agent with the brief.
3. If the developer has new notes, the orchestrator sends them to the agent while it works.
4. The agent does the work and its checks, then writes a report.
5. The orchestrator reads two to four of the screenshots itself. It does not trust the
   summary alone.
6. The orchestrator runs the tests again and builds the project.
7. The orchestrator commits only the paths of that agent, then opens a pull request.
8. The orchestrator adds the notes for the next agent to the handoff file.
9. The developer reviews and merges the pull request.

## Agents in parallel

Two agents can work at the same time when their files do not overlap. In slice 6, the
effects agent and the audio agent worked in parallel on one branch:

- Each agent owned its own folders.
- Each agent changed only a marked block in the shared `main.ts`.
- A small typed event bus (`src/game/events.ts`) connected them. The effects code sends
  events such as `landing` and `impact`, and the audio code plays the sounds.

The work stopped for one night. The orchestrator stopped the effects agent, which
wrote a progress note. The next morning the agent continued from that note.

## Decisions by the developer

The agents made small decisions themselves and wrote them in their reports. The
developer made the large decisions. Some examples from the web port:

| Day | Question | Decision |
|---|---|---|
| Day 5 | Where and how to publish | A public repository on GitHub Pages, MIT licence, a non-commercial demo |
| Day 6 | Must the web game match the Unreal game, or can it differ? | "Match UE." Bushes break, but rocks and trees are solid. Slides must lose speed as in the original. |
| Day 7 | Damage and HUD before or after the other stages? | Before. A damage and HUD slice came before all the stages. |
| Day 7 | The crowds react but make no sound | A bug: the audio listener was on the camera, not on the car. Fixed in #12. |
| Day 7 | The crowds are "a little quiet" | The crowd volume group went from 0.8 to 1.4, about +5 dB (#13) |
| Day 7 | Night music | Keep the calm night playlist, as in the original |
| Day 7 | Skid marks on gravel look light orange | Make them darker: about `#2E2620` at 0.7 opacity, not `#6A4E34` at 0.6 (queued) |
| Day 7 | The documentation | Name art of rally as the inspiration, with a link. Publish the model, the plan, the tokens and the cost. |
| Day 7 | A white flash on the page every few loads | Caused by auto quality: it stopped with the quality set to high. Fixed in the polish slice (#22). |
| Day 8 | Finish the plan overnight | The orchestrator does slices 8 to 11 without the developer, and "you can merge as we go in future, so avoid conflicts later". |

In the Unreal game, the developer once asked for upscaler options to stop a stutter.
The agent found the real cause first, which was uneven frame pacing. The developer
agreed: "cause fix is better and those options are only valid if they help".

## Branches and pull requests

- No agent and no orchestrator pushes to `main`. Each slice has its own branch and pull
  request. The developer merged them up to #19. From #20, the orchestrator merged each
  one after the checks, so the next slice could start from the new `main`.
- Each branch starts from `main`. Early on, two pull requests were stacked on other
  slice branches. They merged into those branches, not into `main`, so the published
  site did not get them. Pull request #6 fixed this.

## Checks for personal data

The repository is public. Thus, the orchestrator checks every commit and every push.
Every brief repeats this rule. The check looks at the diff, the commit message and the
generated assets:

- machine names, home folder paths and network addresses;
- personal names and email addresses, other than the commit identity;
- real company and sponsor names (one real company name in the game data is replaced
  by an override table in the converter);
- the ElevenLabs API key: a search for the key in all files, which never prints the key;
- the strings inside binary files (GLB, instance data) and the tags in audio files,
  which the converter removes.
