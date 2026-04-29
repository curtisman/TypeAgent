# Chunk B Sub-plan: Worktree Manager

Parent: [PLAN.md](PLAN.md) - Chunk B (PR 1 end)

## Scope

| Item | Description                                     | In scope |
| ---- | ----------------------------------------------- | -------- |
| B.1  | Decision: failure modes + fail-fast vs continue | Resolved |
| B.2  | Decision: serialize worktree mutations          | Resolved |
| B.3  | Worktree manager                                | Yes      |

Out of scope: agent spawning, pty, dashboard, notifications. This
chunk adds worktree lifecycle operations that later chunks (C+)
use to prepare lanes before spawning agents.

## Resolved decisions

### B.1: Worktree setup failure modes

**Decision:** fail-fast by default. If any worktree creation fails
during `setupAll()`, already-created worktrees are cleaned up
(best-effort) and the error propagates. No `--continue-on-error`
flag in v1.

Failure modes and handling:

| Failure                       | Git says                                   | What we do                                                 |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Branch already exists         | `fatal: a branch named 'X' already exists` | Throw with lane name + hint: "delete or pick another name" |
| Worktree path already on disk | `fatal: 'X' already exists`                | Throw with path + hint: "remove directory or run cleanup"  |
| Worktree already registered   | `fatal: 'X' is already checked out`        | Throw with lane name + hint: "run `git worktree remove`"   |
| Base branch doesn't exist     | `fatal: not a valid object name: 'X'`      | Throw with base branch name                                |
| Repo path not a git repo      | `fatal: not a git repository`              | Throw with repo path                                       |
| Disk full / permissions       | OS error                                   | Let the OS error propagate unchanged                       |

Rationale: the orchestrator creates all worktrees before spawning
any agents. If setup is partially broken, running a subset of lanes
is confusing and leaves orphaned worktrees. Better to fix the config
and retry. `--continue-on-error` can be added in Phase 3 if needed.

### B.2: Serialize worktree mutations

**Decision:** all `git worktree add` and `git worktree remove` calls
are awaited sequentially (no Promise.all). `commitCount` and
`listWorktrees` are read-only and safe to run concurrently, but
there is no need for concurrency in v1.

Rationale: git uses `.git/index.lock` and the `.git/worktrees/`
directory for worktree bookkeeping. Concurrent mutations hit lock
conflicts. Worktree operations on local repos complete in well
under one second, so serialization has negligible cost. No mutex
library needed.

## Component design

### File: `src/worktree.ts`

Thin async wrapper around `git worktree` using
`child_process.execFile`. All functions are async because
`execFile` is callback-based (wrapped with `util.promisify`).

#### Exported types

```typescript
/** Information about a single git worktree. */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** The HEAD commit hash. */
  head: string;
  /** Branch name (without refs/heads/ prefix), or "detached". */
  branch: string;
}
```

No `WorktreeSetupResult` type: `setupAll` returns the
`WorktreeInfo[]` from `listWorktrees`, which already has all
needed fields.

#### Exported functions

| Function         | Signature                                                                                    | Git command                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `worktreePath`   | `(repoRoot: string, laneName: string, baseDir?: string) => string`                           | (none, pure path computation)                                                    |
| `createWorktree` | `(repoRoot: string, baseBranch: string, newBranch: string, wtPath: string) => Promise<void>` | `git worktree add <wtPath> -b <newBranch> <baseBranch>`                          |
| `removeWorktree` | `(repoRoot: string, wtPath: string, deleteBranch?: string) => Promise<void>`                 | `git worktree remove <wtPath> --force`, then optionally `git branch -D <branch>` |
| `listWorktrees`  | `(repoRoot: string) => Promise<WorktreeInfo[]>`                                              | `git worktree list --porcelain`                                                  |
| `commitCount`    | `(wtPath: string, baseBranch: string) => Promise<number>`                                    | `git log --oneline <baseBranch>..HEAD` in `wtPath`                               |
| `setupAll`       | `(config: OrchestratorConfig) => Promise<void>`                                              | Sequential `createWorktree` per lane; rollback on error                          |
| `teardownAll`    | `(config: OrchestratorConfig) => Promise<void>`                                              | Sequential `removeWorktree` per lane; best-effort, logs errors                   |

