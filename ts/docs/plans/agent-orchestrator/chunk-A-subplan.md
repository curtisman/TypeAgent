# Chunk A Sub-plan: Scaffold and Config

Parent: [PLAN.md](PLAN.md) - Chunk A (PR 1 start)

## Scope

| Item | Description                      | In scope |
| ---- | -------------------------------- | -------- |
| A.1  | Decision: node-pty version       | Resolved |
| A.2  | Decision: simple-git vs execFile | Resolved |
| A.3  | Package scaffold                 | Yes      |
| A.4  | Lane config loader (YAML)        | Yes      |

Out of scope: runtime behavior, pty spawning, git operations,
dashboard, notifications. This chunk produces a buildable package
that can parse and validate a `lanes.yaml` file into typed
config objects.

## Resolved decisions

### A.1: node-pty version

**Decision:** use `^1.0.0` to match `coderWrapper`.

Rationale: `coderWrapper` is the only package in the repo that
depends on `node-pty`. Using the same semver range avoids
duplicate native builds. The root `package.json` already lists
`node-pty` in `onlyBuiltDependencies`.

Note: `node-pty` is not added in Chunk A. It is added in Chunk C
when the session manager is implemented. This decision is recorded
here so Chunk C does not need to re-research it.

### A.2: simple-git vs execFile

**Decision:** use `child_process.execFile` (no `simple-git`).

Rationale: the worktree manager (Chunk B) needs only 4 git
commands (`worktree add`, `worktree remove`, `worktree list`,
`log --oneline`). `execFile` is zero-dependency, already used
throughout the repo, and sufficient for this surface. The
dependency table in `PLAN.md` should be updated to remove
`simple-git`.

## Dependency research

All external dependencies used across the full project (Phases 1-3),
documented here so later chunks can reference this section rather
than re-researching.

### `node-pty` ^1.0.0 (Chunk C)

**Purpose:** spawn agent CLI processes in a real pseudoterminal so
they see `isatty()=true`, emit ANSI output, and show interactive
prompts.

**Why this package:** it is the only actively maintained pty library
for Node.js. Maintained by Microsoft, powers VS Code's terminal.
Already used by `coderWrapper` in this repo.

**Alternatives considered:**

| Package                                           | Verdict  | Why not                                                                                                                                                                                                            |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `child_process.spawn` (Node built-in)             | Rejected | No pty. Agents detect `isatty()=false`, suppress colors, may refuse interactive mode. No focus-mode type-through.                                                                                                  |
| `execa` ^9.x                                      | Rejected | Same problem: no pty. High-level wrapper around `child_process`, designed for scripting, not interactive terminal emulation. 12 sub-deps.                                                                          |
| `get-pty-output` ^0.8.2                           | Rejected | Run-and-capture API only (`exec(cmd)` returns output string). No streaming, no `write()`, no ongoing pty handle. 470 weekly downloads, last published 4 years ago. Still requires native build (Rust via napi-rs). |
| `@homebridge/node-pty-prebuilt-multiarch` ^0.13.1 | Rejected | Community fork with prebuilt binaries. Pinned at 0.13.1 (behind node-pty 1.1.0). No benefit since this repo already compiles node-pty for `coderWrapper`.                                                          |
| `pty.js`                                          | Rejected | Abandoned (2015). `node-pty` is its maintained successor.                                                                                                                                                          |
| `node-pty-prebuilt`                               | Rejected | Abandoned (2019). Superseded by the `@homebridge` fork.                                                                                                                                                            |
| `bun:pty`                                         | Rejected | Bun runtime only, not usable from Node.js.                                                                                                                                                                         |

### `yaml` ^2.8.3 (Chunk A)

**Purpose:** parse lane config YAML files into JavaScript objects.

**Why this package:** pure JavaScript, zero dependencies, full YAML
1.2 spec support, TypeScript types included. Already used by
`packages/agents/browser` in this repo at the same version.

**Alternatives considered:**

