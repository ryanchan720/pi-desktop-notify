/**
 * Pi Desktop Notification — 桌面通知扩展
 *
 * pi 完成输出时右下角弹出 WPF 暗色通知窗口。切到其他程序时不会错过。
 *
 * ## 使用
 *
 *   /notify          切换通知开关 (on/off)
 *   /notify on|off   直接设置
 *   弹窗按钮:         知道了  /  继续（切回终端并聚焦）
 *   全局快捷键:       Alt+[ = 知道了    Alt+] = 继续
 *
 * ## 行为
 *
 *   - 右下角置顶、不抢焦点、80% 半透明、15 秒自动消失
 *   - 通知标题 = 当前轮用户消息前 10 字
 *   - LLM 超时重试时自动抑制（2 秒冷却期，只在主动权交还用户时弹）
 *   - wscript 启动，零控制台交互，终端不最小化/不闪现
 *   - 多 pi 窗口安全（各自独立的句柄缓存）
 *   - Footer 状态指示: 🔔 开启 / 🔕 关闭
 * ## 文件
 *
 *   本文件放在 ~/.pi/agent/extensions/ 下自动生效。
 *   调试日志: %TEMP%/pi-notify-debug.log
 *
 * ## 跨平台
 *
 *   Windows:  WPF 暗色窗口 (本扩展主要针对)
 *   macOS:    osascript Notification Center
 *   Linux:    notify-send
 */

import { spawn } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── 状态 ─────────────────────────────────────────────────────────────────────
let enabled = true;
let uniqueWindowId = "";
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let taskStartTime = 0;

// ── 可配置项 ────────────────────────────────────────────────────────────────
const CONFIG_PATH = join(getAgentDir(), "notify.json");
type Config = { timeout: number; opacity: number; messageMode: "fixed" | "response"; lang: "zh" | "en" | "ja" | "ko" };

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { timeout: saved.timeout ?? 15, opacity: saved.opacity ?? 1.0, messageMode: saved.messageMode ?? "response", lang: saved.lang ?? "en" };
    }
  } catch { /* */ }
  return { timeout: 15, opacity: 1.0, messageMode: "response", lang: "en" };
}

function saveConfig(c: Config): void {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf-8"); } catch { /* */ }
}

const config = loadConfig();

// ── i18n ────────────────────────────────────────────────────────────────────
const i18n: Record<string, Record<string, string>> = {
  zh: { dismissBtn: " 知 道 了 ", continueBtn: " 继 续 ", completion: "任务完成", switchBack: "可以切回来了", enabled: "通知已开启 🔔", disabled: "通知已关闭 🔕", configTitle: "通知配置", timeoutLabel: "超时", opacityLabel: "不透明度", modeLabel: "模式", langLabel: "语言", statusLabel: "状态", on: "开", off: "关", },
  en: { dismissBtn: " Dismiss ", continueBtn: "Continue", completion: "Task complete", switchBack: "Switch back", enabled: "Notify ON 🔔", disabled: "Notify OFF 🔕", configTitle: "Notify Config", timeoutLabel: "Timeout", opacityLabel: "Opacity", modeLabel: "Mode", langLabel: "Language", statusLabel: "Status", on: "ON", off: "OFF", },
  ja: { dismissBtn: " 閉じる ", continueBtn: " 続 行 ", completion: "完了", switchBack: "戻れます", enabled: "通知ON 🔔", disabled: "通知OFF 🔕", configTitle: "通知設定", timeoutLabel: "タイムアウト", opacityLabel: "不透明度", modeLabel: "モード", langLabel: "言語", statusLabel: "状態", on: "ON", off: "OFF", },
  ko: { dismissBtn: "  닫 기  ", continueBtn: " 계 속 ", completion: "완료", switchBack: "돌아가기", enabled: "알림 ON 🔔", disabled: "알림 OFF 🔕", configTitle: "알림 설정", timeoutLabel: "시간제한", opacityLabel: "불투명도", modeLabel: "모드", langLabel: "언어", statusLabel: "상태", on: "ON", off: "OFF", },
};
function t(key: string): string { return i18n[config.lang]?.[key] ?? i18n.zh[key] ?? key; }
function completionMsg(): string { return `${t("completion")}，${t("switchBack")} 🎉`; }

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function extractSummary(event: { messages?: unknown[] }): string | null {
  try {
    const msgs = event.messages as Array<{ role?: string; content?: unknown }>;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        const text = extractText(msgs[i].content);
        if (text) {
          const cleaned = text.replace(/\s+/g, " ").trim();
          return cleaned.length > 20 ? cleaned.slice(0, 20) + "…" : cleaned;
        }
      }
    }
  } catch { /* */ }
  return null;
}

