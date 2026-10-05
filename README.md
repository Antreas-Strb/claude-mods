# Claude Code mods

## Clean View

Clean View makes Claude Code calm and friendly for people who aren't technical. While Claude works, tool calls, file diffs and command output are hidden, and one checklist sits above the prompt: the plan, what is happening now and how far along it is.

```
Build my landing page · 60% · about 4m left               [ ● Clean View: Simple ]
✓ Read your brand notes       ██████████ Done
▶ Build the pricing section   ██████░░░░ 60%
  ↳ ◐ Find the pricing data   Explore
○ Add the contact form        ░░░░░░░░░░ Next
○ Polish the footer           ░░░░░░░░░░ Up next
```

- **Plan first:** before Claude uses a tool, it lays out 2 to 8 plain-English steps. A quick question needs no plan.
- **Live progress:** each step's meter fills as Claude reports progress. The header shows the overall percentage and, after two steps, about how long is left.
- **Status at a glance:** Working, **Needs you** (a permission prompt or a question), Stuck (with the reason in one sentence), Stopped (you pressed Esc), Still working in the background, and All done. All done shrinks to one line after 5 seconds.
- **Helpers and background work:** subagents and background tasks show under the step that started them. Clean View doesn't say All done while they still run.
- **Password guard:** a message that looks like it holds a password, API key, token, card or bank number is not sent. It goes back into the prompt box; send it again within 2 minutes to send it anyway. This guard stays on even when Clean View is off.
- **Privacy on screen:** emails, phone numbers, keys and card numbers are masked in the conversation and in step names. Claude still reads the original text.
- **Plan limits:** a warning shows at 80% of a plan window (red at 95%), and a "Tidy it up" button appears when the chat gets long.

### One button, three views

The button above the prompt cycles **Simple → Details → Off**. Both the view and on/off are remembered after a restart.

**Details** (or `/simple details`) also shows:

- the current step's bar filling gradually from a time estimate, with its running time and time left, e.g. `62% 1m 52s · ~1m left`; finished steps show how long they took
- each helper's type, model and effort, e.g. `Explore · Haiku 4.5 · low effort`
- tokens per step and how much came from the prompt cache, e.g. `48k tokens · 93% cached`
- the job's total tokens
- plan usage all the time, e.g. `Plan usage: 5-hour 42% · weekly 18% · chat 34% full`

### Commands

| Command | What it does |
|---|---|
| `/simple` | Turns Clean View on or off |
| `/simple on`, `/simple off` | Turns it on or off |
| `/simple details` | Turns the details view on or off |
| `/simple details on`, `/simple details off` | Turns the details view on or off |

The button above the prompt cycles Simple, Details and Off.

### Requirements

- Claude Code 2.1.288 or later, in the terminal or the Desktop app's Code tab.
- Mods turned on for your account. Run `claude plugin test` in any folder: "served off" means they aren't on yet.

### Install

```bash
claude plugin marketplace add Antreas-Strb/claude-mods
```

```bash
claude plugin install clean-view@claude-mods
```

Then open a new chat.

**Update:** `claude plugin marketplace update claude-mods`, then `claude plugin update clean-view@claude-mods`, then open a new chat.

**Remove:** `claude plugin uninstall clean-view@claude-mods`.

### Limits

- The Desktop app draws its own one-line tool summary ("Used 3 tools"); a mod can't hide it.
- Pattern matching can't catch every secret written in plain words.
- Background tasks are checked at the end of each of Claude's replies.
- Each new job gets a short name from Haiku in the background: one small model request per job.

### Credits

The secret and personal-detail patterns in `clean-view/hooks/privacy.ts` are adapted from [Nate Herk's Recording Mode](https://github.com/nateherkai/claude-code-mods) (MIT licence). The overall progress and time-left idea comes from his Goal Meter.

## License

MIT. See [LICENSE](LICENSE). Third-party code is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