| Package             | Verdict  | Why not                                                                                                                                                                                      |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js-yaml` ^4.x      | Viable   | Older, widely used (120M weekly downloads). But `yaml` has better TypeScript support, stricter YAML 1.2 compliance, and is already in the repo. No reason to introduce a second YAML parser. |
| Manual `JSON.parse` | Rejected | YAML is the config format specified in the plan. JSON is less readable for lane configs.                                                                                                     |

### `ink` ^7.0.0 + `react` ^18.0.0 (Chunk G, Phase 2)

**Purpose:** TUI dashboard rendering with React component model.
Ink renders React components to the terminal using ANSI escape
codes.

**Why this package:** component-based TUI that supports keyboard
input handling, layout (flexbox), focus management, and live
updates. Well suited for the dashboard's overview/focus mode
switching and per-lane status cards.

**Alternatives considered:**

| Package                                          | Verdict          | Why not                                                                                                                                     |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `blessed` / `neo-blessed`                        | Rejected         | Abandoned. `blessed` last published 2017, `neo-blessed` 2020. Large API surface, curses-style, not component-based.                         |
| `terminal-kit`                                   | Viable           | Full-featured terminal library. But imperative API, no component model. Would require more code to manage dashboard state and re-rendering. |
| Raw ANSI (Phase 1 approach)                      | Used for Phase 1 | Good enough for MVP but lacks focus mode type-through, proper layout, and keyboard routing. Phase 2 replaces it with Ink.                   |
| `cli-cursor` + `ansi-escapes` + manual rendering | Rejected         | What the Phase 1 text dashboard does. Works but does not scale to focus mode with pty replay and type-through.                              |

### `node-notifier` ^10.0.0 (Chunk H, Phase 2)

**Purpose:** cross-platform desktop notifications (macOS
Notification Center, Windows toast, Linux `notify-send`).

**Why this package:** the most widely used Node.js desktop
notification library (4M weekly downloads). Simple API:
`notifier.notify({ title, message })`. Supports all three
major platforms.

**Alternatives considered:**

| Package                                           | Verdict  | Why not                                                                        |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `electron` Notification API                       | Rejected | Requires Electron runtime. The orchestrator is a CLI tool.                     |
| OS-specific commands (`osascript`, `notify-send`) | Viable   | Would work but requires per-platform code. `node-notifier` wraps this cleanly. |
| Skip desktop, use only ntfy/webhook               | Viable   | Desktop notifications are Phase 2 and optional. Could defer this entirely.     |

### No dependency: elapsed time and ANSI utilities (Phase 1)

**Purpose:** elapsed time tracking and ANSI cursor/color control
for the Phase 1 text-mode dashboard.

**Decision:** inline these rather than depending on
`interactive-app` (workspace package under `packages/`).

- **Elapsed time**: `performance.now()` is sufficient. A
  stopwatch is ~15 lines.
- **ANSI escape codes**: cursor movement, hide/show, clear line,
  and basic colors are string constants (~30 lines).
- **Spinner**: not needed; the Phase 1 dashboard redraws on a
  timer, so a status indicator character in the lane card is
  enough.

Rationale: the orchestrator may be extracted to a separate repo.
Avoiding workspace dependencies under `packages/` keeps it
self-contained. Phase 2 replaces all text rendering with Ink,
so any inline utilities are short-lived.

### No external dependency: `child_process.execFile` (Chunk B)

**Purpose:** run git commands (`worktree add/remove/list`,
`log --oneline`).

**Why built-in:** only 4 commands needed, all non-interactive.
`execFile` avoids shell injection (arguments are passed as an
array, not interpolated into a shell string). Zero dependency.

**Rejected:** `simple-git` ^3.0.0. Convenience wrapper, but adds
a dependency for 4 commands. Start with `execFile`, revisit only
if the git command surface grows significantly.

## Detailed design

### A.3: Package scaffold

#### Files to create

```
tools/agentOrchestrator/
├── package.json
├── tsconfig.json
├── jest.config.cjs
├── src/
│   ├── tsconfig.json
│   ├── main.ts
│   └── index.ts
└── test/
    └── tsconfig.json
