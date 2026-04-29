# Chunk C Sub-plan: Session Manager and Agent Driver

Parent: [PLAN.md](PLAN.md) - Chunk C (PR 2 start)

## Scope

| Item | Description                                | In scope |
| ---- | ------------------------------------------ | -------- |
| C.1  | Decision: KILLED and TIMED_OUT states      | Resolved |
| C.2  | Decision: timeout behavior                 | Resolved |
| C.3  | Decision: pause/resume semantics           | Resolved |
| C.4  | Decision: SIGINT/SIGTERM teardown          | Resolved |
| C.5  | Agent driver interface + copilot driver    | Yes      |
| C.6  | Session manager (node-pty + state machine) | Yes      |
| C.7  | Orchestrator session persistence           | Yes      |

Out of scope: output analyzer (Chunk D), dashboard (Chunk E),
notifications (Chunk F), Ink TUI (Phase 2). The session manager
emits events but does not classify output beyond line buffering.

## Resolved decisions

### C.1: KILLED and TIMED_OUT states

**Decision:** add both as distinct terminal states. The full state
enum becomes:

```typescript
type LaneState =
  | "IDLE"
  | "RUNNING"
  | "BLOCKED"
  | "DONE"
  | "FAILED"
  | "KILLED"
  | "TIMED_OUT"
  | "PUSHED"
  | "ABANDONED";
```

Rationale: KILLED means the operator explicitly force-stopped the
lane. TIMED_OUT means the lane exceeded its configured timeout.
Both are distinct from FAILED (agent exited non-zero on its own)
because they imply different operator responses: KILLED was
intentional, TIMED_OUT may warrant a longer timeout or a simpler
prompt.

`DONE`, `FAILED`, `KILLED`, and `TIMED_OUT` all allow the same
post-completion actions (resume, retry, diff, push, cleanup).

### C.2: Timeout behavior

**Decision:** on timeout, kill the pty process (SIGTERM, then
SIGKILL after 5s grace), transition to TIMED_OUT, notify. The
timeout timer resets on every output line (so an active agent
never times out, only a silent one).

Behavior table:

| Condition                           | Action                          |
| ----------------------------------- | ------------------------------- |
| Lane has `timeout` config           | Start timer on spawn            |
| Agent produces output               | Reset timer                     |
| Timer expires                       | SIGTERM the pty, start 5s grace |
| Grace period expires                | SIGKILL the pty                 |
| Process exits after SIGTERM/SIGKILL | Transition to TIMED_OUT         |
| Lane has no `timeout` config        | No timer (run indefinitely)     |

Rationale: timeout means "the agent went silent for too long."
Resetting on output avoids killing an agent that is actively
working but slow. The SIGTERM-then-SIGKILL sequence matches
standard process management practice.

### C.3: Pause/resume semantics

**Decision:** remove pause from Phase 1. No SIGSTOP/SIGCONT.

Rationale: pausing an agent mid-stream is risky (may corrupt
its internal state or lose API connections). The useful case
(temporarily halt a lane to free resources) is rare in v1 where
we run 3-5 lanes. Removing pause simplifies the state machine
and the dashboard keybindings. Can revisit in Phase 3.

The `[p]ause` key in the PLAN.md dashboard mockup should be
removed. (The `[p]ush` post-completion keybinding stays.)

### C.4: SIGINT/SIGTERM teardown sequence

**Decision:** on orchestrator shutdown (Ctrl+C or `[q]uit`):

1. Send SIGTERM to all running pty processes.
2. Wait up to 5 seconds for graceful exit.
3. Send SIGKILL to any still-running processes.
4. Save session state to `session.json` (running lanes saved as KILLED).
5. Do NOT remove worktrees (operator may want to inspect).
6. Print summary and exit.

The session manager exposes a `shutdown()` method that performs
steps 1-3 for a single lane. The orchestrator (Chunk E/F) calls
`shutdown()` on all lanes, then persists the session.

Rationale: agents like Copilot and Claude handle SIGTERM gracefully
(save state, print session ID). Worktree cleanup is left to the
operator since they may want to resume or inspect the work.
Persisting session state enables `--resume` to restore dashboard
state after a quit or crash.

## Component design

### File: `src/driver.ts`

#### Exported types

