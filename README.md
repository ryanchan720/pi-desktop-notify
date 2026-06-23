# pi-win-notify

WPF desktop notification for [pi coding agent](https://pi.dev). Pops up a rich popup when pi finishes output — so you don't miss it after switching to another app.

## Install

```bash
pi install pi-win-notify
```

Or from GitHub:

```bash
pi install git:https://github.com/ryanchan720/pi-desktop-notify.git
```

## Architecture

- **`desktop-notify.ts`** — pi extension (commands, events, foreground detection via koffi)
- **`host.ps1`** — Persistent PowerShell daemon: loads WPF + compiles C# once, waits for JSON on stdin

## Usage

| Command | Description |
|---------|-------------|
| `/notify` | Toggle on/off |
| `/notify on` / `off` | Force state |
| `/notify timeout 15` | Auto-dismiss seconds (5~60, default 15) |
| `/notify opacity 1.0` | Window opacity (0.3~1.0, default 1.0) |
| `/notify message fixed` | Fixed completion text |
| `/notify message response` | AI reply first 50 chars (default) |
| `/notify lang en` | Language: `zh` `en` `ja` `ko` (default `en`) |
| `/notify status` | Show daemon health + current config |

## Features

- WPF dark-themed popup, bottom-right corner
- Follows cursor to active monitor
- Top-most, doesn't steal focus, configurable opacity, auto-dismiss
- ⏱ Elapsed time display
- 🔕 Mute button on notification: 3 min / 30 min / 1 hour / off
  - Write-through to `notify.json`, survives restarts
  - Multi-instance aware: every `agent_end` checks if mute has expired
- **Alt+[** = Dismiss, **Alt+]** = Switch back & focus terminal
- Auto-suppressed during LLM retries & context compaction
- Skipped when terminal window is already focused
- Title = first 25 characters of your prompt
- Multi-pi stacking (offsets upward)
- Persistent PS host: first notification ~3s, subsequent <0.5s
- Cross-platform: Windows (WPF), macOS (Notification Center), Linux (notify-send)

## Test

```bash
node --experimental-strip-types tests/tests.ts
```

42 unit tests covering content extraction, retry detection, and state machine.
