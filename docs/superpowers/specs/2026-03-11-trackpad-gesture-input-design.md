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
  → hook event (Notification, notification_type: "permission_prompt")
  → haptic-hook spawns detached gesture-listener process
  → haptic-hook exits (within hook timeout)
  → gesture-listener: MultitouchSupport detects 3-finger tap(s)
  → 300ms double-tap window resolves to single or double
  → gesture-listener: activate terminal → CGEvent keystroke → reactivate previous app
  → HapticEngine plays confirmation pattern
  → gesture-listener process exits
```

### Components

#### 1. Hook Extension

The existing `hooks/hooks.json` already handles Stop and Notification events with a broad matcher (`permission_prompt|idle_prompt|elicitation_dialog`). **The `hooks.json` matcher must remain broad** — all notification types should still trigger haptic feedback (the `alert` pattern). The gesture-specific filtering happens in TypeScript code only.

The Notification handler in `src/claude/hook.ts` will be extended to:

1. Continue playing haptic feedback for all notification types (existing behavior)
2. Additionally inspect `notification_type` — only activate gesture handling for `permission_prompt` (not `idle_prompt` or `elicitation_dialog`)
3. Check `isAccessibilityGranted()` upfront — if Accessibility is not granted, log a warning and skip gesture handling
4. Discover the terminal PID via `findTerminalPid()` **before spawning** (the hook process has the correct parent chain; after detaching, the parent chain is lost)
5. Spawn the gesture listener as a **detached child process**, passing the terminal PID as a CLI argument

The hook process itself exits immediately after spawning. The gesture listener runs independently.

#### 2. Touch Listener (Rust — `native/src/touch.rs`)

New Rust module using the MultitouchSupport private framework's **touch input API**. Note: the project already uses MultitouchSupport's `MTActuator*` functions for haptic output (actuation). Touch input uses a separate set of functions from the same framework — `MTDeviceCreateList`, `MTDeviceStart`, `MTRegisterContactFrameCallback` — which require additional FFI declarations.

**Gesture recognition logic:**
- Enumerate multitouch devices via `MTDeviceCreateList`
- Start device and register frame callback via `MTRegisterContactFrameCallback`
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

export interface StopHandle {
  stop(): void
}
```

**Required permissions:**
- **Input Monitoring** — may be required for `MTRegisterContactFrameCallback` depending on macOS version. User must grant in System Settings → Privacy & Security → Input Monitoring.

#### 3. Key Injection (Rust — `native/src/keyboard.rs`)

New Rust module using CoreGraphics CGEvent API and NSWorkspace for keystroke injection to unfocused terminals.

**Why not `CGEventPostToPid`:** This function does not exist on modern macOS. `CGEventPost` sends to the frontmost application only. To target an unfocused terminal, we use an activate-send-deactivate pattern.

**Process:**
1. Save the current frontmost application via `NSWorkspace.shared.frontmostApplication`
2. Activate the terminal app via `NSRunningApplication.activate(options:)`
3. Create `CGEventCreateKeyboardEvent` for key down
4. Post via `CGEventPost(kCGHIDEventTap, event)`
5. Create and post key up event
6. Repeat for Return key (keycode 0x24)
7. Reactivate the previously frontmost application

The brief window switch (~50ms) is barely perceptible.

**Terminal PID discovery:**
Walk the parent process chain from the current process to find the terminal application (Terminal.app, iTerm2, Warp, etc.). Match by checking the parent process against known terminal bundle identifiers or binary names.

**Exported functions:**
```typescript
export function sendKeystrokeToTerminal(terminalPid: number, key: string): void
export function findTerminalPid(): number | null
export function isAccessibilityGranted(): boolean
```

**Required permissions:**
- **Accessibility** — required for `CGEventPost` to HID event tap. User must grant in System Settings → Privacy & Security → Accessibility.

#### 4. Gesture Orchestrator (TypeScript — `src/claude/gesture.ts`)

Runs as a standalone detached process spawned by the hook. Receives the terminal PID as a CLI argument. Coordinates touch listener, key injection, and haptic feedback.

**Cross-process coordination:** Uses a lock file (`/tmp/vibe-haptic-gesture.lock`) to prevent multiple gesture listeners from responding to the same tap. The lock file contains the listener's PID. On startup, the orchestrator checks for an existing lock file — if a valid (still-running) process holds the lock, the new instance exits immediately. On exit (or crash), the lock file is cleaned up.

```typescript
// Entry point: receives terminalPid from CLI args
const terminalPid = parseInt(process.argv[2])

export async function handlePermissionGesture(terminalPid: number): Promise<void> {
  // Acquire lock (exit if another listener is active)
  if (!acquireGestureLock()) return

  let answered = false
  let stopHandle: StopHandle

  stopHandle = startTouchListener((gesture) => {
    if (answered) return // prevent duplicate responses
    answered = true

    // Send keystroke
    const key = gesture === "single" ? "y" : "n"
    sendKeystrokeToTerminal(terminalPid, key)

    // Confirmation haptic
    const pattern = gesture === "single" ? "confirm-yes" : "confirm-no"
    engine.trigger(pattern)

    // Clean up
    stopHandle.stop()
    releaseGestureLock()
  })

  // Auto-stop after listenTimeout if no gesture
  setTimeout(() => {
    if (!answered) {
      stopHandle.stop()
      releaseGestureLock()
    }
  }, config.gesture.listenTimeout)
}
```

