// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { homedir } from "os";
import type { OrchestratorConfig } from "./config.js";

const execFile = promisify(execFileCb);

/** Information about a single git worktree. */
export interface WorktreeInfo {
    /** Absolute path to the worktree directory. */
    path: string;
    /** The HEAD commit hash. */
    head: string;
    /** Branch name (without refs/heads/ prefix), or "detached". */
    branch: string;
}

/**
 * Run a git command via execFile in the given directory.
 * Returns trimmed stdout. Throws on non-zero exit with stderr context.
 */
async function execGit(args: string[], cwd: string): Promise<string> {
    try {
        const { stdout } = await execFile("git", args, { cwd });
        return stdout.trimEnd();
    } catch (err: unknown) {
        const e = err as Error & { stderr?: string };
        const stderr = e.stderr?.trim() ?? "";
        const msg = stderr || e.message;
        throw new Error(`git ${args[0]} failed in ${cwd}: ${msg}`);
    }
}

/**
 * Compute the worktree directory path for a lane.
 *
 * Convention: ~/.agent-orchestrator/<absolute-repo-path>/<session-id>/<lane-name>/
 * The leading "/" is stripped so path.join produces a relative sub-path.
 */
export function worktreePath(
    repoRoot: string,
    laneName: string,
    sessionId: string,
    baseDir?: string,
): string {
    const base = baseDir ?? resolve(homedir(), ".agent-orchestrator");
    const absRepo = resolve(repoRoot);
    // Strip leading "/" so path.join doesn't treat it as absolute
    const repoRelative = absRepo.startsWith("/") ? absRepo.slice(1) : absRepo;
    return resolve(base, repoRelative, sessionId, laneName);
}

/**
 * Create a git worktree with a new branch.
 * Runs: git worktree add <wtPath> -b <newBranch> <baseBranch>
 */
export async function createWorktree(
    repoRoot: string,
    baseBranch: string,
    newBranch: string,
    wtPath: string,
): Promise<void> {
    await execGit(
        ["worktree", "add", wtPath, "-b", newBranch, baseBranch],
        repoRoot,
    );
}

/**
 * Remove a git worktree. Optionally delete the branch.
 * Uses --force because the worktree may have uncommitted changes.
 */
export async function removeWorktree(
    repoRoot: string,
    wtPath: string,
    deleteBranch?: string,
): Promise<void> {
    await execGit(["worktree", "remove", wtPath, "--force"], repoRoot);
    if (deleteBranch !== undefined) {
        await execGit(["branch", "-D", deleteBranch], repoRoot);
    }
}

/**
 * List all worktrees for a repository.
 * Parses `git worktree list --porcelain` output.
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
    const output = await execGit(["worktree", "list", "--porcelain"], repoRoot);
    if (output.length === 0) {
        return [];
    }

    const blocks = output.split("\n\n");
    const results: WorktreeInfo[] = [];

    for (const block of blocks) {
        const lines = block.trim().split("\n");
        if (lines.length === 0) continue;

        let wtPath = "";
        let head = "";
        let branch = "detached";

        for (const line of lines) {
            if (line.startsWith("worktree ")) {
                wtPath = line.slice("worktree ".length);
            } else if (line.startsWith("HEAD ")) {
                head = line.slice("HEAD ".length);
            } else if (line.startsWith("branch ")) {
                const raw = line.slice("branch ".length);
                branch = raw.startsWith("refs/heads/")
                    ? raw.slice("refs/heads/".length)
                    : raw;
            }
        }

        if (wtPath.length > 0) {
            results.push({ path: wtPath, head, branch });
        }
    }

    return results;
}

/**
 * Count commits in a worktree since the base branch.
 * Returns 0 for a freshly created worktree with no new commits.
 */
export async function commitCount(
    wtPath: string,
    baseBranch: string,
): Promise<number> {
    const output = await execGit(
        ["log", "--oneline", `${baseBranch}..HEAD`],
        wtPath,
    );
    if (output.length === 0) {
        return 0;
    }
    return output.split("\n").length;
}

/**
 * Create worktrees for all lanes in the config. Sequential, with
 * rollback on failure: if any creation fails, previously created
 * worktrees are removed (best-effort) before re-throwing.
 */
export async function setupAll(
    config: OrchestratorConfig,
    sessionId: string,
    baseDir?: string,
): Promise<void> {
    const created: Array<{ wtPath: string; branch: string }> = [];

    for (const lane of config.lanes) {
        const wtPath = worktreePath(config.repo, lane.name, sessionId, baseDir);
        try {
            await createWorktree(config.repo, config.base, lane.branch, wtPath);
            created.push({ wtPath, branch: lane.branch });
        } catch (err) {
            // Rollback previously created worktrees
            for (const prev of created) {
                try {
                    await removeWorktree(config.repo, prev.wtPath, prev.branch);
                } catch {
                    // Best-effort cleanup; swallow errors
                }
            }
            throw err;
        }
    }
}

/**
 * Remove worktrees for all lanes. Best-effort: logs warnings to
 * stderr on failure but never throws.
 */
export async function teardownAll(
    config: OrchestratorConfig,
    sessionId: string,
    baseDir?: string,
): Promise<void> {
    for (const lane of config.lanes) {
        const wtPath = worktreePath(config.repo, lane.name, sessionId, baseDir);
        try {
            await removeWorktree(config.repo, wtPath, lane.branch);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
                `Warning: failed to remove worktree for lane "${lane.name}": ${msg}\n`,
            );
        }
    }
}
