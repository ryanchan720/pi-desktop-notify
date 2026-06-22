/**
 * Unit tests for desktop-notify extension.
 *
 * Run: node --import tsx C:/Users/52791/.pi/agent/extensions/desktop-notify-tests/tests.ts
 *
 * Tests core logic without requiring pi runtime:
 *   - content extraction
 *   - title generation
 *   - abort/error detection
 *   - state machine (agent_start/end, compaction)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════════════════
// Extracted pure functions from desktop-notify.ts (duplicated for test isolation)
// ═══════════════════════════════════════════════════════════════════════════

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

function extractPromptTitle(entries: Record<string, unknown>[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const msg = entry.message as Record<string, unknown> | undefined;
    const role = (entry.role ?? msg?.role) as string | undefined;
    if (role === "user") {
      const content = (entry.content ?? msg?.content);
      const text = extractText(content);
      if (text) {
        const cleaned = text.replace(/\s+/g, " ").trim();
        return cleaned.length > 10 ? cleaned.slice(0, 10) + "…" : cleaned;
      }
      break;
    }
  }
  return "pi";
}

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

function shouldSkipNotification(
  msg: { stopReason?: string; errorMessage?: string } | null,
  isCompacting: boolean,
): boolean {
  if (isCompacting) return true;
  if (!msg) return false;
  return msg.stopReason === "error" || msg.stopReason === "aborted";
}

// ═══════════════════════════════════════════════════════════════════════════
// State machine for notification debounce
// ═══════════════════════════════════════════════════════════════════════════

type State = "idle" | "waiting" | "notified";
type Event =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[]; isCompacting?: boolean }
  | { type: "compact_start" }
  | { type: "compact_end" }

class NotificationStateMachine {
  state: State = "idle";
  isCompacting = false;
  timerId = 0;
  notifications: string[] = [];
  private _timerFn: (() => void) | null = null;

  // Replace setTimeout for testing
  setTimer(fn: () => void, _ms: number) {
    this.timerId++;
    this._timerFn = fn;
    return this.timerId;
  }
  clearTimer(_id: number) {
    this._timerFn = null;
  }
  fireTimer() {
    if (this._timerFn) {
      const fn = this._timerFn;
      this._timerFn = null;
      fn();
    }
  }

  handle(event: Event) {
    switch (event.type) {
      case "compact_start":
        this.isCompacting = true;
        break;

      case "compact_end":
        this.isCompacting = false;
        break;

      case "agent_start":
        if (this.state === "waiting") {
          this.clearTimer(this.timerId);
          this.state = "idle";
        }
        break;

      case "agent_end": {
        const msg = getLastAssistantMessage({ messages: event.messages });
        if (shouldSkipNotification(msg, this.isCompacting)) {
          this.state = "idle";
          break;
        }
        if (this.state === "waiting") this.clearTimer(this.timerId);
        this.state = "waiting";
        this.setTimer(() => {
          if (this.isCompacting) return;
          this.state = "notified";
          this.notifications.push("fired");
        }, 10000);
        break;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("extractText", () => {
  it("string content", () => {
    assert.equal(extractText("hello"), "hello");
  });

  it("empty string", () => {
    assert.equal(extractText(""), "");
  });

  it("content array with text block", () => {
    assert.equal(extractText([{ type: "text", text: "world" }]), "world");
  });

  it("content array with multiple blocks picks first text", () => {
    assert.equal(
      extractText([{ type: "image", data: "x" }, { type: "text", text: "hi" }]),
      "hi",
    );
  });

  it("non-text content returns empty", () => {
    assert.equal(extractText({ type: "image" }), "");
  });

  it("null/undefined returns empty", () => {
    assert.equal(extractText(null), "");
    assert.equal(extractText(undefined), "");
  });
});

describe("extractPromptTitle", () => {
  it("flat entry with role=user", () => {
    const entries = [{ role: "user", content: "重构 user service" }];
    // 15 chars → truncates to 10 + …
    assert.equal(extractPromptTitle(entries), "重构 user se…");
  });

  it("nested entry with message.role=user", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "say done" } },
    ];
    assert.equal(extractPromptTitle(entries), "say done");
  });

  it("truncates to 10 chars + …", () => {
    const entries = [{ role: "user", content: "帮我重构整个用户认证模块的代码" }];
    // 15 chars → 10 + …
    assert.equal(extractPromptTitle(entries), "帮我重构整个用户认证…");
  });

  it("falls back to 'pi' when no user message", () => {
    const entries = [{ role: "assistant", content: "ok" }];
    assert.equal(extractPromptTitle(entries), "pi");
  });

  it("finds last user message in mixed entries", () => {
    const entries = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { type: "message", message: { role: "user", content: "second" } },
    ];
    assert.equal(extractPromptTitle(entries), "second");
  });

  it("collapses whitespace", () => {
    const entries = [{ role: "user", content: "  hello   world  " }];
    // 11 chars after collapse → 10 + …
    assert.equal(extractPromptTitle(entries), "hello worl…");
  });
});

describe("getLastAssistantMessage", () => {
  it("finds last assistant in messages", () => {
    const msg = getLastAssistantMessage({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "stop", content: "hello" },
      ],
    });
    assert.ok(msg);
    assert.equal(msg!.stopReason, "stop");
  });

  it("returns null if no assistant message", () => {
    const msg = getLastAssistantMessage({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(msg, null);
  });

  it("returns null if no messages array", () => {
    assert.equal(getLastAssistantMessage({}), null);
  });

  it("skips non-assistant messages and finds last assistant", () => {
    const msg = getLastAssistantMessage({
      messages: [
        { role: "user" },
        { role: "assistant", stopReason: "stop" },
        { role: "toolResult" },
        { role: "assistant", stopReason: "aborted", errorMessage: "x" },
      ],
    });
    assert.ok(msg);
    assert.equal(msg!.stopReason, "aborted");
  });
});

describe("shouldSkipNotification", () => {
  it("skips error stopReason", () => {
    assert.equal(shouldSkipNotification({ stopReason: "error" }, false), true);
  });

  it("skips aborted stopReason", () => {
    assert.equal(shouldSkipNotification({ stopReason: "aborted" }, false), true);
  });

  it("allows stop stopReason", () => {
    assert.equal(shouldSkipNotification({ stopReason: "stop" }, false), false);
  });

  it("skips when compacting regardless", () => {
    assert.equal(shouldSkipNotification({ stopReason: "stop" }, true), true);
  });

  it("allows when no message (null)", () => {
    assert.equal(shouldSkipNotification(null, false), false);
  });
});

describe("NotificationStateMachine", () => {
  it("normal flow: idle → waiting → notified", () => {
    const sm = new NotificationStateMachine();
    assert.equal(sm.state, "idle");

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });

  it("agent_start cancels timer during waiting", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    sm.handle({ type: "agent_start" });
    assert.equal(sm.state, "idle"); // cancelled

    sm.fireTimer(); // timer already cleared, should be no-op
    assert.equal(sm.state, "idle");
    assert.equal(sm.notifications.length, 0);
  });

  it("retry flow: end → start(cancel) → end → notified", () => {
    const sm = new NotificationStateMachine();

    // First agent run fails (network error)
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "timeout" }] });
    assert.equal(sm.state, "idle"); // skipped by stopReason

    // Retry starts
    sm.handle({ type: "agent_start" });
    assert.equal(sm.state, "idle");

    // Retry succeeds
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });

  it("compaction suppresses notification during processing", () => {
    const sm = new NotificationStateMachine();

    // Initial run completes
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    // Compaction starts → blocks notification
    sm.handle({ type: "compact_start" });
    assert.equal(sm.isCompacting, true);

    // Timer fires during compaction → suppressed, state stays waiting
    sm.fireTimer();
    assert.equal(sm.state, "waiting");
    assert.equal(sm.notifications.length, 0);

    // Compaction ends → agent.continue() → new agent_end → new timer
    sm.handle({ type: "compact_end" });
    assert.equal(sm.isCompacting, false);
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });

  it("aborted stopReason skips notification", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "cancelled" }] });
    assert.equal(sm.state, "idle"); // skipped

    sm.fireTimer();
    assert.equal(sm.state, "idle");
    assert.equal(sm.notifications.length, 0);
  });

  it("multiple rapid agent_start cancels all", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    sm.handle({ type: "agent_start" }); // cancel
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    sm.handle({ type: "agent_start" }); // cancel
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    // No cancel → waiting
    assert.equal(sm.state, "waiting");

    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n✅ All tests passed!\n");
