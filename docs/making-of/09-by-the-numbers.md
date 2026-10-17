# 9. By the numbers

[Index](README.md) · Previous: [Differences and lessons](08-differences-and-lessons.md)

## Time

| Part | From | To |
|---|---|---|
| Brainstorm and project creation | Day 1 | Day 2 |
| Unreal Engine game | Day 2 | Day 5 (the session stayed open until day 7) |
| Web port | Day 5 | Day 8 |
| The whole project | | about 6.8 days |

## Model and plan

- **Model:** Claude Opus 5.5, for every message in every session and every agent.
  The logs contain no other model.
- **Plan:** Claude Max 20x, at $200 a month.

## Tokens

The numbers come from the Claude Code session logs, with each message counted once.
The web port numbers are from the end of day 8, after the last slice.

| Part | Sessions | Agent transcripts | Messages | Input | Output | Cache write (5 min / 1 h) | Cache read |
|---|---|---|---|---|---|---|---|
| Brainstorm | 1 | 9 | 268 | 542 | 105,779 | 1,086,277 / 184,357 | 25,166,782 |
| Unreal Engine game | 1 | 37 | 5,078 | 10,232 | 1,350,202 | 32,831,287 / 2,315,229 | 1,263,152,889 |
| Web port | 2 | 16 | 2,949 | 5,944 | 1,029,618 | 19,394,238 / 2,319,521 | 784,004,984 |
| **Total** | **4** | **62** | **8,295** | **16,718** | **2,485,599** | **53,311,802 / 4,819,107** | **2,072,324,655** |

In total, that is about 2.13 billion tokens, and 97.2% of them are cache reads. Each
agent reads its own long context again on each turn, and the cache makes that cheap.
Output, the text and code that the model wrote, is about 2.5 million tokens.

"Messages" are model responses. "Agent transcripts" are the background agents and
their helpers.

## Cost

| Cost | Amount | How |
|---|---|---|
| **Actual cost** | **$200** | One month of the Max 20x plan. The whole project fits in one billing month, and the same plan also paid for other work in that month. |
| API-equivalent cost (for comparison only) | $769.35 | The same tokens at the published API prices for Claude Opus 5.5 |

The API-equivalent cost by part:

| Part | API-equivalent cost |
|---|---|
| Brainstorm | $14.06 |
| Unreal Engine game | $462.35 |
| Web port | $292.94 |
| **Total** | **$769.35** |

The API-equivalent cost by type of token: input $0.07, output $49.71, 5-minute cache
writes $266.56, 1-hour cache writes $38.55 and cache reads $414.46.

## ElevenLabs

All the generated sound and music came from the Unreal project. Its log has 120 API
calls:

| Type | Calls | Result |
|---|---|---|
| Sound effects | 59 | All successful. 54 different sounds, 405.7 s of audio in total. |
| Music | 61 | 43 successful, 39 different tracks, 105 minutes in total. The API refused 18 calls with HTTP 429 (too many requests at the same time). |
| Speech | 0 | |

The log has the credit cost for only 33 of the sound-effect calls: 2,872 credits. It
has no cost for the music and no cost in money.

## Code

| Item | Unreal Engine game | Web version |
|---|---|---|
| Game code | about 27,600 lines of C++ | about 17,500 lines of TypeScript |
| Tools and scripts | about 13,500 lines of Blender Python, plus about 100 editor Python and shell scripts | about 6,800 lines of converters, checks and tests |
| Commits | 95 | 47 on `main`, from 22 pull requests |
| Agent briefs | 33 | 13 |

## How to count it yourself

Claude Code writes one JSONL log for each session in `~/.claude/projects/<project>/`.
The logs of background agents are in a `subagents/` folder below each session.

1. Collect all the `.jsonl` files of the project, with the agent logs.
2. Keep the lines with `"type": "assistant"` and a `message.usage` object.
3. Count each `message.id` only once. Claude Code writes one message on many lines, and
   the output count grows while the message streams. Thus, keep the largest value of
   each field.
4. Add up `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and the
   `cache_creation` fields `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`.
5. Multiply by the prices per million tokens: input $4, output $20, 5-minute cache
   write $5, 1-hour cache write $8, cache read $0.20.

This script does steps 1 to 5 for one or more project folders:

```python
import glob, json, os, sys

# USD per million tokens, Claude Opus 5.5
PRICE = {"input": 4, "output": 20, "write_5m": 5, "write_1h": 8, "read": 0.20}

best = {}  # message id -> the largest value of each usage field
for folder in sys.argv[1:]:
    for path in glob.glob(os.path.join(folder, "**", "*.jsonl"), recursive=True):
        for line in open(path, encoding="utf-8"):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            m = d.get("message") or {}
            u, mid = m.get("usage"), m.get("id")
            if d.get("type") != "assistant" or not u or not mid or m.get("model") == "<synthetic>":
                continue
            c = u.get("cache_creation") or {}
            row = {
                "input": u.get("input_tokens", 0),
                "output": u.get("output_tokens", 0),
                "write_5m": c.get("ephemeral_5m_input_tokens", u.get("cache_creation_input_tokens", 0)),
                "write_1h": c.get("ephemeral_1h_input_tokens", 0),
                "read": u.get("cache_read_input_tokens", 0),
            }
            old = best.get(mid, {})
            best[mid] = {k: max(v, old.get(k, 0)) for k, v in row.items()}

total = {k: sum(r[k] for r in best.values()) for k in PRICE}
print(len(best), "messages", total)
print("API-equivalent USD", round(sum(total[k] * PRICE[k] / 1e6 for k in PRICE), 2))
```

For the actual cost, multiply the monthly price of the plan by the number of billing
months that the work used.