**Lock file functions:**
- `acquireGestureLock()` — writes PID to `/tmp/vibe-haptic-gesture.lock`. Returns `false` if lock is held by a live process.
- `releaseGestureLock()` — removes the lock file. Also called via `process.on('exit')` for crash cleanup.

The `answered` flag prevents the in-process race condition where a user types manually and then a gesture also fires. The lock file prevents the cross-process race condition where multiple listeners spawn for rapid permission requests.

#### 5. Confirmation Haptic Patterns

Added to `src/patterns.ts` alongside existing patterns:

| Pattern | Beat notation | Feel | Notes |
|---------|--------------|------|-------|
| `confirm-yes` | `6/0.6 3/0.4` | Short, light double-tap — "confirmed" | Single space = 100ms pause |
| `confirm-no` | `6/1.0  6/1.0` | Strong, slow double-tap — "rejected" | Double space = 200ms pause (intentional) |

These patterns must be added to `DEFAULT_PATTERNS` in `src/patterns.ts` so that `resolvePattern()` can find them. They are triggered directly by name via `engine.trigger()`, not through the event mapping system (`triggerForEvent`). This is intentional — they are internal feedback patterns, not user-facing events. Users can override them via the `patterns` config key (e.g., `{"patterns": {"confirm-yes": "6/1.0"}}`).

## Type Changes

### `src/types.ts` additions

```typescript
export interface GestureConfig {
  enabled: boolean
  tapTimeout: number
  listenTimeout: number
}

export interface HapticConfig {
  patterns?: Record<string, string>
  events?: Partial<Record<HapticEvent, string>>
  gesture?: Partial<GestureConfig>  // new field
}
```

### `src/config.ts` changes

The `mergeConfig` function must be updated to also merge the `gesture` key:

```typescript
function mergeConfig(base: HapticConfig, override: HapticConfig): HapticConfig {
  return {
    patterns: { ...base.patterns, ...override.patterns },
    events: { ...base.events, ...override.events },
    gesture: { ...base.gesture, ...override.gesture },  // new
  }
}
```

Default gesture config:
```typescript
const defaultGestureConfig: GestureConfig = {
  enabled: true,
  tapTimeout: 300,
  listenTimeout: 10_000,
}
```

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
| NEW | `native/src/touch.rs` | Touch event detection via MultitouchSupport input API |
| NEW | `native/src/keyboard.rs` | CGEvent keystroke injection + window activation |
| MOD | `native/src/lib.rs` | Register new modules + napi exports |
| MOD | `native/Cargo.toml` | Add `core-graphics`, `cocoa`, `objc` dependencies |
| MOD | `native/index.d.ts` | Type declarations for new functions |
| NEW | `src/claude/gesture.ts` | Gesture orchestrator (runs as detached process) |
| MOD | `src/claude/hook.ts` | Permission prompt detection + gesture process spawn |
| MOD | `src/patterns.ts` | Add confirm-yes/no patterns |
| MOD | `src/types.ts` | GestureConfig type, HapticConfig extension |
| MOD | `src/config.ts` | Merge gesture config, default values |
| MOD | `hooks/hooks.json` | No matcher changes; handler script path may update |

## Testing Strategy

- **Unit tests:** Gesture recognition logic (tap counting, timeout handling, single vs double classification) — test the state machine with synthetic touch frame sequences
- **Native module tests:** `findTerminalPid`, `isAccessibilityGranted` on macOS; `sendKeystrokeToTerminal` with a mock target process
- **Integration test:** Full flow in tmux session — trigger permission event, simulate gesture, verify keystroke delivery
- **Gesture simulation for CI:** Touch listener tests use a mock that directly invokes the gesture callback with `"single"` or `"double"`, bypassing MultitouchSupport. The native touch recognition logic is tested separately with synthetic `MTTouch` frame data.
- **Platform fallback:** Verify graceful no-op on non-macOS platforms (all native functions return null/false)

## Edge Cases

- **No terminal found:** `findTerminalPid()` returns null → gesture feature silently disabled, user types normally
- **Accessibility permission denied:** `isAccessibilityGranted()` returns false at startup → log warning, skip gesture listener entirely
- **Rapid permissions:** If a new permission arrives while a listener is active, the new detached process checks the lock file, finds an active listener, and exits immediately. The existing listener handles the current permission. The next permission after the listener exits will spawn a new listener successfully.
- **User types manually while listener is active:** The `answered` flag prevents the gesture listener from sending a duplicate response. The listener auto-stops after `listenTimeout`.
- **Accidental touch:** 10-second timeout prevents stale listeners; only 3-finger taps are recognized (other finger counts are ignored)
- **Hook timeout:** The hook process exits immediately after spawning the detached gesture listener. The listener runs independently and is not affected by the hook's 5-second timeout.
