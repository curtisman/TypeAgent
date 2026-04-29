# Chunk D sub-plan: output analyzer

## Scope

| Item | Description                 | In scope |
| ---- | --------------------------- | -------- |
| D.1  | Decision: BLOCKED detection | Yes      |
| D.2  | Output analyzer (regex v1)  | Yes      |

## Decisions

### D.1: BLOCKED detection heuristic

**Decision:** BLOCKED is detected via output pattern matching only
(not silence alone). The silence timer in Session already handles
the case where the agent goes completely silent (transitioning to
TIMED_OUT). BLOCKED is reserved for the case where the agent is
_actively waiting for user input_ (tool approval prompts, Y/N
confirmations, etc.).

Rationale:

- Silence alone is ambiguous: the agent may be thinking, making
  an API call, or genuinely stuck. TIMED_OUT covers this.
- Tool approval prompts are a recognizable pattern that the
  orchestrator can detect and surface as BLOCKED.
- The dashboard will show BLOCKED lanes prominently so the
  operator can focus the lane and respond.

The analyzer emits a `blocked` signal when it detects an approval
pattern. The Session class exposes a new `markBlocked()` method
(or the orchestrator layer calls it based on analyzer signals).
For Phase 1, the Session does not directly consume analyzer signals.
The orchestrator (Chunk E/F) is responsible for wiring analyzer
output to session state transitions.

## Component design

### File: `src/analyzer.ts`

#### Exported types

```typescript
/** Signal emitted by the output analyzer for a single line. */
export type Signal =
  | { kind: "progress"; summary: string }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "milestone"; description: string }
  | { kind: "noise" };
```

Note: `idle` is removed from Signal types. Silence detection is
handled by Session's timeout timer, not the analyzer. Lines that
don't match any pattern are classified as `noise`.

#### Exported function

```typescript
/**
 * Classify a single output line into a signal.
 * Pure function, no side effects.
 */
export function analyzeLine(line: string): Signal;
```

#### Pattern table (v1)

| Pattern (case-insensitive)                               | Signal    | Captures                    |
| -------------------------------------------------------- | --------- | --------------------------- |
| `permission\|approve\|confirm\|do you want\|y/n\|yes/no` | blocked   | Matched text as reason      |
| `error\|Error\|FAIL\|panic\|Traceback`                   | error     | Matched text as message     |
| `created?\s+file\|wrote\|editing\|modified\|deleted`     | progress  | Matched text as summary     |
| `running\|executing\|pnpm\|npm run\|node `               | progress  | Matched text as summary     |
| `tests?\s+pass\|build succeeded\|✓`                      | milestone | Matched text as description |
| `commit\|pushed\|merged`                                 | milestone | Matched text as description |
| _(no match)_                                             | noise     |                             |

Patterns are tested in priority order: blocked > error > milestone >
progress > noise. This ensures approval prompts aren't misclassified
as progress.

## Test plan

### Test file

```
tools/agentOrchestrator/test/analyzer.spec.ts
```

### Strategy

Analyzer tests are pure unit tests (no I/O). Each test feeds a
line string to `analyzeLine()` and verifies the returned signal.

### Test cases

| #   | Test name                               | Input line                           | Expected signal kind |
| --- | --------------------------------------- | ------------------------------------ | -------------------- |
| 1   | detects tool approval prompt as blocked | "Do you want to run this tool?"      | blocked              |
| 2   | detects Y/N confirmation as blocked     | "Continue? (y/n)"                    | blocked              |
| 3   | detects permission request as blocked   | "Permission to write to file.ts"     | blocked              |
| 4   | detects error keyword                   | "Error: ENOENT no such file"         | error                |
| 5   | detects FAIL keyword                    | "FAIL src/test.spec.ts"              | error                |
| 6   | detects Traceback                       | "Traceback (most recent call last):" | error                |
| 7   | detects panic                           | "panic: runtime error"               | error                |
| 8   | detects file creation as progress       | "Created file src/index.ts"          | progress             |
| 9   | detects file edit as progress           | "Editing src/config.ts"              | progress             |
| 10  | detects npm run as progress             | "running npm run build"              | progress             |
| 11  | detects test pass as milestone          | "Tests: 5 passed, 5 total"           | milestone            |
| 12  | detects build success as milestone      | "build succeeded"                    | milestone            |
| 13  | detects commit as milestone             | "committed changes to main"          | milestone            |
| 14  | returns noise for unrecognized line     | "thinking about the problem..."      | noise                |
| 15  | returns noise for empty string          | ""                                   | noise                |
| 16  | blocked takes priority over progress    | "Do you want to run npm install?"    | blocked              |
| 17  | error takes priority over progress      | "Error running npm run build"        | error                |

## Build verification

```bash
cd /home/curtism/src/TypeAgent3/ts/tools/agentOrchestrator
npx tsc -b && pnpm run test
```

Expected: all tests pass (config + worktree + driver + session +
orchestratorSession + analyzer).

## Commit plan

### Commit 1: D.2 - output analyzer

**Message:** `D.2: output analyzer with regex-based signal classification`

**Files created:**

- `tools/agentOrchestrator/src/analyzer.ts`
- `tools/agentOrchestrator/test/analyzer.spec.ts`

**Files modified:**

- `tools/agentOrchestrator/src/index.ts` (add analyzer re-exports)
- `docs/plans/agent-orchestrator/chunk-D-subplan.md` (this file)

**Verification:** `npx tsc -b && pnpm run test` passes.
