# Claude Code mods

## Glance

**See what Claude is doing, at a glance.**

![Glance: a calm checklist above the prompt, filling in as Claude works](docs/glance-demo.gif)

<sub>A scripted job: the checklist frames are drawn by Glance itself; the window around them is illustrative.</sub>

Glance makes Claude Code calm and friendly for people who aren't technical. While Claude works, tool calls, file diffs and command output are hidden, and one checklist sits above the prompt: the plan, what is happening now and how far along it is.

```
Build my landing page · 60% · about 4m left               [ ● Glance: Simple ]
✓ Read your brand notes       ██████████ Done
▶ Build the pricing section   ██████░░░░ 60%
  ↳ ◐ Find the pricing data   Explore
○ Add the contact form        ░░░░░░░░░░ Next
○ Polish the footer           ░░░░░░░░░░ Up next
```

- **Plan first:** before Claude uses a tool, it lays out 2 to 8 plain-English steps. A quick question needs no plan.
- **Live progress:** each step's meter fills as Claude reports progress. The header shows the overall percentage and, after two steps, about how long is left.
- **Status at a glance:** Working, **Needs you** (a permission prompt or a question), Stuck (with the reason in one sentence), Stopped (you pressed Esc), Still working in the background, and All done. All done shrinks to one line after 5 seconds.
- **Helpers and background work:** subagents and background tasks show under the step that started them. Glance doesn't say All done while they still run.
- **Password guard:** a message that looks like it holds a password, API key, token, card or bank number is not sent. It goes back into the prompt box; send it again within 2 minutes to send it anyway. This guard stays on even when Glance is off.
- **Privacy on screen:** emails, phone numbers, keys and card numbers are masked in the conversation and in step names. Claude still reads the original text.
- **Plan limits:** a warning shows at 80% of a plan window (red at 95%), and a "Tidy it up" button appears when the chat gets long.

### One button, three views

The button above the prompt cycles **Simple → Details → Off**. Both the view and on/off are remembered after a restart.

**Details** (or `/glance details`) also shows:

- the current step's bar filling gradually from a time estimate, with its running time and time left, e.g. `62% 1m 52s · ~1m left`; finished steps show how long they took
- each helper's type, model and effort, e.g. `Explore · Haiku 4.5 · low effort`
- tokens per step: new ones first, then the cheaper ones read back from the prompt cache, e.g. `3k new · 45k cached`. Claude's final answer counts in the job's total only
- the job's total tokens
- plan usage all the time, e.g. `Plan usage: 5-hour 42% · weekly 18% · chat 34% full`

![Glance Details: bars fill with time and time left, a Haiku helper under its step, tokens per step and plan usage](docs/glance-details.gif)

<sub>The same kind of scripted job in Details, with time sped up.</sub>

### Pause and Continue

Under the checklist, **‖ Pause** stops Claude while it works, and **▶ Continue** picks the same job up again, with nothing to type. Continue also shows after Esc, when Claude got stuck, or when it is waiting with steps left. The header says **‖ Paused** after Pause and **■ Stopped** after Esc. `/glance pause` and `/glance continue` do the same.

### History for a retro

**☰ History** under the checklist (or `/glance history`) opens a side panel with today's jobs in this project: when each started, how it ended (✓ done, ■ stopped, ⚠ stuck), steps done, how long it took and its tokens, with the day's totals at the bottom.

![The History panel: the day's jobs with start time, outcome, steps, time and tokens, the day picker and the totals](docs/glance-history.png)

In the panel, **◀ Earlier**, the day drop-down, **Later ▶** and **Today** move between days (or type `/glance history yesterday`, `/glance history 2026-10-06`). The history stays on this computer and keeps 30 days.

**Team report** turns the day into a short update in plain words for the team, a manager or a CEO, and copies it to paste into Slack, Teams or an email: what got done, what is still in progress and what is next, what needs a decision, and the time spent. No tokens, models or file names, and quick questions are left out.

![The Team report: what got done, what is still in progress, what needs a decision, and the time spent](docs/glance-team-report.png)

<sub>The History panel and the Team report above are drawn by Glance from a sample day.</sub>

### Fresh chat (handoff)

**↻ Fresh chat** under the checklist (or `/glance handoff`) moves the work to a fresh chat: when a chat is too long, close to its limits, or whenever you want a clean start. Press it twice (the first press asks to confirm). Claude writes a short handoff note (goal, what is done, what is left, decisions, the next step), the chat is cleared, and the note is sent as the fresh chat's first message. The note is also saved: `/glance handoff note` puts the last one back in the prompt box.

### Commands

| Command | What it does |
|---|---|
| `/glance` | Turns Glance on or off |
| `/glance on`, `/glance off` | Turns it on or off |
| `/glance details` | Turns the details view on or off |
| `/glance details on`, `/glance details off` | Turns the details view on or off |
| `/glance history` | Shows today's jobs in this project |
| `/glance history yesterday`, `/glance history 2026-10-06` | Shows another day |
| `/glance pause`, `/glance continue` | Pauses Claude, or picks the job up again |
| `/glance handoff` | Starts a fresh chat from a handoff note |
| `/glance handoff note` | Puts the last handoff note in the prompt box |

The button above the prompt cycles Simple, Details and Off.

### Requirements

- Claude Code 2.1.288 or later, in the terminal or the Desktop app's Code tab.
- Mods turned on for your account. Run `claude plugin test` in any folder: "served off" means they aren't on yet.

### Install

```bash
claude plugin marketplace add Antreas-Strb/claude-mods
```

```bash
claude plugin install glance@claude-mods
```

Then open a new chat.

**Update:** `claude plugin marketplace update claude-mods`, then `claude plugin update glance@claude-mods`, then open a new chat.

**Coming from Clean View?** Glance is its new name. Uninstall the old one first (`claude plugin uninstall clean-view@claude-mods`), then install `glance@claude-mods`. `/simple` still works as another name for `/glance`.

**Remove:** `claude plugin uninstall glance@claude-mods`.

### Limits

- The Desktop app draws its own one-line tool summary ("Used 3 tools"); a mod can't hide it.
- Pattern matching can't catch every secret written in plain words.
- Background tasks are checked at the end of each of Claude's replies.
- Each new job gets a short name from Haiku in the background: one small model request per job.

### Credits

The secret and personal-detail patterns in `glance/hooks/privacy.ts` are adapted from [Nate Herk's Recording Mode](https://github.com/nateherkai/claude-code-mods) (MIT licence). The overall progress and time-left idea comes from his Goal Meter.

## License

MIT. See [LICENSE](LICENSE). Third-party code is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