```typescript
/** Command specification for spawning an agent process. */
export interface SpawnSpec {
  /** Executable name or path. */
  file: string;
  /** Command-line arguments. */
  args: string[];
  /** Optional environment variable overrides. */
  env?: Record<string, string>;
}

/** Abstract interface for agent CLI drivers. */
export interface AgentDriver {
  /** Human-readable driver name (e.g. "copilot", "claude"). */
  readonly name: string;

  /** Whether this driver supports --allow-tool style pre-auth. */
  readonly supportsToolAllowList: boolean;

  /** Whether this driver supports session resume. */
  readonly supportsSessionResume: boolean;

  /** Build the spawn command for a fresh agent session. */
  buildCommand(config: LaneConfig, promptText: string): SpawnSpec;

  /**
   * Build a resume command. Returns null if not supported.
   * @param config - Lane configuration.
   * @param sessionId - Captured from the agent's exit output.
   * @param followUp - Optional follow-up instructions.
   */
  buildResumeCommand(
    config: LaneConfig,
    sessionId?: string,
    followUp?: string,
  ): SpawnSpec | null;

  /**
   * Extract a session ID from the agent's output buffer.
   * Called after process exit to capture the ID for resume.
   * Returns undefined if no session ID is found.
   */
  extractSessionId(outputLines: string[]): string | undefined;
}
```

Note: `buildCommand` takes `promptText` (the file contents read by
the caller) rather than the file path. This lets the session manager
read the prompt file once and pass the text, keeping the driver
stateless.

#### Exported function

```typescript
/** Look up a driver by name. Throws if unknown. */
export function getDriver(name: string): AgentDriver;
```

v1 registry is a simple `Map<string, AgentDriver>` with "copilot"
and "claude" entries. No dynamic loading.

### File: `src/drivers/copilot.ts`

Copilot CLI driver. Based on actual `copilot --help` output:

```
copilot -p <prompt-text> [--allow-tool <tool>...] [--resume <id>] [--continue]
```

| Flag            | Usage                                            |
| --------------- | ------------------------------------------------ |
| `-p <text>`     | Non-interactive prompt (required for automation) |
| `--allow-tool`  | Repeatable tool permission pre-auth              |
| `--resume <id>` | Resume a specific session by ID                  |
| `--continue`    | Resume the most recent session (no ID needed)    |

Session ID extraction: after exit, scan output for a line matching
a session ID pattern. Copilot prints the session ID on exit.

### File: `src/drivers/claude.ts`

Claude Code driver. Based on actual `claude --help` output:

```
claude -p <prompt-text> [--allowedTools <tools...>] [-r <id>] [-c]
```

| Flag                     | Usage                                     |
| ------------------------ | ----------------------------------------- |
| `-p <text>`              | Print mode (non-interactive, exits after) |
| `--allowedTools <tools>` | Space-separated tool allow list           |
| `-r, --resume <id>`      | Resume a specific session by ID           |
| `-c, --continue`         | Resume most recent session in current dir |

Note: Claude's `-p` is "print mode" (non-interactive), not
exactly the same as Copilot's prompt flag, but functionally
equivalent for our use case.

### File: `src/session.ts`

#### Exported types

```typescript
type LaneState =
  | "IDLE"
  | "RUNNING"
  | "BLOCKED"
  | "DONE"
  | "FAILED"
  | "KILLED"
  | "TIMED_OUT"
  | "PUSHED"
  | "ABANDONED";

interface SessionEvents {
  /** Emitted on every state transition. */
  stateChange: (lane: string, from: LaneState, to: LaneState) => void;
  /** Emitted for every output line from the pty. */
  output: (lane: string, line: string) => void;
}

interface SessionInfo {
  /** Lane name. */
  readonly name: string;
  /** Current state. */
  readonly state: LaneState;
  /** Elapsed time in milliseconds since spawn. */
  readonly elapsedMs: number;
  /** Last N output lines (ring buffer). */
  readonly recentOutput: readonly string[];
  /** Captured session ID (if agent printed one on exit). */
  readonly sessionId: string | undefined;
  /** Exit code (set after process exit). */
  readonly exitCode: number | undefined;
}
```

#### Class: `Session`

```typescript
class Session extends EventEmitter {
  constructor(
    lane: LaneConfig,
    driver: AgentDriver,
    wtPath: string,
    baseBranch: string,
  );

  /** Current session info (state, elapsed, output, etc.). */
  get info(): SessionInfo;

  /** Spawn the agent process. Transitions IDLE -> RUNNING. */
  spawn(promptText: string): void;

  /** Write input to the pty (focus mode type-through). */
  write(input: string): void;

  /** Force-kill the process. Transitions RUNNING/BLOCKED -> KILLED. */
  kill(): void;

  /**
   * Graceful shutdown: SIGTERM, wait grace period, then SIGKILL.
   * Returns a promise that resolves when the process exits.
   */
  shutdown(): Promise<void>;

  /**
   * Re-spawn with session resume (--continue/--resume <id>).
   * Transitions DONE/FAILED/KILLED/TIMED_OUT -> RUNNING.
   */
  resume(followUp?: string): void;

  /**
   * Re-spawn from scratch with a new prompt.
   * Transitions DONE/FAILED/KILLED/TIMED_OUT -> RUNNING.
   */
  retry(promptText: string): void;
}
```

