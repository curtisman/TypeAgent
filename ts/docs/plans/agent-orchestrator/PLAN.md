# Agent Orchestrator - Plan

Status: Draft.

## Motivation

The grammar-tools effort (and future multi-track work in this repo)
benefits from running multiple AI coding-agent sessions in parallel:
one per independent lane of work. Today there is no tooling for
spawning, monitoring, and intervening in multiple agentic CLI sessions
from a single dashboard. Existing tools (Claude Squad, mprocs) are
either agent-specific or non-embeddable.

This tool closes that gap. It is designed to be **agent-agnostic**
(Copilot CLI, Claude Code, or any future agentic CLI), **local-first**
(runs on the developer's machine, no cloud dependency), and **small**
(target: under 1,000 lines of TypeScript for v1).

## Goals

- Spawn N agent sessions in parallel, each in its own git worktree
  and pty.
- Show a live TUI dashboard with per-lane status, recent output, and
  git progress.
- Detect when a lane is blocked (waiting for user input, stuck, errored)
  and alert the operator.
- Allow the operator to focus a lane, type into its pty, then return
  to the dashboard.
- Support declarative lane configs (YAML) so a work plan can be
  version-controlled alongside the plan docs.
- Notify on state transitions (done, failed, blocked) via pluggable
  channels (desktop, ntfy.sh, custom webhook).

## Non-goals (v1)

- Cloud-hosted agent dispatch (use GitHub's coding agent for that).
- Automatic retry or self-healing of failed lanes.
- Multi-repo support (one repo root per orchestrator run).
- Agent-specific protocol integration (we treat every agent as a
  black-box CLI process in a pty).

## Location and naming

> Directory: `tools/agentOrchestrator`. Package name:
> `agent-orchestrator`.

Lives under `tools/` because it is developer infrastructure, not an
example exercising TypeAgent APIs. Requires adding a `tools/*` glob
to `pnpm-workspace.yaml` (currently only the flat `tools` entry
exists for `tools-scripts`). The existing `tools-scripts` package
is unaffected because `tools/*` matches sub-directories only, not
the root `tools/package.json`.

```yaml
# pnpm-workspace.yaml addition
packages:
  # ... existing entries ...
  - tools
  - tools/* # new: sub-packages under tools/
```

## Operator interaction model

The orchestrator has two phases with different operator roles:

**Execution phase.** The orchestrator observes. Agents write code,
commit, fix errors, and run tests. The operator's only actions are:

- **Glance** at the dashboard (commit count is the best progress
  signal - it means the agent completed a unit of work).
- **Intervene** when a lane is BLOCKED (focus the lane, type into
  the pty to answer an approval prompt or clarify, then return to
  overview).
- **Kill** a lane that is stuck or thrashing.

The orchestrator never auto-commits (agents already commit as part
of their workflow) and never auto-pushes (pushing is irreversible
and needs review).

**Post-completion phase.** Once a lane exits (DONE or FAILED), the
operator drives the next steps:

- **Review** the diff (`git log --oneline <base>..HEAD` + optional
  `git diff <base>..HEAD` in a pager).
- **Resume** the lane to iterate on the work. If the agent driver
  supports session resume (both Copilot CLI and Claude Code do),
  the agent is re-spawned with `--continue` or `--resume <id>` so
  it has full conversation context. The operator can provide
  follow-up instructions via the prompt.
- **Push** the lane's branch when satisfied.
- **Retry** a failed lane from scratch with the same or modified prompt.
- **Cleanup** worktrees for lanes that are pushed or abandoned.

The dashboard offers these as keybindings on completed lanes:
`[d]iff`, `[r]esume`, `[p]ush`, `[R]etry`, `[c]leanup`.

### Lifecycle summary

| Phase    | What the agent does                | What the orchestrator does               | What the operator does              |
| -------- | ---------------------------------- | ---------------------------------------- | ----------------------------------- |
| Start    | -                                  | Create worktrees, spawn agents           | Launch, watch                       |
| Running  | Write code, commit, test, self-fix | Observe, classify output, track commits  | Glance at dashboard                 |
| Blocked  | Wait for approval                  | Detect silence / approval prompt, notify | Focus lane, type answer             |
| Error    | Try to self-fix                    | Surface error signal                     | Watch, optionally intervene         |
| Done     | Exit 0                             | Show summary, offer post-actions         | Review diff, resume/push/cleanup    |
| Resume   | Continues with context             | Re-spawn with session resume             | Provide follow-up instructions      |
| Failed   | Exit non-zero                      | Show summary, offer retry/resume         | Review output, resume/retry/abandon |
| All done | -                                  | Show aggregate summary                   | Push branches, cleanup, quit        |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  TUI (Ink 7)                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐         │
│  │ Lane L1  │ │ Lane L2  │ │ Lane L3  │ ...     │
│  │ status   │ │ status   │ │ status   │         │
│  │ last log │ │ last log │ │ last log │         │
│  └──────────┘ └──────────┘ └──────────┘         │
│  [f]ocus  [k]ill  [p]ause  [r]esume  [q]uit    │
└──────────────┬──────────────────────────────────┘
               │ React state updates
┌──────────────▼──────────────────────────────────┐
│  Orchestrator                                    │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ Worktree   │  │ Session    │  │ Notifier  │  │
│  │ Manager    │  │ Manager    │  │           │  │
│  └────────────┘  └─────┬──────┘  └───────────┘  │
│                        │                         │
│              ┌─────────▼─────────┐               │
│              │  Output Analyzer  │               │
│              └─────────┬─────────┘               │
│                        │                         │
│              ┌─────────▼─────────┐               │
│              │  Agent Driver     │               │
│              │  (node-pty)       │               │
│              └───────────────────┘               │
└──────────────────────────────────────────────────┘
```

## Components

### 1. Lane config (input format)

Declarative YAML. One file per orchestrator run, containing all lanes.

```yaml
# lanes.yaml
repo: /home/user/src/TypeAgent3/ts
base: grammartool # branch to create worktrees from
notify:
  channel: ntfy # desktop | ntfy | webhook | none
  topic: agent-orchestrator # ntfy topic or webhook URL
  on: [blocked, failed, done]

lanes:
  - name: L2-core-scaffold
    branch: grammartool-L2-core
    agent: copilot # driver name
    prompt-file: ./prompts/L2-core.md # relative to this YAML
    timeout: 30m
    allow-tools: # passed to agent CLI
      - "shell(pnpm *)"
      - read
      - write

  - name: L4-cli-scaffold
    branch: grammartool-L4-cli
    agent: copilot
    prompt-file: ./prompts/L4-cli.md
    timeout: 20m
    env:
      OPENAI_API_KEY: $OPENAI_API_KEY_SECONDARY # per-lane override

  - name: L5-vscode-layout
    branch: grammartool-L5-vscode
    agent: copilot
    prompt-file: ./prompts/L5-vscode.md
    timeout: 25m
```

### 2. Agent driver (`src/drivers/`)

Abstract interface so we can support multiple agentic CLIs without
changing the orchestrator core.

```typescript
interface AgentDriver {
  /** Human-readable driver name. */
  readonly name: string;

  /** Build the spawn command + args for this agent. */
  buildCommand(config: LaneConfig): SpawnSpec;

  /**
   * Build a resume command that restores the agent's session
   * context. Returns null if the driver does not support resume.
   * @param sessionId - Captured from the agent's exit output.
   * @param followUp - Optional follow-up instructions from the operator.
   */
  buildResumeCommand(
    config: LaneConfig,
    sessionId?: string,
    followUp?: string,
  ): SpawnSpec | null;

  /** Whether this driver supports session resume. */
  readonly supportsSessionResume: boolean;

  /** Whether this driver supports the --allow-tool style pre-auth. */
  readonly supportsToolAllowList: boolean;
}

interface SpawnSpec {
  file: string; // e.g. "copilot" or "claude"
  args: string[]; // e.g. ["-p", promptText, "--allow-tool", ...]
  env?: Record<string, string>;
}
```

Resume commands per driver:

| Driver    | Resume command                                     | Session ID source       |
| --------- | -------------------------------------------------- | ----------------------- |
| `copilot` | `copilot --resume <id>` (or `--continue` if no ID) | Printed at session exit |
| `claude`  | `claude --resume <id>` (or `--continue` if no ID)  | Printed at session exit |

v1 ships two drivers:

- **`copilot`**: wraps `copilot -p <prompt> [--allow-tool ...]`.
- **`claude`**: wraps `claude -p <prompt> [--allowedTools ...]`.

Adding a new agent = one file implementing `AgentDriver`.

### 3. Session manager (`src/session.ts`)

Owns the lifecycle of one lane. Wraps `node-pty` (following the
`coderWrapper` pattern already in the repo). Maintains a state machine:

```
         spawn()
  IDLE ──────────► RUNNING
                     │
          ┌──────────┤
          │          │
     onAnalyzer  onExit
     "blocked"   signal
          │          │
          ▼          ▼
       BLOCKED    DONE / FAILED
          │          │
     user sends      │  user actions:
     input / resume  │  [d]iff, [r]esume, [p]ush,
          │          │  [R]etry, [c]leanup
          ▼          │
       RUNNING ◄─────┤ resume (--continue/--resume <id>)
                     │ retry  (fresh spawn)
                     ▼
                  PUSHED / ABANDONED
```

Terminal states: `PUSHED`, `ABANDONED`. A lane in `DONE` or `FAILED`
can transition to:

- `RUNNING` via **resume** (re-spawn with session context using
  `--continue` or `--resume <sessionId>`), or **retry** (fresh
  spawn, no session context).
- `PUSHED` (operator reviewed and pushed the branch).
- `ABANDONED` (operator decided to discard).

Key responsibilities:

- Spawn the agent process in a pty via `node-pty`.
- Buffer output lines and feed each to the output analyzer.
- Track elapsed time; emit `BLOCKED` if no output for
  `silenceTimeout` (configurable, default 5 min).
- Emit `DONE` (exit code 0) or `FAILED` (non-zero) on process exit.
- Expose `write(input)` for operator intervention (focus mode).
- Expose `kill()` for force-termination.
- Expose `diff(base)` for post-completion review (`git log` + `git diff`).
- Expose `push(remote, branch)` for post-completion push.
- Expose `resume(followUp?)` for re-spawning with session context
  (uses driver's `buildResumeCommand` with the captured session ID).
- Expose `retry(prompt?)` for re-spawning from scratch (no session
  context, fresh prompt).
- Capture the agent's session ID from exit output (regex per driver)
  to enable precise `--resume <id>` on later resume.
- Track git progress: periodically run
  `git log --oneline <base>..HEAD` in the worktree to count commits.

### 4. Output analyzer (`src/analyzer.ts`)

Regex-based pattern matcher that classifies output lines into signals.
The orchestrator uses these signals to drive state transitions and
surface status in the dashboard.

```typescript
type Signal =
  | { kind: "progress"; summary: string }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "milestone"; description: string }
  | { kind: "idle" };
```

v1 patterns (tuned iteratively):

| Pattern                                     | Signal    | Example                        |
| ------------------------------------------- | --------- | ------------------------------ |
| `permission\|approve\|confirm\|do you want` | blocked   | Agent asking for tool approval |
| `error\|Error\|FAIL\|panic\|Traceback`      | error     | Tool failure or crash          |
| `created?\s+file\|wrote\|editing\|modified` | progress  | File operations                |
| `running\|executing\|pnpm\|npm\|node`       | progress  | Command execution              |
| `tests?\s+pass\|build succeeded\|✓ all`     | milestone | Verification gate              |
| _(silence > N min)_                         | idle      | Agent stuck or waiting         |

The analyzer is intentionally simple. Regex covers ~90% of cases for
known agent CLIs. A future v2 could feed the last N lines to a cheap
LLM for richer classification, but that is out of scope for v1.

### 5. Worktree manager (`src/worktree.ts`)

Thin wrapper around `git worktree` commands. Manages the lifecycle of
per-lane worktrees.

- `worktreePath(repoRoot, laneName, baseDir?)`: compute the worktree
  directory path (pure function, no I/O).
- `createWorktree(repoRoot, baseBranch, newBranch, wtPath)`:
  `git worktree add <wtPath> -b <newBranch> <baseBranch>`.
- `removeWorktree(repoRoot, wtPath, deleteBranch?)`:
  `git worktree remove <wtPath> --force`, optionally
  `git branch -D <branch>`.
- `listWorktrees(repoRoot)`: `git worktree list --porcelain`.
- `commitCount(wtPath, baseBranch)`: `git log --oneline <base>..HEAD`
  in the worktree.
- `setupAll(config)`: sequential `createWorktree` per lane with
  rollback on failure.
- `teardownAll(config)`: sequential `removeWorktree` per lane,
  best-effort (continues past errors).

Worktrees are created under a central dotdir:
`~/.agent-orchestrator/<absolute-repo-path>/<session-id>/<lane-name>/`.
Each orchestrator run gets a unique session ID (timestamp-based:
`YYYYMMDD-HHmmss`). Session state is persisted at
`~/.agent-orchestrator/<absolute-repo-path>/<session-id>/session.json`.
The full absolute repo path (leading `/` stripped) is used as the
directory structure so worktrees trivially map back to their source
repo. The base directory (`~/.agent-orchestrator`) is configurable
via `--worktree-dir`.

Uses `child_process.execFile` (not `node-pty` - these are non-interactive
git commands).

### 6. TUI dashboard (`src/ui/`)

Ink 7 (React for terminals). The dashboard has two modes:

**Overview mode** (default): all lanes visible as a grid of status cards.

```
┌─ Agent Orchestrator ──────────────────────────────────┐
│                                                        │
│  L2-core-scaffold     L4-cli-scaffold   L5-vscode      │
│  ● RUNNING  3m42s     ● RUNNING  2m18s  ◉ BLOCKED 1m  │
│  2 commits            0 commits         0 commits      │
│  > pnpm build...      > creating src/   > waiting for  │
│                                           approval     │
│                                                        │
│  [f]ocus  [k]ill  [p]ause  [r]esume  [q]uit           │
└────────────────────────────────────────────────────────┘
```

**Post-completion mode**: completed lanes show post-actions.

```
┌─ Agent Orchestrator ── 2/3 done ──────────────────────┐
│                                                        │
│  L2-core-scaffold     L4-cli-scaffold   L5-vscode      │
│  ✓ DONE     18m32s    ● RUNNING  15m    ✓ DONE  16m45s │
│  9 commits            5 commits         8 commits      │
│  exit 0               > testing...      exit 0         │
│                                                        │
│  [d]iff  [r]esume  [p]ush  [R]etry  [c]leanup  [q]uit  │
└────────────────────────────────────────────────────────┘
```

**All-done summary**:

```
┌─ Agent Orchestrator ── ALL DONE ──────────────────────┐
│                                                        │
│  L2-core-scaffold     L4-cli-scaffold   L5-vscode      │
│  ✓ DONE     18m32s    ✓ DONE     20m15s ✓ DONE  16m45s │
│  9 commits            6 commits         8 commits      │
│                                                        │
│  Summary: 3/3 succeeded, 23 total commits              │
│  Worktrees: ~/.agent-orchestrator/.../L{2,4,5}-*       │
│                                                        │
│  [d]iff  [r]esume  [p]ush  [c]leanup  [q]uit           │
└────────────────────────────────────────────────────────┘
```

**Focus mode** (press `f` + lane number): full-screen pty output for
one lane, with type-through to the pty. Press `Esc` to return to
overview.

Components:

- `<Dashboard>` - top-level, holds lane state array, routes keyboard.
- `<LaneCard>` - one per lane: status indicator, elapsed time, commit
  count, last output line.
- `<FocusView>` - full-screen pty replay + live type-through.
- `<StatusBar>` - global key bindings, notification status.

### 7. Notifier (`src/notifier.ts`)

Pluggable notification on state transitions. v1 channels:

| Channel   | Implementation                                         |
| --------- | ------------------------------------------------------ |
| `desktop` | `node-notifier` (cross-platform desktop notifications) |
| `ntfy`    | HTTP POST to `ntfy.sh/<topic>` (or self-hosted)        |
| `webhook` | HTTP POST with JSON body to a configurable URL         |
| `none`    | No-op (default for testing)                            |

Notification payload:

```typescript
interface Notification {
  lane: string;
  event: "blocked" | "failed" | "done" | "error";
  message: string;
  elapsed: string;
  commits: number;
}
```

## Dependencies

| Package                 | Purpose               | Status in repo                   |
| ----------------------- | --------------------- | -------------------------------- |
| `node-pty` ^1.0.0       | Pty spawn             | Already used by `coderWrapper`   |
| `ink` ^7.0.0            | TUI rendering         | New                              |
| `react` ^18.0.0         | Peer dep for Ink      | New                              |
| `yaml` ^2.8.3           | Lane config parsing   | Already used by `agents/browser` |
| `node-notifier` ^10.0.0 | Desktop notifications | New; optional                    |

## Phases

### Phase 1: core orchestrator (MVP)

Ship a working `agent-orchestrator` that can run N lanes in parallel
with a text-mode dashboard (no Ink). Output to stdout with ANSI
status lines, refreshed on a timer. Focus mode via numbered input.

Rationale for text-mode first: Ink adds React as a dependency and
has a learning curve. A simple `setInterval` + inline ANSI
cursor-control dashboard is faster to ship and validates the core
abstractions before investing in the TUI. ANSI escape codes and
elapsed time tracking are inlined (~50 lines total) to avoid
depending on workspace packages under `packages/`, since the
orchestrator may be extracted to a separate repo.

#### Chunk A: scaffold and config — PR 1 start

Set up the package and load lane definitions. No runtime behavior
yet; the output is a validated config object and a buildable package.

| Item | Description                                                                                 | Commit |
| ---- | ------------------------------------------------------------------------------------------- | ------ |
| A.1  | **Decision:** align `node-pty` version with `coderWrapper` to avoid duplicate native builds |        |
| A.2  | **Decision:** resolve `simple-git` vs `execFile` for git worktree commands                  |        |
| A.3  | Package scaffold (`tools/agentOrchestrator/`)                                               | ✓      |
| A.4  | Lane config loader (YAML)                                                                   | ✓      |

#### Chunk B: worktree manager — PR 1 end

Create, list, and remove git worktrees. Depends on Chunk A for the
config (branch names, repo root).

| Item | Description                                                                                                                             | Commit |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| B.1  | **Decision:** define worktree setup failure modes (branch exists, dirty tree, agent not in PATH) and fail-fast vs `--continue-on-error` |        |
| B.2  | **Decision:** serialize worktree mutations to avoid git lock conflicts during concurrent cleanup + retry                                |        |
| B.3  | Worktree manager                                                                                                                        | ✓      |

#### Chunk C: session manager and agent driver — PR 2 start

Spawn agent processes in ptys, manage the lane state machine, handle
timeouts and shutdown. Depends on Chunk B for worktree paths.

| Item | Description                                                                                        | Commit |
| ---- | -------------------------------------------------------------------------------------------------- | ------ |
| C.1  | **Decision:** add KILLED and TIMED_OUT terminal states to the state machine (distinct from FAILED) |        |
| C.2  | **Decision:** define timeout behavior (kill? notify? which state?)                                 |        |
| C.3  | **Decision:** define pause/resume semantics (SIGSTOP/SIGCONT?) or remove from Phase 1 UI mockup    |        |
| C.4  | **Decision:** define SIGINT/SIGTERM teardown sequence for graceful shutdown                        |        |
| C.5  | Agent driver interface + `copilot` driver                                                          | ✓      |
| C.6  | Session manager (node-pty + state machine)                                                         | ✓      |
| C.7  | Orchestrator session persistence (save/load/list session state)                                    | ✓      |

> **🧪 Real-life test point 1:** After C.6, you can smoke-test a
> single real agent (e.g. `copilot`) spawned in a real worktree.
> No dashboard yet, just raw pty output to verify the agent receives
> the prompt, runs, and exits with the correct state transition.

#### Chunk D: output analyzer — PR 2 end

Classify pty output lines into signals (progress, blocked, error,
milestone). Depends on Chunk C for the session output stream.

| Item | Description                                                                                                     | Commit |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------ |
| D.1  | **Decision:** refine BLOCKED detection heuristic (silence alone vs silence + approval pattern in recent output) |        |
| D.2  | Output analyzer (regex v1)                                                                                      | ✓      |

#### Chunk E: text-mode dashboard — PR 3 start

Render lane status to the terminal. Depends on Chunks C and D for
session state and analyzer signals.

| Item | Description                                                                                                             | Commit |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| E.1  | **Decision:** define lane selection UX for text-mode focus (number key, arrow keys, etc.)                               |        |
| E.2  | **Decision:** define focus-mode escape sequence for text-mode (how to distinguish pty input from orchestrator commands) |        |
| E.3  | Text-mode dashboard (ANSI status lines, no Ink)                                                                         | ✓      |

> **🧪 Real-life test point 2:** After E.3, you can run multiple
> real agents in parallel and watch them via the text dashboard.
> Focus a lane, observe status transitions, kill stuck lanes. No
> post-completion actions yet (diff/push/cleanup come in Chunk F).

#### Chunk F: post-completion, notifications, and e2e test — PR 3 end

Wire up the remaining runtime features and validate everything
end-to-end. Depends on Chunks B-E.

| Item | Description                                            | Commit |
| ---- | ------------------------------------------------------ | ------ |
| F.1  | Post-completion actions (diff, push, cleanup)          | ✓      |
| F.2  | Notifier (ntfy channel only)                           | ✓      |
| F.3  | End-to-end test: 3 lanes with mock agent (echo script) | ✓      |

> **🧪 Real-life test point 3 (full MVP):** After F.3, the
> orchestrator is feature-complete for Phase 1. Run 3+ real agent
> lanes, monitor via the dashboard, review diffs, push branches,
> and clean up worktrees. This is the manual acceptance test
> described in the Verification section.

#### Phase 1 chunk dependency graph

```
A (scaffold/config)
└─► B (worktree)
    └─► C (session/driver)
        ├─► D (analyzer)
        │   └─► E (dashboard) ◄─── C
        └─► F (post-completion, notifier, e2e) ◄─── D, E
```

### Phase 2: Ink TUI

Replace the text-mode dashboard with Ink. Adds focus mode (full pty
replay + type-through), better layout, and keyboard shortcuts.

#### Chunk G: Ink dashboard — PR 4 start

| Item | Description                                                                                  | Commit |
| ---- | -------------------------------------------------------------------------------------------- | ------ |
| G.1  | Add `ink` + `react` dependencies                                                             |        |
| G.2  | `<Dashboard>` + `<LaneCard>` components                                                      | ✓      |
| G.3  | `<FocusView>` with pty replay and type-through                                               | ✓      |
| G.4  | `<StatusBar>` with key bindings                                                              | ✓      |
| G.5  | **Decision:** require push confirmation (show branch + remote, y/n) or allow single-key push |        |

#### Chunk H: desktop notifications — PR 4 end

| Item | Description                  | Commit |
| ---- | ---------------------------- | ------ |
| H.1  | Desktop notification channel | ✓      |

### Phase 3: polish

#### Chunk I: additional drivers and notification channels — PR 5

| Item | Description                  | Commit |
| ---- | ---------------------------- | ------ |
| I.1  | `claude` agent driver        | ✓      |
| I.2  | Webhook notification channel | ✓      |

#### Chunk J: advanced lane management — PR 6

| Item | Description                                                | Commit |
| ---- | ---------------------------------------------------------- | ------ |
| J.1  | Lane dependency ordering (start L4 only after L2 finishes) | ✓      |
| J.2  | Auto-cleanup of worktrees on exit                          | ✓      |
| J.3  | Retry failed lane with modified prompt                     | ✓      |

#### Chunk K: config and analyzer hardening — PR 7

| Item | Description                                                                                                        | Commit |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| K.1  | Config validation with clear error messages                                                                        | ✓      |
| K.2  | **Decision:** tighten output analyzer patterns to reduce false positives (anchor regexes, require word boundaries) |        |
| K.3  | **Decision:** support inline `prompt:` key in lane config (alternative to `prompt-file:` for short prompts)        |        |

## Execution model

This plan is executed by a **human operator** and one or more
**coding agents** (Copilot, Claude Code, etc.). The table below
defines who does what for each type of work.

### Roles

| Role         | Who                          | Tools                        |
| ------------ | ---------------------------- | ---------------------------- |
| **Operator** | Human developer              | Editor, terminal, git, PR UI |
| **Agent**    | Coding agent (Copilot, etc.) | Editor, terminal (via agent) |

### Per-item responsibilities

| Work type               | Operator                                          | Agent                                                  |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| **Decision items**      | Makes the decision, records it in the plan        | Can research options and draft a recommendation        |
| **Package scaffold**    | Reviews and merges                                | Generates package.json, tsconfig, directory structure  |
| **Implementation code** | Reviews diff, runs manual smoke tests             | Writes src/ and test/ files, iterates until tests pass |
| **Unit tests**          | Reviews coverage, spot-checks edge cases          | Writes tests, runs them, fixes failures                |
| **E2e / integration**   | Runs real-life test points, reports issues        | Writes mock-agent fixtures and test harness            |
| **PR creation**         | Creates PR, writes description, requests review   | Can draft PR description from commit log               |
| **PR review feedback**  | Addresses reviewer comments or delegates to agent | Applies mechanical fixes (formatting, renames, etc.)   |

### Chunk-by-chunk execution flow

Each chunk follows this sequence:

#### Phase 1: Sub-plan development (operator + agent collaborate)

Before any code is written, the operator and agent develop a
**sub-plan** for the chunk. The sub-plan is a detailed design
document that eliminates ambiguity so the agent can implement
without guessing.

1. **Operator** resolves any Decision items in the chunk (or
   delegates research to the agent and then decides). Each
   decision is recorded in the sub-plan with rationale.
2. **Operator + Agent** develop the sub-plan together:
   - Agent reads the chunk section, referenced code patterns,
     and related source files in the repo.
   - Agent drafts the sub-plan; operator reviews and refines.
   - Iterate until the operator is satisfied that the design
     is complete enough for autonomous implementation.
3. **Operator** approves the sub-plan. This is the gate before
   any code is written.

#### Sub-plan contents

The sub-plan for each chunk must include:

- **Scope**: which items from the chunk table are covered, and
  what is explicitly out of scope.
- **Resolved decisions**: each Decision item with the chosen
  option and rationale. These are binding for implementation.
- **Detailed design**: for each code item:
  - File paths to create or modify.
  - Exported types and interfaces (exact TypeScript signatures).
  - Function signatures with parameter and return types.
  - Key implementation logic (algorithm, state transitions,
    control flow) described precisely enough that the agent
    does not need to make design choices during coding.
    **Do not include full function implementations** unless
    the code serves to explain a design concept. Describe
    behavior, validation rules, and error cases in prose or
    tables. The agent writes the implementation from the
    contract.
  - Error handling strategy (what errors are possible, how
    each is handled).
  - Dependencies on other modules (imports, which functions
    are called).
- **Test plan**: for each code item:
  - Test file path.
  - Test case names and what each verifies.
  - Mock/stub strategy (what is mocked, what is real).
  - Edge cases to cover.
- **Pattern references**: specific files in the repo the agent
  should follow as examples, with the exact aspects to mirror
  (e.g. "follow `coderWrapper/src/coder.ts` for node-pty spawn
  and cleanup pattern, specifically the `start()` and `stop()`
  methods").
- **Build verification**: the exact commands the agent must run
  after each commit and the expected outcome.
- **Commit plan**: one entry per commit with the item ID, commit
  message template, and which files are included.

#### Phase 2: Implementation (agent executes, operator reviews)

4. **Agent** implements the code items per the sub-plan,
   committing after each (one commit per checkmarked item).
5. **Agent** runs `pnpm run build` and `pnpm run test:local`
   after each commit to verify nothing is broken.
6. **Operator** reviews the commits, runs any applicable
   real-life test point, and requests fixes if needed.
7. **Agent** addresses feedback with additional commits.
8. At the PR boundary, **operator** creates the PR and
   shepherds it through review.

### What the agent needs in the implementation prompt

Once the sub-plan is approved, the agent's implementation prompt
should include:

- The approved sub-plan (the full document, not a summary).
- The chunk section from this plan (for context on where the
  chunk fits in the overall dependency graph).
- Explicit instruction to follow the sub-plan exactly: do not
  add features, change signatures, or make design choices not
  covered by the sub-plan. If a gap is found during
  implementation, stop and ask the operator rather than
  improvising.

### What the operator watches for

- Agent drifting from the plan (adding features not in scope).
- Tests that pass but don't actually test the behavior described.
- Decisions being made implicitly in code without being recorded.
- Build or lint failures in other packages (blast radius).

## File layout

```
tools/agentOrchestrator/
├── package.json
├── tsconfig.json              # composite root: references src + test
├── jest.config.cjs            # extends ../../jest.config.js
├── src/
│   ├── tsconfig.json          # src sub-project: outDir ../dist
│   ├── main.ts                # CLI entrypoint
│   ├── index.ts               # public API re-exports
│   ├── orchestrator.ts        # top-level: load config, create sessions, run
│   ├── config.ts              # YAML loader + validation
│   ├── session.ts             # pty lifecycle + state machine
│   ├── analyzer.ts            # output line classifier
│   ├── worktree.ts            # git worktree create/remove/list
│   ├── notifier.ts            # notification dispatch
│   ├── drivers/
│   │   ├── interface.ts       # AgentDriver type
│   │   ├── copilot.ts         # Copilot CLI driver
│   │   └── claude.ts          # Claude Code driver (Phase 3)
│   └── ui/
│       ├── textDashboard.ts   # Phase 1: ANSI status lines
│       └── inkDashboard.tsx   # Phase 2: Ink TUI
└── test/
    ├── tsconfig.json          # test sub-project: outDir ../dist/test
    ├── config.spec.ts
    ├── analyzer.spec.ts
    ├── session.spec.ts        # mock pty
    ├── worktree.spec.ts       # mock git
    └── fixtures/
        └── mock-agent.sh      # echo script for e2e test
```

## Verification

- **Unit tests**: analyzer pattern matching, config parsing, state
  machine transitions (mock pty).
- **Integration test**: run 3 lanes with `mock-agent.sh` (a shell
  script that echoes progress lines, sleeps, and exits), verify all
  lanes reach DONE, commit counts match, notifications fire.
- **Manual test**: run against real `copilot` CLI with a trivial
  prompt ("create a file called hello.txt with 'hello world'") in
  3 worktrees. Verify dashboard, focus mode, and notification.

## Open questions

- ~~Should the orchestrator auto-commit and push per lane, or leave that
  to the agent?~~ Resolved: agents commit during execution (their
  normal workflow). The orchestrator never auto-commits or auto-pushes.
  Post-completion, the operator reviews diffs and pushes explicitly
  via dashboard keybindings. See "Operator interaction model" above.
- ~~Should focus mode use a raw pty replay (scrollback buffer) or
  re-render the last N lines?~~ Resolved: raw pty scrollback buffer.
  Simpler, preserves ANSI formatting, and avoids re-rendering logic.
- ~~Should lane configs support environment variable overrides per
  lane?~~ Resolved: yes, via an optional `env:` key in the lane
  config. Low cost, useful for different API keys per lane.
- ~~Ink 7 is ESM-only. Confirm this works in the monorepo build
  before committing to Ink in Phase 2.~~ Resolved: 31 of 32
  packages in the repo already declare `"type": "module"` (only
  `coda` does not). The `tsconfig.base.json` targets
  `"module": "node16"` which supports ESM. No compatibility risk.