#### Internal helper

```typescript
/** Run a git command via execFile in `cwd`. Returns stdout. Throws on non-zero exit. */
async function execGit(args: string[], cwd: string): Promise<string>;
```

Uses `util.promisify(child_process.execFile)`. The thrown error
includes both stderr and the lane context for debugging.

#### Worktree path convention

```
~/.agent-orchestrator/<absolute-repo-path>/<lane-name>/
```

Example: `repo` = `/home/user/src/TypeAgent3/ts`, lane = `L2-core`
produces `~/.agent-orchestrator/home/user/src/TypeAgent3/ts/L2-core/`.

The full absolute path (with the leading `/` stripped) is used as
the directory structure. This makes it trivial to map a worktree
back to its source repo by reading the path, with no hashing or
ambiguity.

The `worktreePath()` function computes this:

```typescript
function worktreePath(
  repoRoot: string,
  laneName: string,
  baseDir?: string, // default: ~/.agent-orchestrator
): string {
  const base = baseDir ?? path.join(os.homedir(), ".agent-orchestrator");
  const absRepo = path.resolve(repoRoot);
  // Strip leading "/" so path.join doesn't treat it as absolute
  const repoRelative = absRepo.startsWith("/") ? absRepo.slice(1) : absRepo;
  return path.join(base, repoRelative, laneName);
}
```

The `baseDir` parameter is exposed so the CLI can accept
`--worktree-dir <path>` to override the default. Tests pass
an explicit temp directory to avoid writing to the real home.

Rationale for dotdir placement: worktrees next to the repo
clutter the parent directory and may confuse editors. A central
`~/.agent-orchestrator/` directory is discoverable, keeps all
orchestrator state together, and is easily cleaned up. Using the
full repo path as the subdirectory structure means you can always
find which repo a worktree belongs to just by looking at the path.

#### `setupAll` behavior

1. Compute worktree paths for all lanes up front.
2. For each lane (sequentially):
   a. Call `createWorktree(repo, base, lane.branch, wtPath)`.
   b. On error: clean up all previously created worktrees
   (best-effort, swallow cleanup errors), then re-throw the
   original error.
3. On success: return void. Caller can use `worktreePath()` to
   find each lane's directory.

#### `teardownAll` behavior

1. For each lane (sequentially):
   a. Call `removeWorktree(repo, wtPath, lane.branch)`.
   b. On error: log a warning to stderr, continue to next lane.
2. Always completes (never throws).

#### `listWorktrees` parsing

`git worktree list --porcelain` output format:

```
worktree /path/to/main
HEAD abc1234
branch refs/heads/main

worktree /path/to/wt1
HEAD def5678
branch refs/heads/feature

```

Each worktree block is separated by a blank line. Parse by
splitting on blank lines, then extracting `worktree`, `HEAD`,
and `branch` fields. Strip `refs/heads/` prefix from branch.
Handle bare worktrees (no branch line) by using `"detached"`.

#### `commitCount` behavior

Runs `git log --oneline <baseBranch>..HEAD` in the worktree
directory and counts output lines. Returns 0 if the range is
empty (branch just created, no new commits).

Edge case: if `baseBranch` is not an ancestor (force-push,
rebase), `git log` still returns the divergent commits.
This is fine for a progress indicator.

### `removeWorktree` details

Two sequential git commands:

1. `git worktree remove <wtPath> --force` (from `repoRoot`)
2. If `deleteBranch` is provided: `git branch -D <deleteBranch>`
   (from `repoRoot`)

`--force` is used because the worktree may contain uncommitted
changes from a failed agent run. The operator explicitly chose
cleanup, so force-removing is correct.