#### State machine transitions

```
IDLE        -> RUNNING       (spawn)
RUNNING     -> BLOCKED       (silence timeout or analyzer signal)
RUNNING     -> DONE          (exit code 0)
RUNNING     -> FAILED        (exit code non-zero)
RUNNING     -> KILLED        (kill() called)
RUNNING     -> TIMED_OUT     (lane timeout expired)
BLOCKED     -> RUNNING       (write() resumes output tracking)
BLOCKED     -> KILLED        (kill() called)
BLOCKED     -> TIMED_OUT     (lane timeout expired while blocked)
DONE        -> RUNNING       (resume or retry)
FAILED      -> RUNNING       (resume or retry)
KILLED      -> RUNNING       (resume or retry)
TIMED_OUT   -> RUNNING       (resume or retry)
DONE        -> PUSHED        (push action)
DONE        -> ABANDONED     (cleanup action)
FAILED      -> ABANDONED     (cleanup action)
KILLED      -> ABANDONED     (cleanup action)
TIMED_OUT   -> ABANDONED     (cleanup action)
```

PUSHED and ABANDONED are terminal (no further transitions).

#### Internal behavior

**Output buffering:** pty `onData` events are split on `\n` into
lines. Partial lines are buffered until the next newline. Each
complete line is stored in a ring buffer (last 100 lines) and
emitted via the `output` event.

**Silence timer:** if `lane.timeout` is set, a timer starts on
spawn. Every output line resets the timer. If the timer fires,
the process is killed (SIGTERM + grace) and the state transitions
to `TIMED_OUT`.

**BLOCKED detection:** deferred to Chunk D. For now, BLOCKED is
only reachable via silence timer (if no output for the configured
timeout). The output analyzer (Chunk D) will add a second path
from RUNNING to BLOCKED based on output pattern matching.

**Elapsed time:** tracked via `performance.now()` delta from
spawn time. Resets on resume/retry.

**Session ID capture:** on process exit, the session manager calls
`driver.extractSessionId(recentOutput)` to capture the session ID
for later resume.

### Modifications to existing files

#### `package.json`

Add `node-pty` ^1.0.0 to dependencies:

```json
"dependencies": {
    "node-pty": "^1.0.0",
    "yaml": "^2.8.3"
}
```

#### `src/index.ts`

Add re-exports:

```typescript
export type { SpawnSpec, AgentDriver } from "./driver.js";
export { getDriver } from "./driver.js";
export type { LaneState, SessionEvents, SessionInfo } from "./session.js";
export { Session } from "./session.js";
export type {
  OrchestratorSession,
  PersistedLaneState,
} from "./orchestratorSession.js";
export {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  sessionDir,
} from "./orchestratorSession.js";
```

### File: `src/orchestratorSession.ts`

Orchestrator-level session persistence. Each run gets a unique
session ID, and all state (worktrees, lane statuses, agent session
IDs) is persisted under that session's directory.

#### Session directory layout

```
~/.agent-orchestrator/<repo-path>/<session-id>/
    session.json       # persisted session state
    <lane-name>/       # git worktree for this lane
    <lane-name>/
    ...
```

The `<session-id>` is a timestamp-based ID: `YYYYMMDD-HHmmss`
(e.g. `20260428-143052`). Short, sortable, human-readable.
Collisions within the same second are resolved by appending `-N`.

#### Exported types

```typescript
/** Persisted state for a single lane. */
export interface PersistedLaneState {
  name: string;
  state: LaneState;
  exitCode?: number;
  agentSessionId?: string; // agent's session ID for resume
  elapsedMs: number;
  commitCount: number;
}

/** Persisted orchestrator session. */
export interface OrchestratorSession {
  /** Session ID (timestamp-based). */
  id: string;
  /** Absolute path to the original YAML config file. */
  configPath: string;
  /** Absolute path to the repository root. */
  repo: string;
  /** ISO timestamp of session start. */
  startedAt: string;
  /** Per-lane state snapshots. */
  lanes: PersistedLaneState[];
}
```

#### Exported functions