// ── 窗口句柄缓存（扩展加载时获取）───────────────────────────────────────
let terminalHwnd = "";
let terminalTitle = "";

function cacheTerminalHwnd(): void {
  if (platform() !== "win32") return;

  // 抓当前前台窗口句柄和标题
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PFG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
}
"@
$h = [PFG]::GetForegroundWindow()
$l = [PFG]::GetWindowTextLength($h)
$s = New-Object System.Text.StringBuilder($l + 1)
[PFG]::GetWindowText($h, $s, $s.Capacity) | Out-Null
Write-Output "$($h.ToString())|$($s.ToString())"
`;

  const psPath = join(tmpdir(), `pi-hwnd-${process.pid}.ps1`);
  const vbsPath = join(tmpdir(), `pi-hwnd-${process.pid}.vbs`);
  const outPath = join(tmpdir(), `pi-hwnd-${process.pid}.txt`);

  try {
    writeFileSync(psPath, "\ufeff" + psScript, "utf-8");
    const escapedPsPath = psPath.replace(/\\/g, "\\\\");
    const escapedOutPath = outPath.replace(/\\/g, "\\\\");
    const vbsScript = `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ""& '${escapedPsPath}' | Out-File -Encoding ascii '${escapedOutPath}'""", 0, True`;
    writeFileSync(vbsPath, vbsScript, "utf-8");

    const { execSync } = require("node:child_process");
    execSync(`wscript.exe "${vbsPath}"`, { timeout: 5000 });

    const { readFileSync } = require("node:fs");
    const raw = readFileSync(outPath, "utf-8").trim();
    const parts = raw.split("|");
    terminalHwnd = parts[0] || "";
    terminalTitle = parts.slice(1).join("|") || "";
    log(`cached terminal: hwnd=${terminalHwnd} title="${terminalTitle}"`);
  } catch (e: unknown) {
    log(`FAIL cache hwnd: ${e}`);
  } finally {
    try { unlinkSync(psPath); } catch { /* ignore */ }
    try { unlinkSync(vbsPath); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
  }
}

// ── 窗口标识 ─────────────────────────────────────────────────────────────────
function generateWindowId(): string {
  return `pi@${process.pid.toString(36)}`;
}

function setWindowTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`);
}

// ── 调试日志 ─────────────────────────────────────────────────────────────────
const LOG = join(tmpdir(), "pi-notify-debug.log");
function log(msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG, `[${ts}] ${msg}\n`, "utf-8"); } catch { /* ignore */ }
}

// ── 桌面通知 ────────────────────────────────────────────────────────────────

function notifyWindows(title: string, body: string, hwnd: string, winTitle: string): void {
  log(`notifyWindows: title="${title}" hwnd=${hwnd} win="${winTitle}"`);

  if (!hwnd || hwnd === "0") {
    log("no valid hwnd, skipping");
    return;
  }

  const safeTitle = title.replace(/'/g, "''");
  const safeBody = body.replace(/'/g, "''");
  const safeWinTitle = winTitle.replace(/'/g, "''");
  const dismissLabel = t("dismissBtn").replace(/'/g, "''");
  const continueLabel = t("continueBtn").replace(/'/g, "''");
  const timeoutSec = config.timeout;
  const opacityVal = config.opacity.toFixed(2);
  const elapsedLabel = taskStartTime > 0 ? `⏱ ${formatElapsed(Date.now() - taskStartTime)}` : "";
  const safeElapsed = elapsedLabel.replace(/'/g, "''");

  const psScript = `\
$ErrorActionPreference = 'Stop'
$log = '${LOG.replace(/\\/g, "\\\\")}'
function l($m) { "$m" | Out-File -Append -Encoding utf8 $log }

l '[ps-start]'
try {
  Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
  l '[ps-assemblies-ok]'

  # ── 切回终端（缓存hwnd优先，失败则枚举窗口找标题）
  function Focus-PiTerminal {
    l '[focus-called]'
    $code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PF {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  public static string Search;
  public static IntPtr Found = IntPtr.Zero;
  public static string FoundTitle = "";
  public static bool Callback(IntPtr h, IntPtr l) {
    int len = GetWindowTextLength(h);
    if (len > 0) {
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      if (t.Contains(Search)) { Found = h; FoundTitle = t; return false; }
    }
    return true;
  }
}
"@
    Add-Type -TypeDefinition $code

    # 1) 先试缓存句柄
    $h = [IntPtr]::new(${hwnd})
    l "[focus-cached] hwnd=$h"
    if ([PF]::IsIconic($h)) { [PF]::ShowWindow($h, 9); l '[focus-cached-restored]' }
    $r = [PF]::SetForegroundWindow($h)
    l "[focus-cached-sfg] result=$r"
    if ($r) { return }

    # 2) 失败则枚举窗口找标题匹配的
    l "[focus-fallback] searching for '${safeWinTitle}'"
    [PF]::Search = '${safeWinTitle}'
    $cb = [PF+EnumCb]{ param($h2,$l2) [PF]::Callback($h2,$l2) }
    [PF]::EnumWindows($cb, [IntPtr]::Zero)
    if ([PF]::Found -ne [IntPtr]::Zero) {
      l "[focus-found-via-title] title='$([PF]::FoundTitle)' hwnd=$([PF]::Found)"
      if ([PF]::IsIconic([PF]::Found)) { [PF]::ShowWindow([PF]::Found, 9) }
      [PF]::SetForegroundWindow([PF]::Found) | Out-Null
    } else {
      l '[focus-notfound]'
    }
  }

  # ── 全局快捷键注册 ────────────────────────────────────────
  $MOD_ALT = 0x0001
  $VK_OEM_4 = 0xDB  # [ key
  $VK_OEM_6 = 0xDD  # ] key
  $HOTKEY_DISMISS = 1
  $HOTKEY_FOCUS = 2
  $hotkeysRegistered = $false

  function Register-Hotkeys($hwnd) {
    $code = @"
using System;
using System.Runtime.InteropServices;
public class HK {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
"@
    Add-Type -TypeDefinition $code
    $r1 = [HK]::RegisterHotKey($hwnd, $HOTKEY_DISMISS, $MOD_ALT, $VK_OEM_4)
    $r2 = [HK]::RegisterHotKey($hwnd, $HOTKEY_FOCUS, $MOD_ALT, $VK_OEM_6)
    l "[hotkeys-reg] dismiss=$r1 focus=$r2"
    $script:hotkeysRegistered = $r1 -and $r2
  }

  function Unregister-Hotkeys($hwnd) {
    if (-not $script:hotkeysRegistered) { return }
    $code = @"
using System;
using System.Runtime.InteropServices;
public class HK2 {
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
"@
    Add-Type -TypeDefinition $code
    [HK2]::UnregisterHotKey($hwnd, $HOTKEY_DISMISS) | Out-Null
    [HK2]::UnregisterHotKey($hwnd, $HOTKEY_FOCUS) | Out-Null
    l '[hotkeys-unreg]'
  }
  l '[ps-focus-ready]'

  # ── WPF 窗口 XAML
  $x = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  WindowStyle="None" AllowsTransparency="True" Background="Transparent"
  Topmost="True" ShowActivated="False" ShowInTaskbar="False" ResizeMode="NoResize"
  Opacity="${opacityVal}" Width="340" Height="120">
  <Window.Resources>
    <DropShadowEffect x:Key="shadow" BlurRadius="20" ShadowDepth="2" Opacity="0.3"/>
  </Window.Resources>
  <Border CornerRadius="10" Background="#2B2B2B" BorderBrush="#444" BorderThickness="1"
    Effect="{StaticResource shadow}">
    <Grid Margin="20,14">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <TextBlock Grid.Row="0" x:Name="Title" FontWeight="SemiBold" Foreground="#E0E0E0" FontSize="13"/>
      <TextBlock Grid.Row="1" x:Name="Body" Foreground="#999" FontSize="12" Margin="0,6,0,14" TextWrapping="Wrap"/>
      <StackPanel Grid.Row="2" Orientation="Horizontal" HorizontalAlignment="Right">
        <TextBlock x:Name="Timer" Foreground="#666" FontSize="11" VerticalAlignment="Center" Margin="0,0,16,0"/>
        <Button x:Name="DismissBtn" Content="${dismissLabel}" Width="78" Height="30" Margin="0,0,10,0" Cursor="Hand">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Border CornerRadius="4" Background="#3A3A3A">
                <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"
                  TextElement.Foreground="#CCC" TextElement.FontSize="12"/>
              </Border>
            </ControlTemplate>
          </Button.Template>
        </Button>
        <Button x:Name="FocusBtn" Content="${continueLabel}" Width="78" Height="30" Cursor="Hand">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Border CornerRadius="4" Background="#0E639C">
                <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"
                  TextElement.Foreground="White" TextElement.FontSize="12"/>
              </Border>
            </ControlTemplate>
          </Button.Template>
        </Button>
      </StackPanel>
    </Grid>
  </Border>
</Window>
'@
  l '[ps-xaml-ready]'

  $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]$x)
  $win = [System.Windows.Markup.XamlReader]::Load($reader)
  $reader.Close()
  l '[ps-window-created]'

  $win.FindName('Title').Text = '${safeTitle}'
  $win.FindName('Body').Text = '${safeBody}'
  $win.FindName('Timer').Text = '${safeElapsed}'
  $win.FindName('DismissBtn').Add_Click({ $win.Close() })
  $win.FindName('FocusBtn').Add_Click({ $win.Close(); Focus-PiTerminal })

  $wa = [System.Windows.SystemParameters]::WorkArea

  # 多窗口堆叠：用文件计数器避免重叠
  $stackFile = ([System.IO.Path]::GetTempPath() + "pi-notify-stack.txt")
  $count = 0
  if (Test-Path $stackFile) {
    try { $count = [int](Get-Content $stackFile -Raw).Trim() } catch {}
  }
  $count++
  $count | Out-File -Encoding ascii $stackFile
  $offset = ($count - 1) * 128
  l "[ps-stack] count=$count offset=$offset"

  $win.Left = $wa.Right - $win.Width - 20
  $win.Top = $wa.Bottom - $win.Height - 10 - $offset
  l '[ps-positioned]'

  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds(${timeoutSec})
  $timer.Add_Tick({ $win.Close(); $timer.Stop() })
  $timer.Start()

  # 窗口关闭时解注册热键 + 递减堆叠计数
  $win.Add_Closed({
    $timer.Stop()
    Unregister-Hotkeys $hwnd
    # 递减堆叠计数
    if (Test-Path $stackFile) {
      try {
        $c = [int](Get-Content $stackFile -Raw).Trim()
        $c--
        if ($c -le 0) { Remove-Item $stackFile -Force } else { $c | Out-File -Encoding ascii $stackFile }
      } catch {}
    }
    $frame.Continue = $false
  })

  # 先 Show 获取窗口句柄，再注册全局热键
  $win.Show()
  l '[ps-shown]'

  # 获取 WPF 窗口句柄并注册 Alt+[/] 热键
  $helper = Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
public class HotkeyHelper {
  public static void Setup(Window win, Action dismiss, Action focus, int idDismiss, int idFocus) {
    var source = PresentationSource.FromVisual(win) as HwndSource;
    if (source == null) return;
    IntPtr hwnd = source.Handle;
    uint MOD_ALT = 0x0001;
    uint VK_OEM_4 = 0xDB;
    uint VK_OEM_6 = 0xDD;
    RegisterHotKey(hwnd, idDismiss, MOD_ALT, VK_OEM_4);
    RegisterHotKey(hwnd, idFocus, MOD_ALT, VK_OEM_6);
    source.AddHook((IntPtr h, int msg, IntPtr wp, IntPtr lp, ref bool handled) => {
      if (msg == 0x0312) { // WM_HOTKEY
        int id = wp.ToInt32();
        if (id == idDismiss) { handled = true; win.Dispatcher.Invoke(dismiss); }
        else if (id == idFocus) { handled = true; win.Dispatcher.Invoke(focus); }
      }
      return IntPtr.Zero;
    });
  }
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
}
"@ -ReferencedAssemblies "WindowsBase","PresentationCore","PresentationFramework","System.Xaml" -PassThru
  l '[ps-hotkey-helper]'

  [HotkeyHelper]::Setup($win, { $win.Close() }, { $win.Close(); Focus-PiTerminal }, $HOTKEY_DISMISS, $HOTKEY_FOCUS)
  l '[ps-hotkeys-setup]'

  $frame = [System.Windows.Threading.DispatcherFrame]::new($true)
  [System.Windows.Threading.Dispatcher]::PushFrame($frame)
  l '[ps-done]'

} catch {
  l "[ps-error] $_"
  l "[ps-stack] $($_.ScriptStackTrace)"
}
`;

  // 写 ps1 到临时文件
  const psPath = join(tmpdir(), `pi-notify-${process.pid}.ps1`);
  try {
    writeFileSync(psPath, "\ufeff" + psScript, "utf-8");
    log(`ps1 written: ${psPath} (${psScript.length}B)`);
  } catch (e: unknown) {
    log(`FAIL ps1 write: ${e}`);
    return;
  }

  // 用 VBScript + wscript 启动（纯 GUI 宿主，零控制台，不闪现不最小化）
  const vbsPath = join(tmpdir(), `pi-launch-${process.pid}.vbs`);
  const escapedPsPath = psPath.replace(/\\/g, "\\\\");
  const vbsScript = `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${escapedPsPath}""", 0, False`;
  try {
    writeFileSync(vbsPath, vbsScript, "utf-8");
    log(`vbs written: ${vbsPath}`);
  } catch (e: unknown) {
    log(`FAIL vbs write: ${e}`);
    return;
  }

  const child = spawn("wscript.exe", [vbsPath], {
    stdio: "ignore",
  });
  child.unref();
  log(`spawned wscript ${vbsPath}`);

  // 延迟清理
  setTimeout(() => {
    try { unlinkSync(psPath); } catch { /* ignore */ }
    try { unlinkSync(vbsPath); } catch { /* ignore */ }
  }, 15000);
}

function notifyMacOS(title: string, body: string): void {
  spawn("osascript", [
    "-e",
    `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
  ], { detached: true, stdio: "ignore" }).unref();
}

