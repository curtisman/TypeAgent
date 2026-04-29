# Chunk F Sub-plan: Post-completion, Notifications, E2E Test

Depends on: Chunks B-E (all).

## F.1: Post-completion actions

Add `diff()`, `push()`, and `cleanup()` methods to `Session`. These
run git commands in the lane's worktree and transition state.

- `diff(base)`: `git log --oneline <base>..HEAD` + `git diff --stat <base>..HEAD`.
  Returns a string. No state transition.
- `push(remote, branch)`: `git push <remote> HEAD:<branch>`.
  Transitions DONE -> PUSHED. Throws on non-DONE state.
- `cleanup()`: delegates to `removeWorktree()`.
  Transitions DONE/FAILED/PUSHED -> ABANDONED.

Dashboard key bindings (on completed lanes):

- `d`: show diff summary for selected lane
- `p`: push selected lane's branch
- `c`: cleanup (remove worktree + abandon)

## F.2: Notifier

New file `src/notifier.ts`. Two channels for Phase 1:

- `none`: no-op (default, used in tests)
- `ntfy`: HTTP POST to `https://ntfy.sh/<topic>` with JSON body

Interface:

```typescript
interface Notifier {
  notify(event: NotifyEvent): Promise<void>;
}
type NotifyEvent = {
  lane: string;
  event: "blocked" | "failed" | "done" | "error";
  message: string;
};
```

Factory: `createNotifier(config: NotifyConfig): Notifier`

Wired into Dashboard via `stateChange` listener: on BLOCKED/DONE/
FAILED transitions, check `config.notify.on` filter and fire.

## F.3: E2E test

Integration test: `test/e2e.spec.ts`

Setup:

- Create a temp git repo with initial commit
- Write a 3-lane YAML config pointing to mock-agent scripts
- Each lane uses a different mock script (fast exit 0, slow exit 0,
  exit 1)

Assertions:

- All 3 sessions reach terminal states (DONE/FAILED)
- Session persistence file exists
- Commit counts are 0 (mock agents don't commit)
- Cleanup removes worktrees

No dashboard in the e2e test (dashboard requires TTY). Tests
exercise the orchestration flow: config -> worktrees -> sessions ->
spawn -> wait -> save -> teardown.

## Files

| File                               | Action                                |
| ---------------------------------- | ------------------------------------- |
| `src/session.ts`                   | Add diff(), push(), cleanup() methods |
| `src/notifier.ts`                  | New: Notifier interface + ntfy + none |
| `src/dashboard.ts`                 | Add d/p/c keys, wire notifier         |
| `src/index.ts`                     | Re-export notifier                    |
| `test/e2e.spec.ts`                 | New: 3-lane integration test          |
| `test/fixtures/mock-agent-fail.sh` | New: exits with code 1                |
| `test/fixtures/mock-agent-slow.sh` | New: sleeps 1s then exits 0           |