| Function        | Signature                                                                        | Description                                                            |
| --------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `sessionDir`    | `(repoRoot: string, sessionId: string, baseDir?: string) => string`              | Compute the session directory path                                     |
| `createSession` | `(configPath: string, config: OrchestratorConfig) => OrchestratorSession`        | Generate a new session with IDLE lanes and timestamp ID                |
| `saveSession`   | `(session: OrchestratorSession, baseDir?: string) => void`                       | Write `session.json` to the session directory (creates dirs if needed) |
| `loadSession`   | `(repoRoot: string, sessionId: string, baseDir?: string) => OrchestratorSession` | Read and parse `session.json`                                          |
| `listSessions`  | `(repoRoot: string, baseDir?: string) => string[]`                               | List session IDs for a repo (sorted newest first)                      |

#### Interaction with worktree paths

The existing `worktreePath()` function in `worktree.ts` gains a
`sessionId` parameter:

```typescript
function worktreePath(
  repoRoot: string,
  laneName: string,
  sessionId: string,
  baseDir?: string,
): string;
```

New path: `~/.agent-orchestrator/<repo-path>/<session-id>/<lane-name>/`

This is a breaking change to `worktreePath`, `setupAll`, and
`teardownAll` which all gain a `sessionId` parameter. The
worktree.spec.ts tests are updated accordingly.

#### Save triggers

- On session start (after worktrees created, before agents spawn)
- On every lane state transition (RUNNING -> DONE, etc.)
- On shutdown (final state snapshot with KILLED for interrupted lanes)

Writes are synchronous (`writeFileSync`) to avoid data loss on crash.
The file is small (< 1KB for 5 lanes) so sync I/O is fine.

## Test plan

### Test file

```
tools/agentOrchestrator/test/driver.spec.ts
tools/agentOrchestrator/test/session.spec.ts
tools/agentOrchestrator/test/orchestratorSession.spec.ts
```

### Strategy: drivers

Driver tests are pure unit tests (no I/O). They verify that
`buildCommand`, `buildResumeCommand`, and `extractSessionId`
produce correct output for various inputs.

### Driver test cases

| #   | Test name                                             | Verifies                                                 |
| --- | ----------------------------------------------------- | -------------------------------------------------------- |
| 1   | copilot buildCommand includes -p and prompt text      | args contain `-p` followed by prompt text                |
| 2   | copilot buildCommand includes --allow-tool flags      | Each allowTool generates a separate `--allow-tool` arg   |
| 3   | copilot buildCommand omits --allow-tool when empty    | No --allow-tool args when allowTools is undefined        |
| 4   | copilot buildResumeCommand with session ID            | args contain `--resume <id>`                             |
| 5   | copilot buildResumeCommand without ID uses --continue | args contain `--continue`                                |
| 6   | copilot extractSessionId finds ID in output           | Returns the session ID string                            |
| 7   | copilot extractSessionId returns undefined on miss    | Returns undefined when no ID pattern found               |
| 8   | claude buildCommand includes -p and prompt text       | args contain `-p` followed by prompt text                |
| 9   | claude buildCommand includes --allowedTools           | args contain `--allowedTools` with space-separated tools |
| 10  | claude buildResumeCommand with session ID             | args contain `--resume <id>`                             |
| 11  | claude buildResumeCommand without ID uses -c          | args contain `--continue`                                |
| 12  | getDriver returns copilot driver                      | `getDriver("copilot").name === "copilot"`                |
| 13  | getDriver throws on unknown name                      | Throws with "unknown" in message                         |

### Strategy: session manager

Session tests spawn a **mock agent** (a simple shell script that
prints lines and exits) instead of a real copilot/claude binary.
This avoids needing API keys and keeps tests fast and deterministic.

The mock agent script:

```bash
#!/bin/bash
# mock-agent.sh: prints lines, optionally waits, exits with code
echo "Starting mock agent"
echo "Working on task..."
echo "Session ID: mock-session-123"
exit ${1:-0}
```

A mock `AgentDriver` returns a `SpawnSpec` pointing to this script.

### Session test cases

