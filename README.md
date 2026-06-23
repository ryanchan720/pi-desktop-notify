# pi-win-notify

Desktop notification for [pi coding agent](https://pi.dev). Pops up a rich popup when pi finishes output — never miss a completed task.

> 中文说明见 [README.zh.md](./README.zh.md)

## Install

```bash
pi install pi-win-notify
```

Or from GitHub:

```bash
pi install git:https://github.com/ryanchan720/pi-desktop-notify.git
```

## Usage

| Command | Description |
|---------|-------------|
| `/notify` | Toggle on/off |
| `/notify on` / `off` | Force state |
| `/notify timeout 15` | Auto-dismiss seconds (5~60, default 15) |
| `/notify opacity 1.0` | Window opacity (0.3~1.0) |
| `/notify message fixed` | Fixed completion text |
| `/notify message response` | AI reply first 50 chars (default) |
| `/notify lang en` | Language: `zh` `en` `ja` `ko` |
| `/notify status` | Daemon health + current config |

## Features

- 🪟 Dark rounded popup, bottom-right, follows cursor across monitors
- 🔝 Top-most, doesn't steal focus, configurable opacity, auto-dismiss
- ⏱ Elapsed time display
- 🔕 Mute button: 3 min / 30 min / 1 hour / off
  - Persists to disk, survives restarts
  - Multi-instance auto-sync via file check on each `agent_end`
- ⌨ **Alt+[** dismiss, **Alt+]** switch back to terminal
- 🤖 Auto-suppress during LLM retries & context compaction
- 🏠 Skip when terminal is already focused
- 📝 Title = first 25 chars of user prompt
- 📚 Multi-pi window stacking
- ⚡ Persistent daemon: first popup ~3s, subsequent <0.5s
- 🌍 Cross-platform: Windows / macOS / Linux

## Test

```bash
node --experimental-strip-types tests/tests.ts
```

42 unit tests covering content extraction, retry detection, and state machine.
