# Chunk E Sub-plan: Text-mode Dashboard

Depends on: Chunks C (session manager) and D (output analyzer).

## Decisions

### E.1: Lane selection UX

Number keys 1-9 select a lane (highlighted with `>`). Then action
keys operate on the selected lane: `f` to focus, `k` to kill. The
`q` key quits regardless of selection. Only one lane is selected at
a time. Default selection is lane 1.

### E.2: Focus-mode escape

In focus mode, all keyboard input passes through to the pty except
**Ctrl-]** (byte 0x1d), which exits focus mode and returns to the
overview. Ctrl-] is the traditional telnet escape character. It
avoids ambiguity with Esc (0x1b), which agents use for editor and
menu navigation.

## Implementation

### E.3a: Analyzer ANSI stripping

Real pty output contains ANSI escape codes (colors, cursor moves).
Strip these before regex matching so patterns like `\bError\b` match
colored output. Add `stripAnsi()` to `analyzer.ts`.

### E.3b: Session analyzer integration

Wire `analyzeLine()` into `Session.handleData()` so the session:

- Transitions RUNNING -> BLOCKED when a blocked signal is detected.
- Transitions BLOCKED -> RUNNING when non-blocked output arrives.
- Stores the last non-noise signal kind for dashboard display.

### E.3c: Dashboard (`src/dashboard.ts`)

Text-mode dashboard using ANSI escape codes and `setInterval`.

Rendering (every 500ms):

- Header: session ID, lane count
- Per lane: number, name, state indicator, elapsed time, commit
  count, last output line (truncated to terminal width)
- Status bar: available key bindings

Keyboard (stdin raw mode):

- 1-9: select lane
- f: enter focus mode for selected lane
- k: kill selected lane
- q: graceful quit (SIGTERM all active, wait, resolve done promise)

Focus mode:

- Show recent output buffer, then stream live output
- All input to pty except Ctrl-] (exit focus)

Commit counts: async git log on a 10-second timer, cached per lane.

### E.3d: Main orchestration (`src/main.ts`)

Full startup flow: load config, setup worktrees, create sessions,
spawn agents, start dashboard, periodic session persistence, signal
handling (SIGINT/SIGTERM trigger graceful quit).

## Files

| File               | Action                                                          |
| ------------------ | --------------------------------------------------------------- |
| `src/analyzer.ts`  | Add `stripAnsi` before regex matching                           |
| `src/session.ts`   | Import analyzer, wire BLOCKED transitions, add `lastSignalKind` |
| `src/dashboard.ts` | New: text-mode dashboard class                                  |
| `src/main.ts`      | Replace stub with full orchestration                            |
| `src/index.ts`     | Re-export Dashboard                                             |

## Test strategy

The dashboard is interactive UI; no unit tests. Existing session and
analyzer tests cover the wiring. Manual smoke test after Chunk F
with mock agents validates the full flow.