Branch deletion is optional because the operator may want to keep
the branch for inspection after removing the worktree directory.
`teardownAll` passes the branch name (cleanup = remove everything),
while individual `removeWorktree` calls can omit it.

### Modifications to existing files

#### `src/index.ts`

Add re-exports:

```typescript
export {
  worktreePath,
  createWorktree,
  removeWorktree,
  listWorktrees,
  commitCount,
  setupAll,
  teardownAll,
} from "./worktree.js";
export type { WorktreeInfo } from "./worktree.js";
```

#### `src/main.ts`

No changes in Chunk B. The CLI entrypoint uses worktrees starting
in Chunk C.

## Test plan

### Test file

```
tools/agentOrchestrator/test/worktree.spec.ts
```

### Strategy

Tests use **real git operations** in a temporary directory created
via `fs.mkdtempSync`. Each test (or describe block) creates a
fresh git repo with an initial commit, runs worktree operations,
and verifies results. Temp directories are cleaned up in
`afterEach` / `afterAll`.

No mocks. This validates actual git command interaction, including
error message formats. Tests are fast (under 100ms each) because
git operations on tiny repos are nearly instant.

### Test fixture helper

```typescript
/** Create a temp git repo with one commit on "main". */
async function createTestRepo(): Promise<string>;

/** Remove a temp directory tree. */
function cleanupRepo(repoPath: string): void;
```

`createTestRepo` does:

1. `mkdtempSync(path.join(os.tmpdir(), "orch-test-"))`
2. `git init -b main`
3. Create an empty `.gitkeep` file
4. `git add . && git commit -m "initial"`
5. Return the repo path

### Test cases

| #   | Test name                                  | Verifies                                                             |
| --- | ------------------------------------------ | -------------------------------------------------------------------- |
| 1   | `worktreePath` returns dotdir path         | `~/.agent-orchestrator/<abs-repo-path>/<lane>` mirrors repo path     |
| 2   | creates a worktree with a new branch       | Directory exists, branch exists in `git branch --list`               |
| 3   | created worktree is on the correct branch  | `git rev-parse --abbrev-ref HEAD` in the worktree = newBranch        |
| 4   | removes a worktree                         | Directory gone, `git worktree list` no longer includes it            |
| 5   | removes a worktree and deletes its branch  | Branch no longer in `git branch --list`                              |
| 6   | removes a worktree without deleting branch | Branch still in `git branch --list`                                  |
| 7   | lists worktrees                            | Returns main + created worktrees with correct path/head/branch       |
| 8   | commitCount returns 0 for fresh worktree   | No new commits since base                                            |
| 9   | commitCount returns N after N commits      | Make 3 commits in worktree, count = 3                                |
| 10  | setupAll creates worktrees for all lanes   | All worktree dirs exist, all branches exist                          |
| 11  | setupAll rolls back on failure             | Force dup branch on lane 2; lane 1 worktree is cleaned up            |
| 12  | teardownAll removes all worktrees          | All dirs gone, branches deleted                                      |
| 13  | teardownAll continues past errors          | Remove one worktree manually first; teardownAll still removes others |
| 14  | throws on non-existent base branch         | Error message includes the bad branch name                           |

### Mock/stub strategy

No mocks. All tests run real git commands in isolated temp
directories. This is the same strategy used by many git tool
test suites and avoids mocking `execFile` (which would not
catch git CLI argument errors).

## Build verification

```bash
cd /home/curtism/src/TypeAgent3/ts/tools/agentOrchestrator
npx tsc -b && pnpm run test
```

Expected: all tests pass (config + worktree), no build errors.

## Commit plan

### Single commit: B.3

**Message:** `B.3: worktree manager with create/remove/list/setupAll`

**Files created:**

- `tools/agentOrchestrator/src/worktree.ts`
- `tools/agentOrchestrator/test/worktree.spec.ts`

**Files modified:**

- `tools/agentOrchestrator/src/index.ts` (add worktree re-exports)

**Verification:** `npx tsc -b && pnpm run test` passes all tests.