function notifyLinux(title: string, body: string): void {
  spawn("notify-send", [title, body], { detached: true, stdio: "ignore" }).unref();
}

function showNotification(title: string, body: string): void {
  if (process.env.KITTY_WINDOW_ID) {
    process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
    process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
  } else if (process.env.GHOSTTY_RESOURCES_DIR ||
             process.env.ITERM_SESSION_ID ||
             process.env.WEZTERM_PANE) {
    process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
  } else if (platform() === "win32") {
    notifyWindows(title, body, terminalHwnd, uniqueWindowId);
  } else if (platform() === "darwin") {
    notifyMacOS(title, body);
  } else {
    notifyLinux(title, body);
  }
}

// ── 提取通知标题 ──────────────────────────────────────────────────────────

function extractPromptTitle(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as Record<string, unknown>;
      const msg = entry.message as Record<string, unknown> | undefined;
      const role = (entry.role ?? msg?.role) as string | undefined;
      if (role === "user") {
        const content = (entry.content ?? msg?.content);
        const text = extractText(content);
        if (text) {
          const cleaned = text.replace(/\s+/g, " ").trim();
          return cleaned.length > 10
            ? cleaned.slice(0, 10) + "…"
            : cleaned;
        }
        break;
      }
    }
  } catch { /* fallback */ }
  return "pi";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: string }).text;
        if (t) return t;
      }
    }
  }
  return "";
}

