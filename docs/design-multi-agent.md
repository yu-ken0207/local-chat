# Multi-agent discussion (design)

**English** | [繁體中文](設計_多AI討論.md)

Status: first version done (2026-10-30). M1–M6, M7a (avatar pipeline, changing avatars), and M8a (tests against real models) are committed, with 537 tests at the time. M7b, 788 pixel-art avatars (style C), is also done. Not done yet: M8b iPhone acceptance. Decisions are in section 2; open questions in section 13.

## 1. Goal

Chat with several AIs at once. The AIs discuss among themselves instead of turning to you after every message; you are just one of the members.

The user's seven requirements:

1. Available in normal chats, not only in threads; keep each AI's memory (context) within what fits.
2. Manage agents in Settings; describe an agent in a sentence and the AI fills in the rest.
3. Who joins: you can pick, or let AIs join on their own.
4. Avatars: pixel-art avatars generated on a test workstation.
5. End with a vote and a conclusion.
6. Each AI decides when to speak and whom to reply to; configurable in Settings, and can be fully automatic.
7. Not just circling the user's question: the AIs should discuss with each other.

## 2. Decisions (2026-10-30)

| Item | Decision |
|---|---|
| Where | In normal chats. Each conversation gets a member list, by default 1 AI (same as before); adding members turns it into a group discussion. Threads keep the parent's members and can add more |
| Turn-taking | Default is **free-for-all** (AIs bid to speak). Settings also offer moderator, round-robin, and only-when-@mentioned |
| Model | Defaults to the conversation's current model; individual agents can use a different computer or model |
| Bidding | After every message, each AI returns one line: how much it wants to speak (0–10) and whom it would reply to; the highest bid speaks |
| When to stop | Stop when nobody wants to speak; after each message from you, AIs speak at most 12 times in a row (configurable) |
| Who joins | Both, chosen in group settings: by default you pick (with a "Pick for me" button); with "Let AIs join", agents in My Agents marked "may join on their own" also bid |
| When you speak | Someone always replies; who replies is decided by bidding |
| Creating agents | One sentence generates a full role card; every field can be edited; "Generate another" if not satisfied |
| Avatars | Pixel-art avatars generated on a test workstation, **one per role** (788 built in); custom agents pick from these or use a photo |
| Closing | When the AIs think it's time, they propose "Wrap up?" and you decide; in fully automatic mode they wrap up themselves. Closing = list options, everyone votes with a reason, conclusion card |
| Layout | **Only group chats** switch to chat bubbles (like messaging apps); one-on-one chats keep the terminal style |
| Reply length | Short, chat-like (1–4 sentences); long-press a message to ask that agent to expand |
| Built-in agents | **All 788 roles from two MIT-licensed projects, original text kept** (section 8) |
| Roster | "Catalog" (788, categories and search) plus "My Agents" (added from the catalog or created) |
| Memory across chats | Yes. Each agent has its own notes, written after closing and carried into the next discussion |
| Scope | Build everything at once (M1–M8 in section 12), committing after each tested step |
| Review flags | The catalog was imported as-is; 2 jailbreak roles and 2 profanity roles were flagged for review (section 8) |

## 3. Terms

- **Agent**: an AI with a name, an avatar, and a role description.
- **Catalog**: the 788 built-in agents, read-only.
- **My Agents**: agents copied from the catalog (editable) or created by the user.
- **Members**: the agents in a given conversation.
- **Bid**: after each message, a small call asking every AI whether it wants to speak, without writing the content.
- **Organizer**: a system role that writes summaries, lists options, and writes the conclusion card. It is not a member and takes no seat.

## 4. Turn-taking flow

```
Someone finishes a message (you or an AI)
  Stop? (paused / 12 in a row already / nobody wants to speak) ── yes: stop and wait for you
  no: all members bid at once (with only names + one-line intros + the last few messages)
    Weighting: eagerness, being @mentioned (always speaks), spoke just now (penalty, to avoid one agent talking repeatedly)
    Top bid >= threshold: that agent speaks (with its full role text), replying to whom it chose
    You just spoke: even if everyone is below the threshold, the top bidder replies
```

