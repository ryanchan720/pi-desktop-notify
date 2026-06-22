# pi-desktop-notify

Desktop notification for [pi coding agent](https://pi.dev). Pops up a WPF notification when pi finishes output — so you don't miss it after switching to another app.

## Install

```bash
pi install git:github.com/<user>/pi-desktop-notify
```

Or copy `extensions/desktop-notify.ts` to `~/.pi/agent/extensions/`.

## Usage

| Command | Description |
|---------|-------------|
| `/notify` | Toggle on/off |
| `/notify on` / `off` | Force state |
| `/notify timeout 15` | Auto-dismiss seconds (5~60) |
| `/notify opacity 0.8` | Window opacity (0.3~1.0) |
| `/notify message fixed` | Fixed completion text |
| `/notify message summary` | AI reply first 20 chars |
| `/notify lang en` | Language: `zh` `en` `ja` `ko` |
| `/notify config` | Show current settings |

## Features

- WPF dark-themed popup, bottom-right corner
- Top-most, doesn't steal focus, 80% opacity, auto-dismiss
- **Alt+[** = Dismiss, **Alt+]** = Switch back to terminal
- Auto-suppressed during LLM retries & context compaction
- Skipped when terminal window is already focused
- Title = first 10 characters of your prompt
- Multi-pi stacking (offsets upward)
- Config persisted to `~/.pi/agent/notify.json`
- Cross-platform: Windows (WPF), macOS (Notification Center), Linux (notify-send)

## Files

```
pi-desktop-notify/
├── package.json
├── extensions/
│   └── desktop-notify.ts    # Main extension
├── tests/
│   └── tests.ts             # Unit tests (node --experimental-strip-types)
└── README.md
```

## Test

```bash
node --experimental-strip-types tests/tests.ts
```

27 unit tests covering content extraction, state machine, retry/compaction/abort handling.