// ── 前台检测（wscript 启动，不干扰终端）───────────────────────────

function isTerminalForegroundAsync(): Promise<boolean> {
  if (platform() !== "win32" || !terminalHwnd || terminalHwnd === "0") {
    log(`fg-check: skip (no hwnd: "${terminalHwnd}")`);
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const psPath = join(tmpdir(), `pi-fg-${process.pid}.ps1`);
    const vbsPath = join(tmpdir(), `pi-fg-${process.pid}.vbs`);
    const outPath = join(tmpdir(), `pi-fg-${process.pid}.txt`);

    log(`fg-check: cached=${terminalHwnd}`);
    try {
      writeFileSync(psPath, "\ufeff" + `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PIFG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
[PIFG]::GetForegroundWindow().ToString()
`, "utf-8");
      const escapedPsPath = psPath.replace(/\\/g, "\\\\");
      const escapedOutPath = outPath.replace(/\\/g, "\\\\");
      const vbsScript = `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ""& '${escapedPsPath}' | Out-File -Encoding ascii '${escapedOutPath}'""", 0, True`;
      writeFileSync(vbsPath, vbsScript, "utf-8");

      const child = spawn("wscript.exe", [vbsPath], { stdio: "ignore" });
      child.on("close", () => {
        try {
          const { readFileSync } = require("node:fs");
          const fgHwnd = readFileSync(outPath, "utf-8").trim();
          const match = fgHwnd === terminalHwnd;
          log(`fg-check: foreground=${fgHwnd} match=${match}`);
          resolve(match);
        } catch {
          resolve(false);
        } finally {
          try { unlinkSync(psPath); } catch { /* */ }
          try { unlinkSync(vbsPath); } catch { /* */ }
          try { unlinkSync(outPath); } catch { /* */ }
        }
      });
      child.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

// ── 异常结束检测 ──────────────────────────────────────────────────────────

const RETRY_PATTERN = /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function getLastAssistantMessage(event: { messages?: unknown[] }): { stopReason?: string; errorMessage?: string } | null {
  try {
    const msgs = event.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return msgs[i];
    }
  } catch { /* */ }
  return null;
}

function willRetry(msg: { stopReason?: string; errorMessage?: string }): boolean {
  if (msg.stopReason !== "error" || !msg.errorMessage) return false;
  return RETRY_PATTERN.test(msg.errorMessage);
}

// ── 扩展入口 ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  log("extension loaded");
  uniqueWindowId = `pi@${process.pid.toString(36)}`;
  process.stdout.write(`\x1b]0;${uniqueWindowId}\x07`);
  log(`windowId = ${uniqueWindowId}`);
  cacheTerminalHwnd();

  // ── /notify 命令 ──────────────────────────────────────────────────────────
  pi.registerCommand("notify", {
    description: "开关/配置桌面通知",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.trim().split(/\s+/).filter(Boolean);
      const wantsNextLevel = prefix.endsWith(" ");

      // 第一级: 子命令
      if (parts.length === 0 || (parts.length === 1 && !wantsNextLevel)) {
        const subs = ["on", "off", "timeout", "opacity", "message", "lang", "config"];
        const filtered = subs.filter((s) => s.startsWith(parts[0] ?? ""));
        return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
      }
      // 第二级: 参数值 — value 必须是完整参数字符串
      const sub = parts[0];
      const val = parts[1] ?? "";
      if (sub === "timeout") {
        return ["5", "10", "15", "20", "30", "60"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: `${s}s` }));
      }
      if (sub === "opacity") {
        return ["0.5", "0.6", "0.7", "0.8", "0.9", "1.0"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: s }));
      }
      if (sub === "message") {
        return ["fixed", "response"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: s === "response" ? "AI reply (20 chars)" : "Fixed text" }));
      }
      if (sub === "lang") {
        return ["zh", "en", "ja", "ko"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: s }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const raw = args?.trim() ?? "";
      const parts = raw.split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const val = parts.slice(1).join(" ").toLowerCase();

      // /notify (无参数 → 切换)
      if (!sub) {
        enabled = !enabled;
        ctx.ui.notify(enabled ? t("enabled") : t("disabled"), "info");
        return;
      }

      // /notify on|off
      if (sub === "on" || sub === "1" || sub === "true") { enabled = true; ctx.ui.notify(t("enabled"), "info"); return; }
      if (sub === "off" || sub === "0" || sub === "false") { enabled = false; ctx.ui.notify(t("disabled"), "info"); return; }

      // /notify timeout <seconds>
      if (sub === "timeout") {
        const n = parseInt(val);
        if (n >= 5 && n <= 60) { config.timeout = n; saveConfig(config); ctx.ui.notify(`Timeout=${n}s`, "info"); }
        else { ctx.ui.notify("timeout: 5~60", "warning"); }
        return;
      }

      // /notify opacity <0.0-1.0>
      if (sub === "opacity") {
        const n = parseFloat(val);
        if (n >= 0.3 && n <= 1.0) { config.opacity = n; saveConfig(config); ctx.ui.notify(`Opacity=${n}`, "info"); }
        else { ctx.ui.notify("opacity: 0.3~1.0", "warning"); }
        return;
      }

      // /notify message fixed|response
      if (sub === "message") {
        if (val === "fixed" || val === "response") {
          config.messageMode = val; saveConfig(config);
          ctx.ui.notify(`Message=${val}`, "info");
        } else { ctx.ui.notify("Usage: /notify message fixed|response", "warning"); }
        return;
      }

      // /notify lang zh|en|ja|ko
      if (sub === "lang") {
        if (i18n[val]) { config.lang = val as typeof config.lang; saveConfig(config); ctx.ui.notify(`Language=${val}`, "info"); }
        else { ctx.ui.notify("Available: zh en ja ko", "warning"); }
        return;
      }

      // /notify config
      if (sub === "config") {
        ctx.ui.notify(
          `${t("timeoutLabel")}=${config.timeout}s ${t("opacityLabel")}=${config.opacity} ${t("modeLabel")}=${config.messageMode} ${t("langLabel")}=${config.lang} ${t("statusLabel")}=${enabled ? t("on") : t("off")}`,
          "info",
        );
        return;
      }

      ctx.ui.notify(`Unknown: ${raw} — try /notify config`, "warning");
    },
  });

  // ── 事件 ──────────────────────────────────────────────────────────────────
  pi.on("session_start", async () => {
    log("session_start");
  });

  // 重试时 agent_start 会再次触发，通过计数变化来检测
  // 压缩进行中标记（压缩期间抑制通知）
  let isCompacting = false;
  pi.on("session_before_compact", () => { isCompacting = true; log("compaction started"); });
  pi.on("session_compact", () => { isCompacting = false; log("compaction ended"); });

  // agent_start: 记录任务开始时间 + 取消待发通知
  pi.on("agent_start", () => {
    taskStartTime = Date.now();
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
      log(`agent_start: cancelled pending notification`);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    log(`agent_end: enabled=${enabled} compacting=${isCompacting}`);
    if (!enabled || isCompacting) return;

    const msg = getLastAssistantMessage(_event);
    if (msg) log(`agent_end: stopReason=${msg.stopReason} error=${!!msg.errorMessage}`);

    // aborted / 非重试错误 → 直接跳过
    if (msg) {
      if (msg.stopReason === "aborted") { log("aborted, skip"); return; }
      if (msg.stopReason === "error" && !willRetry(msg)) { log("non-retryable error, skip"); return; }
    }

    const title = extractPromptTitle(ctx);

    if (notifyTimer) clearTimeout(notifyTimer);
    // 重试需等最多 8s(sleep)，正常完成 2s 即可
    const delay = (msg && willRetry(msg)) ? 10000 : 2000;
    log(`agent_end: delay=${delay}ms`);
    notifyTimer = setTimeout(async () => {
      notifyTimer = null;
      if (isCompacting) { log("compaction in progress, skip"); return; }
      const inForeground = await isTerminalForegroundAsync();
      log(`foreground: ${inForeground}`);
      if (inForeground) return;
      const body = config.messageMode === "response"
        ? extractSummary(_event) ?? completionMsg()
        : completionMsg();
      log(`notification: "${title}" body="${body}"`);
      showNotification(title, body);
    }, delay);
  });
}
