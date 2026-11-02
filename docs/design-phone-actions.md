# Phone actions: an agent loop with confirmation and undo (design)

**English** | [繁體中文](設計_手機上動手做事.md)

Status: first version done (2026-10-29). K1–K6 are complete: tool forwarding in the helper, the action framework, calendar and reminders, clarifying questions and checklist cards, the tool-calling eval, and 10 on-device checks that all passed. A second round on 2026-10-30 added a time picker and a "skipped" wording; 13 on-device checks passed.

Implementation note: in Expo SDK 58 the new `expo-calendar` API is an empty shell inside Expo Go, so the app uses `expo-calendar/legacy` (`src/tools/expoCalendar.ts`). A date without a time means 00:00 that day. An event without an end time gets one hour (marked as guessed). An event without a calendar goes to the default calendar; that is not marked as guessed, but the card says "default calendar".

## 1. Goal and scope

**Goal**: the model on the user's computer decides what to do, and the phone does it (for example, add an event or set a reminder). Family members should be able to use it without reading anything. Every action that changes something is confirmed by a person first and can be undone.

**First set of abilities**: read the calendar, add events, set reminders, and "photo to event" (take a picture of a school notice; the AI reads the dates and adds them).

**Out of scope**:

| Not doing | Why |
|---|---|
| Tapping the screen or driving other apps | iOS does not allow it |
| Reading files, running commands, editing files | Family users don't need it; small local models often call tools wrong; high risk |
| Letting the AI build Shortcuts | Shortcut files need signing on a Mac |
| Android | Decided not to |

**Reference**: the action mechanism of Claude Code (public Agent SDK docs, links in section 17). Only the design is borrowed, not the SDK itself: the SDK only works with Claude models, and this app uses local models.

## 2. Terms

| Term | Meaning |
|---|---|
| Tool | An action the AI can call, such as "add event" |
| Turn | One model reply plus running the tools it called |
| Agent loop | Turn after turn until the model stops calling tools and gives a final answer |
| Confirmation card | A card that asks the user to confirm before acting; its fields can be edited |
| Checklist card | When several things are done at once, they are listed on one card |
| Action log | Every action taken: what was done and how to undo it |

## 3. Architecture

| Part | Responsibility |
|---|---|
| Phone app | Tool list, agent loop, permission checks, confirmation cards, running the tools, action log and undo |
| Helper (desktop) | Forwards the tool list and tool calls to the engine behind it (section 11) |
| Model on the computer | Decides whether to call a tool, which one, and with what input |

Flow: the phone sends the conversation and the tool list to the computer; the model replies with tool calls; the phone checks them, shows a confirmation card if needed, runs them, puts the results back into the conversation, and sends again, until the model gives a final answer.

Calendar data only travels between the phone and the user's own computer. No cloud service is involved.

## 4. Tool definition (MCP format)

Each tool has the three MCP fields (name, description, input schema), plus MCP annotations and fields the app needs:

```ts
type PhoneTool = {
  name: string;                 // name the model sees, e.g. create_event
  description: string;          // description the model sees (English, see section 16, item 1)
  inputSchema: JSONSchema;      // validated by the app before running
  annotations: {
    readOnlyHint?: boolean;     // read-only: can run right away and in parallel
    destructiveHint?: boolean;  // deletes something
    idempotentHint?: boolean;   // running twice does not create duplicates
  };
  requiresUserInteraction?: boolean; // always needs a tap; no "don't ask again" (as in Claude Code)
  permission?: 'calendar' | 'reminders' | 'notifications'; // iOS permission to request
  label: string;                // plain name on screen, e.g. "Add event"
  verb: string;                 // verb on the confirm button, e.g. "Add", "Set reminder"
  describe(input): string;      // one sentence on the confirmation card
  fillDefaults?(input): { input; guessed: string[] }; // fill fields the user didn't give; report which were guessed (shown faded)
  check?(input): string | null; // app rules checked before running; returns the reason on failure
  run(input): Promise<ToolResult>;
  undo?(result): Promise<void>;
};
```

**First tools (at most 6; small models are more accurate with fewer tools)**

