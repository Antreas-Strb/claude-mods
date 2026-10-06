# Security

## Supported versions

Only the latest GlanceFlow release gets fixes. Update with:

```
claude plugin marketplace update claude-mods
claude plugin update glanceflow@claude-mods
```

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub: open the [Security tab](https://github.com/Antreas-Strb/glanceflow/security) and press **Report a vulnerability**.

Say what you found, how to reproduce it, and which version you use. You'll get an answer within 7 days.

## What GlanceFlow touches

- It runs inside Claude Code as a mod and makes no network requests of its own. It asks Claude, through Claude Code, for short texts such as a job's title, a handoff note or a checkpoint.
- For sounds and desktop notices, when you turn them on, it runs your computer's own sound and notification programs.
- Its history stays on your computer, in Claude Code's plugin store, for 30 days.
- It reads tool calls to show progress, and your messages to hold back one that looks like it contains a password or key. It masks emails, phone numbers, keys and card numbers on screen.