- Bids use Ollama's `format` (JSON output) and return `{score, reply_to, ready_to_conclude}`.
- If the host runs requests in parallel (the test workstation allows 4), bids are sent at the same time; otherwise they queue, which still works, just slower.
- Moderator: the organizer reads the last few messages and picks the next speaker and whom they reply to (one call per round).
- Round-robin: in member order.
- Only when @mentioned: nobody speaks unless mentioned. If you don't mention anyone, the most recent speaker replies.
- Let AIs join: agents in My Agents marked "may join on their own" also bid, with a higher threshold than members (for example 7). The winner joins, and the screen says "X joined the discussion".
- Fully automatic: doesn't wait for you; talks until nobody wants to speak or the limit is reached, then wraps up.
- Background runs reuse the existing run system: switching chats or closing a thread doesn't stop it; the pause button can stop it any time.

## 5. What each AI sees (memory)

When an agent speaks, the model receives:

1. **System message**: group rules (who you are, the members and their one-line intros, reply in 1–4 sentences, address people by name, you may @mention, reply language), plus **this agent's role text**, plus **its notes** (the most recent ones, capped).
2. **Summary of earlier discussion**: when the conversation is long, the organizer condenses the earlier part into one shared summary.
3. **Recent messages**: the agent's own messages as assistant, everyone else's as user, prefixed with "[Name]".

**Context budget**: `contextFor()` looks up the host's actual context limit, leaves room for the answer, and fills from the newest message backwards; whatever doesn't fit goes into the summary.

**When the role text doesn't fit**: roles from agency-agents average about 3,700 tokens, which doesn't fit when the host's context is only 4K. The role text is then shortened automatically (keeping the identity and key sections at the start), and the message notes "role description was too long and was shortened".

**Notes**: after closing, each agent writes a few lines about its position and what it learned (a simplified version of the memory in Generative Agents). Notes belong to the agent and come along to any later discussion. They can be viewed, edited, and cleared in Settings.

## 6. Closing (vote and conclusion)

1. **Proposal**: when most bids return `ready_to_conclude`, the screen asks "Wrap up?". You can also tap "Wrap up" any time. Fully automatic mode wraps up directly.
2. **Options**: the organizer lists 2–4 options from the discussion (if there are none, it becomes agree/disagree on a conclusion).
3. **Vote**: every agent votes at the same time, with one sentence of reasoning. You can vote too.
4. **Conclusion card**: consensus, disagreements, and to-dos, with the vote count. It can be pinned to the top of the chat.
5. **Notes**: each agent writes its own notes (section 5).

## 7. Role card

For custom agents, the AI generates these fields from one sentence:

| Field | Description |
|---|---|
| Name | Display name |
| One-line intro | Used for bidding, the member list, and the catalog |
| Expertise | |
| Position and personality | |
| Speaking style | |
| Blind spots | Creates tension in the discussion and tells others what to cover |
| Eagerness | 0–1, affects the bid score |
| Avatar | The closest of the 788 pixel avatars; can be changed or replaced with a photo |
| Model | Defaults to the conversation's; can be set to another computer or model |
| May join on their own | If on, bids in conversations with "Let AIs join" |

Catalog agents keep their original text as the role, plus name, one-line intro, category, emoji, author, and source. Adding one to My Agents makes an editable copy.

## 8. Built-in agent sources (both MIT)