```

#### Modification to existing file

**`pnpm-workspace.yaml`**: add `- tools/*` line after the existing
`- tools` entry. The file uses a flat list (no nested `packages:`
key).

```yaml
- tools
- tools/*
```

This is safe because `tools/*` matches subdirectories only, not
the root `tools/package.json` (which is matched by the `tools`
entry).

#### `package.json`

```json
{
  "name": "agent-orchestrator",
  "version": "0.0.1",
  "private": true,
  "description": "Multi-lane agent orchestrator with TUI dashboard",
  "homepage": "https://github.com/microsoft/TypeAgent#readme",
  "repository": {
    "type": "git",
    "url": "https://github.com/microsoft/TypeAgent.git",
    "directory": "ts/tools/agentOrchestrator"
  },
  "license": "MIT",
  "author": "Microsoft",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "types": "./dist/index.d.ts",
  "bin": {
    "agent-orchestrator": "./dist/main.js"
  },
  "scripts": {
    "build": "npm run tsc",
    "clean": "rimraf --glob dist *.tsbuildinfo *.done.build.log",
    "prettier": "prettier --check . --ignore-path ../../.prettierignore",
    "prettier:fix": "prettier --write . --ignore-path ../../.prettierignore",
    "tsc": "tsc -b"
  },
  "dependencies": {
    "yaml": "^2.8.3"
  },
  "devDependencies": {
    "@types/jest": "^29.5.7",
    "@types/node": "^18.19.3",
    "prettier": "^3.2.5",
    "rimraf": "^5.0.5",
    "typescript": "~5.4.5"
  }
}
```

Key choices:

- Follows `coderWrapper` pattern exactly.
- `bin` entry points to `dist/main.ts` (the CLI entrypoint).
- Only dependency for now is `yaml`. Others are added in later chunks.
- `exports` points to `dist/index.js` (re-exports config types
  so Chunk B can import them).

#### `tsconfig.json` (root)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true
  },
  "include": [],
  "references": [{ "path": "./src" }, { "path": "./test" }],
  "ts-node": { "esm": true }
}
```

#### `src/tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../dist"
  },
  "include": ["./**/*"]
}
```

#### `test/tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../dist/test",
    "types": ["node", "jest"]
  },
  "include": ["./**/*"],
  "ts-node": { "esm": true },
  "references": [{ "path": "../src" }]
}
```

#### `jest.config.cjs`

```js
module.exports = { ...require("../../jest.config.js") };
```

Follows the composite pattern used by `actionGrammar`, `cache`,
and other packages with tests. Tests in `test/` compile to
`dist/test/` and are picked up by the root Jest config.

#### `src/main.ts`

Minimal CLI entrypoint. Starts with a `#!/usr/bin/env node`
shebang (required for the `bin` entry in `package.json`).
Parses `argv[2]` as the config file path, calls `loadConfig()`,
prints the lane count, and exits. Runtime behavior is added in
later chunks.

#### `src/index.ts`

Re-exports `loadConfig` and the three config types
(`OrchestratorConfig`, `LaneConfig`, `NotifyConfig`) so other
chunks and tests can import them.

### A.4: Lane config loader

#### File to create

```
tools/agentOrchestrator/src/config.ts
```

#### Example `lanes.yaml`

```yaml
repo: /home/curtism/src/TypeAgent3/ts
base: grammartool

notify:
  channel: ntfy
  topic: orchestrator-status
  on: [blocked, failed, done]

lanes:
  - name: L2-core
    branch: orch/L2-core
    agent: copilot
    prompt-file: ./prompts/L2-core.md
    allow-tools:
      - "shell(pnpm *)"
      - read
      - write

  - name: L3-tests
    branch: orch/L3-tests
    agent: copilot
    prompt-file: ./prompts/L3-tests.md
    timeout: 30m

  - name: L4-cli-scaffold
    branch: orch/L4-cli-scaffold
    agent: claude
    prompt-file: ./prompts/L4-cli.md
    env:
      OPENAI_API_KEY: "$OPENAI_API_KEY_SECONDARY"
```

This is also the content for `test/fixtures/valid-config.yaml`.

#### Exported types

```typescript
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { parse as parseYaml } from "yaml";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";

/** Notification channel configuration. */
export interface NotifyConfig {
  /** Channel type. */
  channel: "ntfy" | "desktop" | "webhook" | "none";
  /** ntfy topic name, or webhook URL. */
  topic?: string;
  /** Which events trigger notifications. */
  on: Array<"blocked" | "failed" | "done" | "error">;
}

/** Per-lane configuration. */
export interface LaneConfig {
  /** Human-readable lane name (used in dashboard and worktree dir). */
  name: string;
  /** Git branch name to create for this lane's worktree. */
  branch: string;
  /** Agent driver name (e.g. "copilot", "claude"). */
  agent: string;
  /** Absolute path to the prompt file. Resolved from YAML-relative path. */
  promptFile: string;
  /** Timeout duration string (e.g. "30m", "1h"). */
  timeout?: string;
  /** Tool allow-list passed to the agent CLI. */
  allowTools?: string[];
  /** Per-lane environment variable overrides. */
  env?: Record<string, string>;
}

/** Top-level orchestrator configuration. */
export interface OrchestratorConfig {
  /** Absolute path to the repository root. */
  repo: string;
  /** Base branch to create worktrees from. */
  base: string;
  /** Notification settings. */
  notify: NotifyConfig;
  /** Lane definitions. */
  lanes: LaneConfig[];
}
```

