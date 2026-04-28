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
- **Push** the lane's branch when satisfied.
- **Retry** a failed lane with the same or a modified prompt.
- **Cleanup** worktrees for lanes that are pushed or abandoned.

The dashboard offers these as keybindings on completed lanes:
`[d]iff`, `[p]ush`, `[r]etry`, `[c]leanup`.

### Lifecycle summary

| Phase    | What the agent does                | What the orchestrator does               | What the operator does          |
| -------- | ---------------------------------- | ---------------------------------------- | ------------------------------- |
| Start    | -                                  | Create worktrees, spawn agents           | Launch, watch                   |
| Running  | Write code, commit, test, self-fix | Observe, classify output, track commits  | Glance at dashboard             |
| Blocked  | Wait for approval                  | Detect silence / approval prompt, notify | Focus lane, type answer         |
| Error    | Try to self-fix                    | Surface error signal                     | Watch, optionally intervene     |
| Done     | Exit 0                             | Show summary, offer post-actions         | Review diff, push, cleanup      |
| Failed   | Exit non-zero                      | Show summary, offer retry                | Review output, retry or abandon |
| All done | -                                  | Show aggregate summary                   | Push branches, cleanup, quit    |

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

  /** Whether this driver supports the --allow-tool style pre-auth. */
  readonly supportsToolAllowList: boolean;
}

interface SpawnSpec {
  file: string; // e.g. "copilot" or "claude"
  args: string[]; // e.g. ["-p", promptText, "--allow-tool", ...]
  env?: Record<string, string>;
}
```

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
     input / resume  │  [d]iff, [p]ush,
          │          │  [r]etry, [c]leanup
          ▼          │
       RUNNING       ▼
                  PUSHED / ABANDONED
```

Terminal states: `PUSHED`, `ABANDONED`. A lane in `DONE` or `FAILED`
can transition to `PUSHED` (operator reviewed and pushed the branch)
or `ABANDONED` (operator decided to discard). `FAILED` lanes can also
transition back to `RUNNING` via retry.

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
- Expose `retry(prompt?)` for re-spawning a failed lane.
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

- `create(baseBranch, newBranch, path)`: `git worktree add <path> -b <newBranch> <baseBranch>`.
- `remove(path)`: `git worktree remove <path>`.
- `list()`: `git worktree list --porcelain`.
- `commitCount(path, base)`: `git log --oneline <base>..HEAD` in the worktree.
- Worktrees are created under a sibling directory:
  `<repoRoot>/../agent-worktrees/<lane-name>/`.

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
│  [d]iff  [p]ush  [r]etry  [c]leanup  [f]ocus  [q]uit  │
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
│  Worktrees: ../agent-worktrees/L{2,4,5}-*              │
│                                                        │
│  [d]iff  [p]ush  [c]leanup  [q]uit                    │
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

| Package                        | Purpose                       | Status in repo                         |
| ------------------------------ | ----------------------------- | -------------------------------------- |
| `node-pty` ^1.0.0              | Pty spawn                     | Already used by `coderWrapper`         |
| `ink` ^7.0.0                   | TUI rendering                 | New                                    |
| `react` ^18.0.0                | Peer dep for Ink              | New                                    |
| `yaml` ^2.0.0                  | Lane config parsing           | New                                    |
| `simple-git` ^3.0.0            | Worktree management           | New (could use raw `execFile` instead) |
| `node-notifier` ^10.0.0        | Desktop notifications         | New; optional                          |
| `interactive-app` workspace:\* | Reuse `StopWatch`, ANSI utils | Already in repo                        |

`simple-git` is a convenience; we could use raw `child_process.execFile`
for the 4 git commands we need. Decision: start with `execFile`, add
`simple-git` only if the git surface grows.

## Phases

### Phase 1: core orchestrator (MVP)

Ship a working `agent-orchestrator` that can run N lanes in parallel
with a text-mode dashboard (no Ink). Output to stdout with ANSI
status lines, refreshed on a timer. Focus mode via numbered input.

| Item  | Description                                            |
| ----- | ------------------------------------------------------ |
| P1.1  | Package scaffold (`tools/agentOrchestrator/`)          |
| P1.2  | Lane config loader (YAML)                              |
| P1.3  | Worktree manager                                       |
| P1.4  | Agent driver interface + `copilot` driver              |
| P1.5  | Session manager (node-pty + state machine)             |
| P1.6  | Output analyzer (regex v1)                             |
| P1.7  | Text-mode dashboard (ANSI status lines, no Ink)        |
| P1.8  | Post-completion actions (diff, push, cleanup)          |
| P1.9  | Notifier (ntfy channel only)                           |
| P1.10 | End-to-end test: 3 lanes with mock agent (echo script) |

Rationale for text-mode first: Ink adds React as a dependency and
has a learning curve. A simple `setInterval` + ANSI cursor-control
dashboard (using `interactiveApp`'s `ANSI` constants and
`EnhancedSpinner`) is faster to ship and validates the core
abstractions before investing in the TUI.

### Phase 2: Ink TUI

Replace the text-mode dashboard with Ink. Adds focus mode (full pty
replay + type-through), better layout, and keyboard shortcuts.

| Item | Description                                    |
| ---- | ---------------------------------------------- |
| P2.1 | Add `ink` + `react` dependencies               |
| P2.2 | `<Dashboard>` + `<LaneCard>` components        |
| P2.3 | `<FocusView>` with pty replay and type-through |
| P2.4 | `<StatusBar>` with key bindings                |
| P2.5 | Desktop notification channel                   |

### Phase 3: polish

| Item | Description                                                |
| ---- | ---------------------------------------------------------- |
| P3.1 | `claude` agent driver                                      |
| P3.2 | Webhook notification channel                               |
| P3.3 | Lane dependency ordering (start L4 only after L2 finishes) |
| P3.4 | Auto-cleanup of worktrees on exit                          |
| P3.5 | Config validation with clear error messages                |
| P3.6 | Retry failed lane with modified prompt                     |

## File layout

```
tools/agentOrchestrator/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts                # CLI entrypoint
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