| Source | Count | Content | Language |
|---|---|---|---|
| [lobehub/lobe-chat-agents](https://github.com/lobehub/lobe-chat-agents) | 505 | LobeChat's agent market: programming 108, copywriting 67, education 66, design 38, academic 38, general 33, lifestyle 30, career 25, translation 25, emotions 24, marketing 16, entertainment 13, games 13, office 9 | 18 languages, including Traditional Chinese and English |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (about 165k stars) | 283 | Each has a personality, process, and deliverables: engineering 66, specialized 59, marketing 37, game development 21, GIS 13, security 12, design 10, sales 9, testing 9, and more | English; names and intros translated to Traditional Chinese |

- **License**: MIT requires keeping the copyright notice. The app has a "Third-party licenses" page with both LICENSE texts, and every catalog agent shows its author and source.
- **Flags**: 2 jailbreak roles (`dan`, `gpt-4-dan-assistant`) and 2 profanity roles (`profanity-assistant`, `bad-language-helper`) were flagged for review.
- **Conversion**: `scripts/build-catalog.mts` converts both repos into app data. The index (name, intro, category, emoji) and the full text are stored separately; the full text is only read when the catalog entry is opened or the agent joins a discussion, so it isn't bundled into the JS.
- **Categories**: the two sources' categories are merged into about 12 for catalog filters.

## 9. Avatars

- Three pixel-art style samples were generated with ComfyUI (Z-Image Turbo) on the test workstation, and the user picked one.
- One avatar per role from its name and intro: 788 images.
- Each is downscaled to a 48×48 pixel grid, reduced to 32 colors, then scaled up 2× to 96×96 (a 32 pt avatar stays sharp on a 3× screen), about 3 KB each.
- One small file per role (`assets/agents/avatars/N.png`, mapped in `src/agents/avatars.ts`), loaded only when shown. A single sprite sheet was considered, but 788 images in one sheet decode to tens of MB on the phone and always load in full, so that was dropped (2026-10-30).
- Appearance prompts: `scripts/build_avatars.py describe` asks gemma4:31b on the test workstation to write one English description per role from its name and intro (gender and age, job features, fantasy characters drawn as such), saved in `scripts/catalog/avatar-subjects.json`.
- Custom agents: one-sentence generation automatically uses the avatar of the catalog role closest in name or expertise; the edit page can "Change avatar" to any of the 788 or back to an emoji. Photos from the library are not done yet.
- The user's own messages are on the right, without an avatar.

## 10. Screens

- **Group chats**: chat bubbles. You on the right; AIs on the left with avatar and name. A reply shows a small "Replying to X: …" line; tapping it jumps to that message. "X joined the discussion" is a small centered line.
- **In progress**: "Everyone is thinking…" while bidding, "X is typing…" while someone speaks.
- **Title bar**: stacked member avatars; tapping opens the member panel to add or remove members, "Pick for me", and group settings: turn-taking mode, let AIs join, consecutive limit, fully automatic.
- **Input**: typing @ shows the member list; there are pause/resume and "Wrap up" buttons.
- **Conclusion card**: pinned to the top; tap to read it in full.
- **Settings › Agents**:
  - Two tabs: "My Agents" and "Catalog" (categories and search).
  - Create: write one sentence and the AI generates the role card.
  - Edit the role card, view or clear notes, choose an avatar.
- **Long-press an AI message**: "Ask them to expand", and that agent answers that message without the length limit.

## 11. Database (v7)

- `agents`: My Agents. Columns: id, source (lobe / agency / custom), source id, name, intro, role text or role card fields, eagerness, avatar (sprite index or photo), host and model (optional), may join on their own, created time.
- `session_members`: which agents are in which conversation and how they joined (added by you, joined on their own, pulled in by @mention).
- `sessions` adds group settings: turn-taking mode, let AIs join, consecutive limit, fully automatic, earlier-discussion summary, pinned conclusion card.
- `messages` adds `agent_id` (which agent said it) and `reply_to` (which message it answers); conclusion cards, votes, and "joined" lines are told apart by `detail`.
- `agent_notes`: agents' notes, with the conversation they came from.
- Backup and restore include these tables.

## 12. Build order (all at once, commit after each tested step)

| Step | Content |
|---|---|
| M1 | Data layer: v7 tables, catalog conversion script and data, reading the catalog |
| M2 | Settings › Agents: mine / catalog / search / one-sentence create / edit / notes / third-party licenses |
| M3 | Discussion engine: members, bidding, speaking, context assembly and summaries, stop conditions, someone always answers you, @mentions, four turn-taking modes, AIs joining on their own, background runs |
| M4 | Screens: bubbles, avatars, reply quotes, typing indicator, member panel, @ picker, pause/resume |
| M5 | Closing: proposal, options, vote, conclusion card, notes, fully automatic |
| M6 | Group threads, per-agent models, "ask them to expand" |
| M7 | 788 pixel avatars and the avatar mapping (when the test workstation is free) |
| M8 | Unit and component tests, tests against real hosts (JSON bid stability on 31B and 12B), iPhone acceptance |

## 13. Open questions

- ~~Pixel style~~: the user chose C (fine shading, Stardew-like); all 788 were generated in 13 minutes with zero failures, 1.6 KB each on average, 1.3 MB in total.
- Bid threshold (tentatively 5, outsiders 7), consecutive limit 12, fully automatic limit: built with the tentative values, to be tuned from real use.
- Shortening role text that doesn't fit (section 5): built as described.

## 14. Tests against real models (2026-10-30, test workstation)

`test/live/group.live.test.ts`: a financial analyst, an SRE, and a product manager discuss "should we replace a 7-year-old server, budget NT$300,000", then wrap up.

| Model | Discussion | Closing | Quality |
|---|---|---|---|
| gemma4:31b | 67 s, 6 messages | 44 s | They @mention and question each other, 2–4 sentences each; the conclusion card and notes are sensible |
| gemma4:12b | 37 s, 6 messages | 12 s | Replies run long (several paragraphs, bold text); the conclusion is sensible |

Fixed during testing: when one message @mentioned several people, only the first was used, so two agents who kept @mentioning each other talked forever and the third never spoke. Now the agent who has been quiet longest goes first.

## 15. References

- [AutoGen GroupChat](https://microsoft.github.io/autogen/): choosing the next speaker (auto / round_robin / manual / random).
- AgentVerse (Chen et al., 2023): recruiting experts for a task, discussing, then deciding.
- [crewAI](https://github.com/crewAIInc/crewAI): role = role name, goal, backstory.
- SillyTavern group chats: each character has talkativeness and an auto mode.
- Generative Agents (Park et al., 2023): memory stream and reflection. The notes here are a simplified version.
- Improving Factuality and Reasoning in Language Models through Multiagent Debate (Du et al., 2023): several models debate and converge.
- Six Thinking Hats (de Bono): roles such as devil's advocate, optimist, facts, feelings, creativity, and process.

## 16. Inviting agents mid-chat, and thread members (decided by the user, 2026-10-31)

When you want a discussion halfway through a normal chat, you don't need to pick members first:

- **Threads have their own members**, separate from the parent chat: in a thread opened from a normal chat, tap the title and choose "Members and discussion settings" to invite agents; the parent stays a normal chat. Threads opened from a group discussion still use the parent's members.
- **@mention one of My Agents in a normal chat**: they are pulled in, the chat becomes a group discussion, and they answer that message. In normal chats the @ list only shows My Agents (788 catalog agents is too many; use "find agents" below for the catalog).
- **Say "find agents who know about X to discuss this"**: the AI calls the `invite_agents` tool (built into the app, no MCP needed: the catalog and the selection run on the phone). The app finds 2–4 agents for the topic and shows a **checklist card**:
  - Suitable agents from My Agents come first; the catalog fills the rest (same as "Pick for me")
  - All checked by default, each with one sentence on why they were picked; "Show others" brings a new set (already-seen agents aren't picked again)
  - "Add and start": checked agents join, **the original AI steps out**, and the agents answer your message
  - "No thanks": the AI answers as in a normal chat (without claiming it did something)
  - No suitable agents: no card; the AI answers itself
- "Find agents" is always on (it touches no personal data, so there is no switch in Settings). If the model can't call tools, the system prompt asks it to tell the user: tap the title, "Members and discussion settings", "Pick for me".
- Not used inside a group discussion: adding members there still uses @ or "Pick for me".

Test against a real model (gemma4:31b on the test workstation): "find a few agents who know about this to discuss it" calls the tool; finding agents takes about 10 seconds, the user's own "CFO" agent ranks first and the catalog adds a "Backend architect", each with a reason; after joining, one round of discussion takes about 15 seconds.

## 17. Agent profile card (decided by the user, 2026-10-31)

Like a contact card in Teams: tap an agent's avatar next to a bubble, and the card grows out of that avatar over the chat (the background dims). Tap outside, swipe down, or do the two-finger Z gesture to shrink it back.

- Content: avatar, name, one-line intro, "spoke n times here, eagerness: chatty"; custom agents show expertise, position, and style; catalog agents show category and personality; the latest 3 notes (hidden if none)
- Buttons: @mention (fills the input), Edit (catalog agents are first copied to My Agents, then opened for editing), Remove (leave this discussion; their messages stay; can be undone; not shown for agents who already left)
- Buttons act only after the card has shrunk back (two layers never animate at once)