#### `loadConfig` function signature

```typescript
export function loadConfig(configPath: string): OrchestratorConfig;
```

- Reads `configPath` with `readFileSync`, parses with `yaml`'s
  `parse()`, validates the result, returns typed config.
- Resolves relative paths (`prompt-file`) against the YAML file's
  directory.
- Throws on file read errors, YAML parse errors, or validation
  failures.

#### Validation behavior

The loader validates eagerly at load time. All errors include the
field name/path for easy debugging.

| Field                 | Rule                                                                 | Error on violation                                           |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `repo`                | Required non-empty string                                            | `"repo" must be a non-empty string`                          |
| `base`                | Required non-empty string                                            | `"base" must be a non-empty string`                          |
| `notify`              | Optional object; defaults to `{ channel: "none", on: [] }`           | `"notify" must be an object`                                 |
| `notify.channel`      | One of: `ntfy`, `desktop`, `webhook`, `none`                         | `"notify.channel" must be one of: ...`                       |
| `notify.topic`        | Optional string                                                      | (no error, just omitted)                                     |
| `notify.on`           | Optional array of event names (`blocked`, `failed`, `done`, `error`) | `Invalid notify event "..."`                                 |
| `lanes`               | Required non-empty array                                             | `"lanes" must be an array` / `must define at least one lane` |
| `lanes[].name`        | Required non-empty string, unique across lanes                       | `Duplicate lane name: "..."`                                 |
| `lanes[].branch`      | Required non-empty string, unique across lanes                       | `Duplicate lane branch: "..."`                               |
| `lanes[].agent`       | Required non-empty string                                            | standard missing field error                                 |
| `lanes[].prompt-file` | Required non-empty string; resolved relative to YAML dir             | standard missing field error                                 |
| `lanes[].timeout`     | Optional string                                                      | (no error, just omitted)                                     |
| `lanes[].allow-tools` | Optional string array                                                | (no error, just omitted)                                     |
| `lanes[].env`         | Optional string-keyed object                                         | (no error, just omitted)                                     |

YAML key names use **kebab-case** (`prompt-file`, `allow-tools`).
TypeScript properties use **camelCase** (`promptFile`, `allowTools`).

- **Default notify**: if `notify` is omitted, defaults to
  `{ channel: "none", on: [] }`.

## Test plan

#### Test file

```
tools/agentOrchestrator/test/config.spec.ts
```

This test file will be compiled to `dist/test/config.spec.js` and
run by the root Jest config (`testMatch: **/dist/test/**/*.spec.js`).

#### Jest configuration

Add to `package.json` scripts (follows `actionGrammar` pattern):

```json
"jest-esm": "node --no-warnings --experimental-vm-modules ./node_modules/jest/bin/jest.js",
"test": "npm run test:local",
"test:local": "pnpm run jest-esm --testPathPattern=\".*[.]spec[.]js\""
```

#### Test fixtures

```
tools/agentOrchestrator/test/fixtures/
├── valid-config.yaml        # The 3-lane example from the plan
├── minimal-config.yaml      # repo + base + one lane, no notify
├── no-lanes.yaml            # Valid YAML but empty lanes array
├── missing-repo.yaml        # Missing required "repo" field
├── duplicate-names.yaml     # Two lanes with the same name
└── duplicate-branches.yaml  # Two lanes with the same branch
```

#### Test cases

All tests live in a single `describe("loadConfig")` block. Each
test calls `loadConfig(fixture("<name>.yaml"))` using a helper
that resolves paths relative to the `test/fixtures/` directory.

