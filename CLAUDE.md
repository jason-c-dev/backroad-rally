# BackroadRally (web)

A small top-down rally game with a diorama look, built for the browser with three.js and
published on GitHub Pages. This repo is **public**: keep it free of personal details, machine
names and home paths, and check before every push.

**Read `private/ThreeJS-Port.md` first** when it exists (the build handoff; local only,
gitignored, with its own git history in `private/`).

- Work on branches; open PRs with `gh pr create`. Never push to `main`.
- **All development happens in this folder.** The original UE project (`../BackroadRally/`) is a
  **read-only reference**: read its docs, data, art and audio, and convert from it into this repo,
  but never edit, build, commit to or run tools that write inside it.
