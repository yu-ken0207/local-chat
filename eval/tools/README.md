# Tool-calling eval

**English** | [繁體中文](README.zh-TW.md)

Measures how well local models call the app's phone tools (calendar, reminders, clarifying questions). It uses exactly the same tool definitions and system prompt as the app, sends each request to a model on your computer, and scores the model's **first reply**. No calendar is touched: tools are only defined, never run. Design background: [Phone actions](../../docs/design-phone-actions.md).

## Cases

[`cases.json`](cases.json) has 25 requests a family member might say, with "today" fixed at Thu 2026-10-29 16:40 (Asia/Taipei):

| Kind | Count | Examples |
|---|---|---|
| Add an event | 8 | "Dentist with the kids next Wednesday at 3 pm", all-day birthdays, a time range, an alert one hour before, a specific calendar, next year |
| Set a reminder | 4 | "Remind me to pay the electricity bill at 9 tomorrow morning", no time given |
| Read the calendar | 4 | "What's on this Saturday?", "Am I free next Tuesday?" |
| Photo | 2 | A school notice with three events, a dental appointment card |
| Should not act | 5 | Small talk (2), too vague to act on (2), "cancel my dentist appointment" (no delete tool, so no writes) |
| English | 2 | "Remind me to call grandma tomorrow at 6pm" |

Each case states what is expected: `tools` (tools that must be called, in any order, with key arguments), `none` (no tool at all), or `noWrite` (no tool that changes data; asking or answering is fine). Times are compared by prefix and titles by substring.

Two scores per model:

- **Right tool**: the expected tools were called (or correctly none).
- **Right tool and input**: the tools are right and the dates, times, and titles are right too.

## Results (2026-10-29, Ollama on the development machine)

v1 is the first system prompt. v2 adds a date table to the prompt (today, tomorrow, the day after, and every day of this week and next) and says optional fields should not trigger questions.

| Model | Right tool v1 | Right tool v2 | Right tool and input v1 | Right tool and input v2 | Avg. seconds v2 |
|---|---|---|---|---|---|
| gemma4:31b | 100% | 100% | 92% | **100%** | 11.6 |
| gemma4:12b | 88% | 92% | 68% | **88%** | 4.2 |
| qwen3:4b | 84% | 88% | 76% | **88%** | 25.4 |
| gemma4:e4b | 68% | 72% | 60% | 68% | 2.8 |
| gemma4:e2b | 84% | 84% | 72% | 68% | 2.0 |

What the numbers showed:

- **Date arithmetic was the main failure, not tool choice.** With v1 even 31B turned "this Saturday" into the wrong day. Giving the model a date table fixed most of it: 12B went from 68% to 88% fully correct and 31B to 100%.
- **Small models ask too much.** e2b and e4b still ask which calendar to use instead of using the default, even when told not to.
- **Ambiguous requests split both ways.** "Movie Friday at 8:30, remind me an hour before" often becomes a reminder rather than an event with an alert; both are reasonable.
- **Multi-item photos are hard.** With the three-event school notice, 12B only added the first event. qwen3:4b missed both photo cases because it can't read images.

Per-case answers are in `results/v1/` and `results/v2/` (one JSON per model, plus a summary listing every miss).

## Run it

Needs Node 22.6 or later and a computer running Ollama:

```bash
npx -y tsx@4.19.2 eval/tools/run.ts --host http://127.0.0.1:11434 --models gemma4:e4b,gemma4:12b [--think qwen3:4b] [--only id1,id2] [--tag v3]
```

Results go to `eval/tools/results/<tag>/<date>-<model>.json` and `summary-<date>.md`.