| #   | Test name                              | Verifies                                                      |
| --- | -------------------------------------- | ------------------------------------------------------------- |
| 1   | starts in IDLE state                   | `session.info.state === "IDLE"`                               |
| 2   | spawn transitions to RUNNING           | State changes to RUNNING after spawn()                        |
| 3   | emits output events for each line      | Collect output events, verify they match mock script output   |
| 4   | transitions to DONE on exit code 0     | State is DONE after mock exits cleanly                        |
| 5   | transitions to FAILED on non-zero exit | Mock exits with code 1, state is FAILED                       |
| 6   | kill transitions to KILLED             | Call kill() while RUNNING, state becomes KILLED               |
| 7   | captures session ID from output        | `session.info.sessionId` matches the mock's printed ID        |
| 8   | resume re-spawns with RUNNING state    | After DONE, call resume(), state goes back to RUNNING         |
| 9   | retry re-spawns with RUNNING state     | After FAILED, call retry(), state goes back to RUNNING        |
| 10  | write sends input to pty               | Mock reads stdin line, echoes it; verify in output events     |
| 11  | shutdown sends SIGTERM then resolves   | Call shutdown(), process exits, promise resolves              |
| 12  | elapsed time increases while running   | `session.info.elapsedMs` > 0 after a brief run                |
| 13  | recentOutput is capped at buffer size  | Spawn a verbose mock, verify ring buffer doesn't exceed limit |

### Mock/stub strategy

- **Drivers**: no mocks needed (pure functions).
- **Session**: mock agent shell script + mock driver that points to
  it. No mocking of node-pty itself (tests use real ptys with the
  mock script).
- **Orchestrator session**: pure filesystem tests in tmp dirs. No
  mocks needed.
- **Timeout tests**: deferred. Testing real timeouts is slow and
  flaky. The timeout logic is straightforward (setTimeout + reset)
  and will be validated in the real-life smoke test after C.6.

### Strategy: orchestrator session persistence

Orchestrator session tests are filesystem-based. Each test uses a
temp directory as `baseDir`, creates/saves/loads sessions, and
verifies the JSON content and directory structure.

### Orchestrator session test cases

| #   | Test name                                      | Verifies                                                         |
| --- | ---------------------------------------------- | ---------------------------------------------------------------- |
| 1   | sessionDir includes repo path and session ID   | Path is `<base>/<repo>/<session-id>`                             |
| 2   | createSession generates timestamp-based ID     | ID matches `YYYYMMDD-HHmmss` pattern                             |
| 3   | createSession initializes all lanes as IDLE    | Every lane has `state: "IDLE"`, `elapsedMs: 0`, `commitCount: 0` |
| 4   | saveSession creates directory and session.json | File exists, is valid JSON                                       |
| 5   | loadSession round-trips through save           | `loadSession(save(session))` equals original                     |
| 6   | loadSession throws for missing session         | Error when session ID doesn't exist                              |
| 7   | listSessions returns IDs sorted newest first   | Create 3 sessions, verify order                                  |
| 8   | listSessions returns empty array for new repo  | No sessions directory exists yet                                 |
| 9   | saveSession overwrites existing session.json   | Save twice with updated lane state, load returns latest          |

## Build verification

```bash
cd /home/curtism/src/TypeAgent3/ts
pnpm i                          # install node-pty
cd tools/agentOrchestrator
npx tsc -b && pnpm run test
```

Expected: all tests pass (config + worktree + driver + session +
orchestrator session).

## Commit plan

### Commit 1: C.5 - agent driver interface

**Message:** `C.5: agent driver interface with copilot and claude drivers`

**Files created:**

- `tools/agentOrchestrator/src/driver.ts`
- `tools/agentOrchestrator/src/drivers/copilot.ts`
- `tools/agentOrchestrator/src/drivers/claude.ts`
- `tools/agentOrchestrator/test/driver.spec.ts`

**Files modified:**

- `tools/agentOrchestrator/src/index.ts` (add driver re-exports)

**Verification:** `npx tsc -b && pnpm run test` passes.

### Commit 2: C.6 - session manager

**Message:** `C.6: session manager with node-pty and state machine`

**Files created:**

- `tools/agentOrchestrator/src/session.ts`
- `tools/agentOrchestrator/test/session.spec.ts`
- `tools/agentOrchestrator/test/fixtures/mock-agent.sh`

**Files modified:**

- `tools/agentOrchestrator/package.json` (add node-pty dependency)
- `tools/agentOrchestrator/src/index.ts` (add session re-exports)

**Verification:** `pnpm i && npx tsc -b && pnpm run test` passes.

### Commit 3: C.7 - orchestrator session persistence

**Message:** `C.7: orchestrator session persistence with save/load/list`

**Files created:**

- `tools/agentOrchestrator/src/orchestratorSession.ts`
- `tools/agentOrchestrator/test/orchestratorSession.spec.ts`

**Files modified:**

- `tools/agentOrchestrator/src/worktree.ts` (add sessionId param)
- `tools/agentOrchestrator/test/worktree.spec.ts` (update for sessionId)
- `tools/agentOrchestrator/src/index.ts` (add session re-exports)

**Verification:** `npx tsc -b && pnpm run test` passes.