| #   | Test name                                      | Fixture                   | Verifies                                                          |
| --- | ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| 1   | parses a valid 3-lane config                   | `valid-config.yaml`       | repo, base, 3 lanes, notify channel + events all parsed correctly |
| 2   | parses a minimal config with defaults          | `minimal-config.yaml`     | 1 lane, notify defaults to `{ channel: "none", on: [] }`          |
| 3   | resolves prompt-file relative to the YAML file | `valid-config.yaml`       | `promptFile` is absolute, resolved against fixture dir            |
| 4   | preserves per-lane env overrides               | `valid-config.yaml`       | `env` object on the lane with env overrides                       |
| 5   | preserves allow-tools list                     | `valid-config.yaml`       | `allowTools` array on the lane with allow-tools                   |
| 6   | throws on missing config file                  | (nonexistent path)        | Any error thrown                                                  |
| 7   | throws on missing repo field                   | `missing-repo.yaml`       | Error contains `"repo" must be a non-empty string`                |
| 8   | throws on empty lanes array                    | `no-lanes.yaml`           | Error contains `must define at least one lane`                    |
| 9   | throws on duplicate lane names                 | `duplicate-names.yaml`    | Error contains `Duplicate lane name`                              |
| 10  | throws on duplicate lane branches              | `duplicate-branches.yaml` | Error contains `Duplicate lane branch`                            |

#### Mock/stub strategy

No mocks needed. Tests use real YAML fixture files on disk.
`loadConfig` uses `readFileSync`, which works without mocking.

## Pattern references

- **Package structure**: follow
  [packages/coderWrapper/package.json](../../packages/coderWrapper/package.json)
  for field order, scripts, and devDependencies.
- **tsconfig**: follow the composite pattern used by
  [packages/actionGrammar/](../../packages/actionGrammar/) with
  split `src/tsconfig.json` and `test/tsconfig.json` sub-projects.
- **Copyright header**: every `.ts` file starts with:
  ```typescript
  // Copyright (c) Microsoft Corporation.
  // Licensed under the MIT License.
  ```
- **4-space indentation** for TypeScript, **2-space** for JSON
  (matching repo Prettier defaults, except `package.json` which
  uses 4-space in this repo).

## Build verification

After each commit, run:

```bash
cd /home/curtism/src/TypeAgent3/ts
pnpm i                           # picks up new workspace package
pnpm run build agentOrchestrator # build the new package
```

After A.4 (config loader + tests), also run:

```bash
cd tools/agentOrchestrator
pnpm run test                    # run config.spec.ts
```

Expected: build succeeds with no errors, all tests pass.

## Commit plan

### Commit 1: A.3 - package scaffold

**Message:** `A.3: package scaffold for agent-orchestrator`

**Files created:**

- `tools/agentOrchestrator/package.json`
- `tools/agentOrchestrator/tsconfig.json`
- `tools/agentOrchestrator/src/tsconfig.json`
- `tools/agentOrchestrator/test/tsconfig.json`
- `tools/agentOrchestrator/jest.config.cjs`
- `tools/agentOrchestrator/src/main.ts` (minimal CLI entrypoint)
- `tools/agentOrchestrator/src/index.ts` (empty re-exports placeholder)

**Files modified:**

- `pnpm-workspace.yaml` (add `tools/*` glob)

**Verification:** `pnpm i && pnpm run build agentOrchestrator`
succeeds. The package appears in `pnpm list`.

### Commit 2: A.4 - lane config loader

**Message:** `A.4: lane config loader with YAML parsing and validation`

**Files created:**

- `tools/agentOrchestrator/src/config.ts`
- `tools/agentOrchestrator/test/config.spec.ts`
- `tools/agentOrchestrator/test/fixtures/valid-config.yaml`
- `tools/agentOrchestrator/test/fixtures/minimal-config.yaml`
- `tools/agentOrchestrator/test/fixtures/no-lanes.yaml`
- `tools/agentOrchestrator/test/fixtures/missing-repo.yaml`
- `tools/agentOrchestrator/test/fixtures/duplicate-names.yaml`
- `tools/agentOrchestrator/test/fixtures/duplicate-branches.yaml`

**Files modified:**

- `tools/agentOrchestrator/src/index.ts` (add re-exports for
  config types and `loadConfig`)
- `tools/agentOrchestrator/src/main.ts` (import and use `loadConfig`)
- `tools/agentOrchestrator/package.json` (add test script)

**Verification:** `pnpm run build agentOrchestrator` succeeds.
`cd tools/agentOrchestrator && pnpm run test` passes all 10 tests.
