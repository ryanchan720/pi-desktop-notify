# pi-desktop-notify

Desktop notification for [pi coding agent](https://pi.dev). Pops up a WPF notification when pi finishes output — so you don't miss it after switching to another app.

## Install

```bash
pi install pi-desktop-notify
```

Or install from GitHub:

```bash
pi install git:https://github.com/ryanchan720/pi-desktop-notify.git
```

## Architecture

- **`desktop-notify.ts`** — pi extension entry point (commands, events, foreground detection via koffi)
- **`host.ps1`** — Persistent PowerShell daemon: loads WPF + compiles C# once, then waits for JSON on stdin to show notifications
- Uses **koffi** for zero-overhead Win32 API calls (no temp files, no wscript)

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
| `/notify config` | Show current settings |

## Features

- WPF dark-themed popup, bottom-right corner
- Top-most, doesn't steal focus, configurable opacity, auto-dismiss
- ⏱ Elapsed time display in notification
- **Alt+[** = Dismiss, **Alt+]** = Switch back & focus terminal
- Auto-suppressed during LLM retries & context compaction
- Skipped when terminal window is already focused
- Title = first 25 characters of your prompt
- Multi-pi stacking (offsets upward)
- Config persisted to `~/.pi/agent/notify.json`
- Cross-platform: Windows (WPF), macOS (Notification Center), Linux (notify-send)
- Persistent PS host: first notification ~3s, subsequent <0.5s

## Test

```bash
node --experimental-strip-types tests/tests.ts
```