| Name | Plain name | Kind | Input | Returns | Undo |
|---|---|---|---|---|---|
| `list_calendars` | See calendars | Read-only | none | Name, writable or not | Not needed |
| `list_events` | Read calendar | Read-only | Start, end | Up to 10: title, time, calendar | Not needed |
| `create_event` | Add event | Changes data | Title, start, end, all-day, location, notes, alert minutes, calendar | Event ID | Delete the event |
| `create_reminder` | Add to Reminders | Changes data | Title, due time, notes | Reminder ID | Delete the reminder |
| `ask_user` | Ask a multiple-choice question | Asks the user | See section 8 | The user's choice | Not needed |

"Photo to event" is not a separate tool: the user sends a photo as usual, and the model reads it and calls `create_event`.

The current date, weekday, time, and time zone are not a tool. They are written into the system prompt every time (small models often don't know today's date).

**Tool results are kept short**: only the needed fields (no notes or attendees) and a capped number of items, because local models have small context windows.

## 5. Agent loop

1. Send: the conversation, the tool list, and the system prompt (today's date and time, time zone, reply language, rules).
2. Model replies: text and tool calls may both appear. Text streams as usual; a tool call shows "Checking your calendar…".
3. No tool call: done.
4. Tool calls: each is checked (the tool exists, the input matches the schema, the app rules pass), then goes through the permission steps in section 6, then runs.
   - Read-only tools may run in parallel; tools that change data run one at a time (as in Claude Code).
   - Two or more changing actions in one reply are merged into one checklist card (section 9).
5. Put each tool result back into the conversation (`role: tool`) and go back to step 2.

**Limits and endings**

| Ending | When | What the screen says |
|---|---|---|
| Done | The model stops calling tools | The model's answer, with a list of what was done (undoable) |
| Out of turns | More than 5 turns (configurable) | "Stopped halfway", plus what was already done |
| Error | Connection lost or engine error | The existing error explanation, plus what was already done |
| User stopped | The user taps stop | Stops at the current step; what was done is kept and undoable |

**Error handling**

- Invalid input, an unknown tool, or a failed app rule: the reason (in English) goes back to the model to try again. A retry counts as a turn and is limited by the 5-turn cap (a separate per-tool retry counter turned out to be unnecessary).
- The user sends a new message while a confirmation card is still waiting: every pending action is treated as declined, and the model is told the user didn't confirm and said something else instead. The line on screen says "Skipped: … (you typed instead)", which is different from "Not done: …" after tapping Decline.
- iOS permission denied: the model is told the user didn't grant calendar access, and the screen shows an "Open Settings" button.
- The model doesn't support tools (`/api/show` capabilities has no `tools`): no tool list is sent and the chat works as before.

## 6. Permission checks (four steps, simplified from Claude Code)

1. **Deny**: a tool not in the list, or an app rule that fails (for example, a time in the past or more than a year ahead), is refused and the reason goes back to the model.
2. **Always ask**: tools marked `requiresUserInteraction` or `destructiveHint` always show a confirmation card, with no "don't ask again".
3. **Read-only**: tools marked `readOnlyHint` run directly (the first time, iOS asks for permission).
4. **Other changing tools**: show a confirmation card.

Claude Code also has allow/ask/deny rules, several modes, and AI-assisted review. That is too complex for family users, so the first version leaves it out.

## 7. Confirmation cards and interaction

Decided on 2026-10-29: confirmation cards live inside the conversation (not a bottom sheet); fields the AI guessed are shown faded; buttons use concrete verbs.

**Confirmation card**

- **Inside the conversation**: cards sit among the messages and stay in the history. If the user switches away or the app is killed, the card is still there when they return, and tapping it continues the work. In the chat list, a conversation with an unanswered card is marked "Waiting for you".
- **Content**: one plain sentence, such as "Add 'Dentist with the kids' to the 'Family' calendar on Wed 11/4, 15:00–16:00", with editable fields below.
- **Guessed fields are faded**: fields the user didn't give, filled in by the AI or the app (such as the end time or the calendar), are shown faded so the user checks them. How the app knows: the model only fills the fields the user mentioned; the tool's `fillDefaults` fills the rest (end time = start + 1 hour, default calendar), and those are the guessed ones.
- **Buttons use concrete verbs**:
  - **Add / Set reminder** (the tool's `verb`): run it and return the result to the model.
  - **Edit**: fields become editable, then the user taps the verb button. Start and end times use the built-in iOS date and time pickers (an all-day event only has a date; optional times can be removed or added). The result sent back to the model says what the user changed. (Claude Code doesn't tell the model; this app does, so the answer matches what actually happened.)
  - **Decline**: the user can add an optional reason, which goes back to the model so it can try another way or stop.
  - **One last reminder**: putting the outcome only in the tool result was not enough. Gemma 4 31B often repeated its own plan (saying "done" after the user declined, or using the old date after the user changed it). So when a turn includes a decline or an edit, one more line is added at the end of what is sent to the model: which action was not done and which one was actually done, and the answer must say so. ("Don't say it was done" didn't work; "the answer must say it was not done" did.)
- **Haptics**: a tap on the verb button and another when done.

**Mockups** (in the app's current style: `›` is the user, `•` is the AI)

Add an event from one sentence:
```
› Dentist with the kids next Wednesday at 3 pm

• Checked your calendar (1 event that day)      ⌄
  ┌ Add event
  │ Wed 11/4, 15:00–16:00     (16:00 is a guess, faded)
  │ Dentist with the kids
  │ Calendar: Family · alert 30 min before (guess, faded)
  └ [Decline]   [Edit]   [Add]
```
After tapping Add:
```
• Added to your Family calendar. You'll get an alert 30 minutes before.
  You also have "Morning meeting" that morning.
  ✓ Added 1 event                             [Undo]
```

Photo of a school notice (checklist card, section 9):
```
› [photo: school notice] Add these to my calendar

• The notice has 3 events:
  ┌ Add 3 events to "Family"
  │ ☑ Sat 11/7  09:00   Sports day
  │ ☑ Fri 11/13 18:30   Parent-teacher meeting
  │ ☑ Fri 11/20 all day Field trip
  └ [Decline]   [Edit]   [Add 3]
```

Ask when unsure (section 8):
```
› Remind me to pay the electricity bill tomorrow

• What time tomorrow?
  ( 9:00 am )  ( 12:00 pm )  ( 8:00 pm )  ( Other… )    Skip
```

Decline and say what to change:
```
  What should change? (optional)
  │ Make it Thursday
  └                                  [Send]

• OK, Thu 11/5 at 15:00. (followed by a new confirmation card)
```

Just a question, no card:
```
› What's on my calendar this week?

• Checked your calendar (5 events)             ⌄
• You have 5 events this week: Monday 9:00 morning meeting, Wednesday…
```

**Other moments**

- **First use**: the AI explains it needs calendar access to add events, then the iOS permission prompt appears. If denied, the AI says it can't and shows an "Open Settings" button.
- **Undo**: a line appears: "Deleted 'Dentist with the kids'".
- **Settings**: "What the AI can do" has one switch each for Calendar and Reminders, and below it "Actions taken", where every item can be undone (section 10).

## 8. Clarifying questions (`ask_user`)

Based on Claude Code's AskUserQuestion, scaled down for small models:

- One question at a time, 2–4 options, plus a fixed "Other (type your own)".
- Each option has a short name and one sentence of explanation.
- The model receives `{ question: chosen option }`, or the typed text.
- The system prompt tells the model "ask when unsure, don't guess", for example when it doesn't know which calendar to use.

## 9. Checklist cards (several actions at once)

Claude Code has a planning mode that lists steps before acting. A separate mode is too much for small models, so instead:

- When one reply contains two or more changing actions, the app merges them into one checklist card. Each item can be unchecked or edited, and one verb button runs them all (for example "Add 3").
- While running, the card shows "Adding event 2 of 3". Progress comes from the app's list, not from a to-do list the model has to maintain.

## 10. Action log and undo

- Every changing action that runs is logged: tool, input, result (such as the event ID), time, which message of which conversation it belongs to, and status.
- Statuses: waiting for confirmation, declined, done, failed, undone.
- Under the answer: "Done: added 1 event" with an Undo button, which runs the tool's `undo`.
- Deleting a conversation does not delete events that were added; only the log is removed.
- Regenerating an answer does not repeat actions already taken; actions in the new version need confirmation again.
- Restoring a backup on a new phone restores the log, but event IDs are not valid there, so those actions can't be undone.

**Database (schema version 5)**

- `messages.role` adds `tool`; new columns `tool_calls` (tool calls from the model, JSON) and `tool_name` (which tool a tool message belongs to).
- New table `actions`: one row per action, with the fields above plus status.
- Tool messages are collapsed on screen into one line such as "Checked your calendar (3 events)"; tap to see details.

## 11. Changes in the helper

| Engine | What to do |
|---|---|
| Ollama | Already forwarded as-is: tool lists, tool calls, and `role: tool` pass through. Only tests were added to confirm streamed tool calls reach the phone intact |
| LM Studio and OpenAI-compatible servers | Add `tools` to `ChatRequest` and `tool_calls` / `tool_name` to `ChatMessage`; translate the tool list to OpenAI format (`type: function`); streamed tool calls arrive as text fragments and must be assembled, then converted to Ollama format (arguments as an object); `role: tool` messages are translated to OpenAI's `tool_call_id` form (the helper generates an ID when there isn't one) |
| Model list | Non-Ollama models get a "supports tools" flag (LM Studio has `trained_for_tool_use`) so the app knows whether to send tools |

## 12. Models and prompts

- Only models that support tools get them. All models on the development machine (Gemma 4 e2b, e4b, 12b, 31b and Qwen3 4B) report tool support.
- The system prompt includes today's date, weekday, current time, and time zone; the reply language; "use ask_user when unsure"; "only use dates the user said or that appear in the photo, never invent them"; and "after acting, say what you did in one plain sentence".
- Thinking mode and tools can be on together (Ollama supports it).
- **Eval results (2026-10-29, [`eval/tools/`](../eval/tools/README.md))**: 25 requests (including two photos: a school notice and a dental appointment card) against the development machine's Ollama. With the first prompt, every model often got dates wrong (even 31B turned "this Saturday" into 11/1). After adding a date table to the prompt (today, tomorrow, the day after, and every day of this week and next) and saying that optional fields should not trigger questions:

  | Model | Right tool and right input (first prompt → date table) | Avg. seconds |
  |---|---|---|
  | gemma4:31b | 92% → 100% | 11.6 |
  | gemma4:12b | 68% → 88% | 4.2 |
  | qwen3:4b | 76% → 88% (the 2 misses are photos; it can't read images) | 25.4 |
  | gemma4:e4b | 60% → 68% | 2.8 |
  | gemma4:e2b | 72% → 68% | 2.0 |

  Remaining common mistakes: small models (e2b, e4b) still ask about optional fields (which calendar); "movie, remind me an hour before" often becomes a reminder instead of an event with an alert (both are reasonable); with the three-event school notice, 12b only added the first. Run with: `npx -y tsx@4.19.2 eval/tools/run.ts --models ... --tag v3`.
- **Eval plan**: 20–30 things family members actually say (such as "dentist with the kids next Wednesday at 3 pm" or "remind me to pay the electricity bill tomorrow morning") plus a few photos of notices, run on each model to measure how often the right tool is called and the time is right, to choose the default model and decide whether small models get tools.

## 13. iOS permissions and Expo Go

- `expo-calendar` (covers both Calendar and Reminders) is built into Expo Go; install with `npx expo install`.
- Permission is requested the first time it is needed, not at app launch.
- In Expo Go the permission text belongs to Expo Go and can't be changed; a standalone build will set its own text in `app.json`.
- The agent loop only runs while the app is open. If the user switches away mid-way, it stops before the next confirmation card or the next turn and continues on return. Running in the background with the phone locked is a separate, later feature.
- Settings gets "What the AI can do": one switch per category, plus "Actions taken" (the action log).

## 14. Tests

- **Unit tests**: the agent loop (a fake model calls tools from a script), the four permission steps, input validation, app rules, undo, database migration.
- **Component tests**: confirmation card (verb button, edit, decline, faded guesses), checklist card, multiple-choice question, card still there after the app is killed.
- **Helper (Go)**: tool translation to OpenAI format, assembling streamed tool calls, Ollama pass-through.
- **Eval**: see section 12.
- **iPhone**: a "phone actions" section in the device checklist.

**On-device results (2026-10-29)**: an iPhone on 4G with Tailscale, talking directly to Ollama on a test workstation, model Gemma 4 31B, one check at a time; all 10 passed. Problems found were fixed:

| # | Check | Result |
|---|---|---|
| 1 | Ask about the calendar | Pass. Fixed: iCloud-synced calendars showed the same event twice, now de-duplicated; card times were `2026-11-04T15:00`, now plain language |
| 2 | Add an event | Pass (the user typed "2 hours" instead of tapping the card; the card was treated as declined and the AI produced a correct new one) |
| 3 | Undo | Pass |
| 4 | Set a reminder | Pass. Fixed: iPhone's zh-TW weekday names used the simplified form, now fixed to the traditional form |
| 5 | Card "Edit" | Pass (after editing the title, the AI's answer used the new title) |
| 6 | Card "Decline" (with and without a reason) | Pass |
| 7 | AI asks a multiple-choice question; user taps "Other…" and types | Pass |
| 8 | Photo of a notice; uncheck one item on the checklist card | Pass. Fixed: 31B said the unchecked item was added (results came back in a different order from the calls and didn't say which was which); results now come back in call order with each item named, and the screen line names it too |
| 9 | Turn off calendar access in Settings; undo from "Actions taken" | Pass. Fixed: after earlier use, the model kept calling the calendar tool and the app dropped the call, leaving an empty answer; now the model is told "turned off in Settings", the screen shows a line, and the AI says where to turn it on |
| 10 | Kill the app, reopen; the card is still there and works | Pass |

**Second round (2026-10-30)**: "Edit" now uses time pickers, and typing instead of tapping the card is worded "Skipped". Three new checks (11–13) were added and the first 10 were rerun, with Claude driving the app on the phone through the dev server's debugging connection while the user watched. All 13 passed; 3 problems were found and fixed:

| # | Check | Result |
|---|---|---|
| 11 | After correcting by typing, decline the new card | Pass. Fixed: 31B followed "make it four o'clock" and said "done"; now the last reminder says "this was not done" |
| 12 | "Edit" with the time picker: change the start, remove and re-add the end | Pass. Fixed: a combined date-time picker measured too wide on iPhone and overflowed; date and time are now separate pickers on one row |
| 13 | "Edit" an all-day event (date only) | Pass. Fixed: changed to 11/27 and added, but 31B still said 11/20; now the last reminder states what was actually done |

## 15. Phases

| Phase | Content |
|---|---|
| K1 | Helper: forward and translate tools; mark "supports tools" in the model list |
| K2 | App: tool framework, agent loop, four permission steps, confirmation card, action log and undo, database v5 (tested with fake tools first) |
| K3 | First tools: calendar and reminders, plus iOS permissions |
| K4 | Multiple-choice questions and checklist cards |
| K5 | Eval, prompt tuning, choosing the default model |
| K6 | iPhone acceptance |
| Later | Contacts and calls (always need a tap), drafting a message or email and opening the share sheet, map navigation, running Shortcuts, MCP tools on the computer (such as web search, routed through the helper), background runs and notifications |

## 16. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Tool descriptions for the model in English or Chinese | English (most tool-calling training data is English); the screen is always in the user's language |
| 2 | "Don't ask again" in the first version | No; confirming every time is simpler and safer |
| 3 | Give tools to small models (e2b, e4b) | **Decided (2026-10-29)**: every model that supports tools gets them, with no extra warning, so users can feel the difference between models |
| 4 | "Remind me" via iOS Reminders or the app's own notifications | iOS Reminders: visible to the user, synced with iCloud, and still there if the app is deleted |
| 5 | Maximum turns | 5 |

## 17. References

- Claude Code: [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md), [user input and questions](https://code.claude.com/docs/en/agent-sdk/user-input.md), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md), [to-do tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md), [MCP](https://code.claude.com/docs/en/mcp)
- Codex: [MCP setup and writes mode](https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli)
