# pi-win-notify

pi coding agent 桌面通知扩展。pi 完成输出时右下角弹出通知窗口，切到其他程序时不会错过。

*Desktop notification for pi coding agent. Pops up when pi finishes output — never miss a completed task.*

## 安装 / Install

```bash
pi install pi-win-notify
```

或从 GitHub / *or from GitHub*：

```bash
pi install git:https://github.com/ryanchan720/pi-desktop-notify.git
```

## 使用 / Usage

| 命令 / Command | 说明 / Description |
|---------|-------------|
| `/notify` | 开关切换 / Toggle on/off |
| `/notify on` / `off` | 强制开关 / Force state |
| `/notify timeout 15` | 自动消失秒数 (5~60, 默认 15) / Auto-dismiss seconds |
| `/notify opacity 1.0` | 窗口不透明度 (0.3~1.0) / Window opacity |
| `/notify message fixed` | 固定完成文本 / Fixed completion text |
| `/notify message response` | AI 回复前 50 字 (默认) / AI reply first 50 chars |
| `/notify lang en` | 语言：`zh` `en` `ja` `ko` / Language |
| `/notify status` | 守护进程状态 + 当前配置 / Daemon health + config |

## 特性 / Features

- 🪟 暗色圆角弹窗，右下角，跟光标走 / *Dark rounded popup, bottom-right, cursor-aware*
- 🔝 置顶、不抢焦点、可配不透明度、自动消失 / *Top-most, no focus steal, configurable opacity, auto-dismiss*
- ⏱ 显示耗时 / *Elapsed time display*
- 🔕 勿扰按钮：3 分钟 / 30 分钟 / 1 小时 / 关闭 / *Mute: 3min / 30min / 1h / off*
  - 持久化到磁盘，重启不丢 / *Persists to disk, survives restarts*
  - 多实例自动同步 / *Multi-instance auto-sync*
- ⌨ **Alt+[** 关闭, **Alt+]** 切回终端 / *Alt+[ dismiss, Alt+] switch back*
- 🤖 自动抑制重试和压缩期间的弹窗 / *Auto-suppress during retries & compaction*
- 🏠 终端在前台时自动跳过 / *Skip when terminal is focused*
- 📝 通知标题取用户 prompt 前 25 字 / *Title = first 25 chars of prompt*
- 📚 多 pi 窗口堆叠 / *Multi-pi window stacking*
- ⚡ 常驻守护进程：首次 ~3s，后续 <0.5s / *Persistent daemon: first ~3s, subsequent <0.5s*
- 🌍 跨平台：Windows / macOS / Linux

## 测试 / Test

```bash
node --experimental-strip-types tests/tests.ts
```

42 个单元测试 / *42 unit tests.*
