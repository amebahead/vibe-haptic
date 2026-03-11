# Trackpad Gesture Input for Claude Code Permission Responses

**Date:** 2026-03-11
**Status:** Draft
**Branch:** feature/interaction-with-me

## Overview

Reverse the existing data flow: instead of Claude Code → haptic feedback (output), enable trackpad → Claude Code (input). When Claude Code requests permission (e.g., file modification approval), the user responds with 3-finger trackpad gestures instead of typing.

- 3-finger tap × 1 → **yes** (`y` + Enter)
- 3-finger tap × 2 (within 300ms) → **no** (`n` + Enter)

## Goals

- Respond to Claude Code permission prompts without typing or even looking at the screen
- Work regardless of whether the terminal is focused
- Provide haptic confirmation so the user knows the gesture was recognized

## Non-Goals

- OpenCode support (Claude Code only for now)
- General-purpose input beyond yes/no
- Custom gesture mapping (beyond config for timeouts)

## Architecture

### End-to-End Flow

```
Claude Code permission request
  → hook event (Notification)
  → haptic-hook spawns touch listener
  → MultitouchSupport detects 3-finger tap(s)
  → 300ms double-tap window resolves to single or double
  → CGEventPostToPid sends keystroke to terminal PID
  → HapticEngine plays confirmation pattern
  → touch listener exits
```

### Components

#### 1. Hook Extension

The existing `hooks/hooks.json` already handles Stop and Notification events. The Notification handler in `src/claude/hook.ts` will be extended to detect permission-related events and spawn the gesture orchestrator.

#### 2. Touch Listener (Rust — `native/src/touch.rs`)

New Rust module using the MultitouchSupport private framework (already used by the project for haptic output).

**Gesture recognition logic:**
- Register a touch callback via `MTRegisterContactFrameCallback`
- Each frame: count active fingers in `Touching` state
- When 3 fingers transition from Touching → NotTouching simultaneously = 1 tap
- After first tap, start a 300ms timer
- Second tap within window → emit `Double` (no)
- Timer expires with no second tap → emit `Single` (yes)

**Exported function:**
```typescript
export function startTouchListener(
  callback: (gesture: "single" | "double") => void,
  options?: { tapTimeout?: number }
): StopHandle
```

The `StopHandle` has a `stop()` method to unregister the callback and clean up.

#### 3. Key Injection (Rust — `native/src/keyboard.rs`)

New Rust module using CoreGraphics CGEvent API for keystroke injection.

**Process:**
1. Create `CGEventCreateKeyboardEvent` for key down
2. Post to terminal PID via `CGEventPostToPid`
3. Create and post key up event
4. Repeat for Return key (keycode 0x24)

**Terminal PID discovery:**
Walk the parent process chain from the current process to find the terminal application (Terminal.app, iTerm2, Warp, etc.).

**Exported functions:**
```typescript
export function sendKeystroke(pid: number, key: string): void
export function findTerminalPid(): number | null
```

**Required permissions:**
- **Accessibility** — required for `CGEventPostToPid`. User must grant in System Settings → Privacy & Security → Accessibility.
- **Input Monitoring** — may be required for MultitouchSupport touch callbacks depending on macOS version.

#### 4. Gesture Orchestrator (TypeScript — `src/claude/gesture.ts`)

Coordinates the flow between touch listener, key injection, and haptic feedback.

```typescript
export async function handlePermissionGesture(): Promise<void> {
  const terminalPid = findTerminalPid()
  if (!terminalPid) return // can't find terminal, fall back to manual input

  const stop = startTouchListener((gesture) => {
    // Send keystroke
    const key = gesture === "single" ? "y" : "n"
    sendKeystroke(terminalPid, key)

    // Confirmation haptic
    const pattern = gesture === "single" ? "confirm-yes" : "confirm-no"
    engine.trigger(pattern)

    // Clean up
    stop()
  })

  // Auto-stop after 10 seconds if no gesture
  setTimeout(() => stop(), 10_000)
}
```

#### 5. Confirmation Haptic Patterns

Added to `src/patterns.ts` alongside existing patterns:

| Pattern | Beat notation | Feel |
|---------|--------------|------|
| `confirm-yes` | `6/0.6 3/0.4` | Short, light double-tap — "confirmed" |
| `confirm-no` | `6/1.0  6/1.0` | Strong, slow double-tap — "rejected" |

## Configuration

Extends the existing config system in `src/config.ts`:

```json
{
  "gesture": {
    "enabled": true,
    "tapTimeout": 300,
    "listenTimeout": 10000
  }
}
```

- `enabled` — toggle gesture input on/off (default: `true`)
- `tapTimeout` — milliseconds to wait for double-tap (default: `300`)
- `listenTimeout` — milliseconds before auto-stopping listener (default: `10000`)

## File Changes

| Status | File | Description |
|--------|------|-------------|
| NEW | `native/src/touch.rs` | Touch event detection via MultitouchSupport |
| NEW | `native/src/keyboard.rs` | CGEvent keystroke injection |
| MOD | `native/src/lib.rs` | Register new modules + napi exports |
| MOD | `native/Cargo.toml` | Add `core-graphics` dependency |
| MOD | `native/index.d.ts` | Type declarations for new functions |
| NEW | `src/claude/gesture.ts` | Gesture orchestrator |
| MOD | `src/claude/hook.ts` | Permission event detection |
| MOD | `src/patterns.ts` | Add confirm-yes/no patterns |
| MOD | `src/types.ts` | Gesture-related types |
| MOD | `hooks/hooks.json` | Updated Notification handler |

## Testing Strategy

- **Unit tests:** Gesture recognition logic (tap counting, timeout handling, single vs double classification)
- **Native module tests:** `startTouchListener`, `sendKeystroke`, `findTerminalPid` on macOS
- **Integration test:** Full flow in tmux session — trigger permission event, simulate gesture, verify keystroke delivery
- **Platform fallback:** Verify graceful no-op on non-macOS platforms

## Edge Cases

- **No terminal found:** `findTerminalPid()` returns null → gesture feature silently disabled, user types normally
- **Accessibility permission denied:** `CGEventPostToPid` fails → log warning, no keystroke sent
- **Rapid permissions:** If a new permission arrives while listener is active, the existing listener handles the current one; the next hook invocation spawns a new listener
- **Accidental touch:** 10-second timeout prevents stale listeners; user can always type manually regardless of gesture state
