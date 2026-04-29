// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import { tmpdir } from "os";
import {
    worktreePath,
    createWorktree,
    removeWorktree,
    listWorktrees,
    commitCount,
    setupAll,
    teardownAll,
} from "../src/worktree.js";
import type { OrchestratorConfig } from "../src/config.js";

/** Create a temp git repo with one commit on "main". Returns repo path. */
function createTestRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "orch-test-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
        cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    writeFileSync(join(dir, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
    return dir;
}

/** Remove a temp directory tree. */
function cleanupDir(dirPath: string): void {
    rmSync(dirPath, { recursive: true, force: true });
}

/** Make a commit in the given directory. */
function makeCommit(cwd: string, filename: string): void {
    writeFileSync(join(cwd, filename), filename);
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", `add ${filename}`], { cwd });
}

/** Build a minimal OrchestratorConfig for testing. */
function testConfig(
    repo: string,
    lanes: Array<{ name: string; branch: string }>,
): OrchestratorConfig {
    return {
        repo,
        base: "main",
        notify: { channel: "none", on: [] },
        lanes: lanes.map((l) => ({
            name: l.name,
            branch: l.branch,
            agent: "copilot",
            promptFile: "/dev/null",
        })),
    };
}

const SESSION = "20260101-120000";

describe("worktree", () => {
    let repoDir: string;
    let baseDir: string;

    beforeEach(() => {
        repoDir = createTestRepo();
        baseDir = mkdtempSync(join(tmpdir(), "orch-wt-"));
    });

    afterEach(() => {
        // Prune worktrees before cleanup to avoid stale refs
        if (repoDir) {
            try {
                execFileSync("git", ["worktree", "prune"], { cwd: repoDir });
            } catch {
                // ignore
            }
            cleanupDir(repoDir);
        }
        if (baseDir) {
            cleanupDir(baseDir);
        }
    });

    it("worktreePath returns dotdir path with session ID", () => {
        const result = worktreePath(
            "/home/user/src/repo",
            "L2-core",
            SESSION,
            baseDir,
        );
        expect(result).toBe(
            resolve(baseDir, "home/user/src/repo", SESSION, "L2-core"),
        );
    });

    it("creates a worktree with a new branch", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);

        expect(existsSync(wtPath)).toBe(true);

        const branches = execFileSync("git", ["branch", "--list"], {
            cwd: repoDir,
        })
            .toString()
            .trim();
        expect(branches).toContain("test-branch");
    });

    it("created worktree is on the correct branch", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);

        const branch = execFileSync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: wtPath },
        )
            .toString()
            .trim();
        expect(branch).toBe("test-branch");
    });

    it("removes a worktree", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);
        await removeWorktree(repoDir, wtPath);

        expect(existsSync(wtPath)).toBe(false);

        const wts = await listWorktrees(repoDir);
        const paths = wts.map((w) => w.path);
        expect(paths).not.toContain(wtPath);
    });

    it("removes a worktree and deletes its branch", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);
        await removeWorktree(repoDir, wtPath, "test-branch");

        const branches = execFileSync("git", ["branch", "--list"], {
            cwd: repoDir,
        })
            .toString()
            .trim();
        expect(branches).not.toContain("test-branch");
    });

    it("removes a worktree without deleting branch", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);
        await removeWorktree(repoDir, wtPath);

        const branches = execFileSync("git", ["branch", "--list"], {
            cwd: repoDir,
        })
            .toString()
            .trim();
        expect(branches).toContain("test-branch");
    });

    it("lists worktrees", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);

        const wts = await listWorktrees(repoDir);
        expect(wts.length).toBe(2); // main + worktree

        const main = wts.find((w) => w.branch === "main");
        expect(main).toBeDefined();
        expect(main!.path).toBe(repoDir);

        const wt = wts.find((w) => w.branch === "test-branch");
        expect(wt).toBeDefined();
        expect(wt!.path).toBe(wtPath);
    });

    it("commitCount returns 0 for fresh worktree", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);

        const count = await commitCount(wtPath, "main");
        expect(count).toBe(0);
    });

    it("commitCount returns N after N commits", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await createWorktree(repoDir, "main", "test-branch", wtPath);

        makeCommit(wtPath, "file1.txt");
        makeCommit(wtPath, "file2.txt");
        makeCommit(wtPath, "file3.txt");

        const count = await commitCount(wtPath, "main");
        expect(count).toBe(3);
    });

    it("setupAll creates worktrees for all lanes", async () => {
        const config = testConfig(repoDir, [
            { name: "lane-A", branch: "br-A" },
            { name: "lane-B", branch: "br-B" },
        ]);

        await setupAll(config, SESSION, baseDir);

        for (const lane of config.lanes) {
            const wtPath = worktreePath(repoDir, lane.name, SESSION, baseDir);
            expect(existsSync(wtPath)).toBe(true);
        }

        const branches = execFileSync("git", ["branch", "--list"], {
            cwd: repoDir,
        })
            .toString()
            .trim();
        expect(branches).toContain("br-A");
        expect(branches).toContain("br-B");
    });

    it("setupAll rolls back on failure", async () => {
        // Pre-create branch "br-B" so lane-B's createWorktree fails
        execFileSync("git", ["branch", "br-B"], { cwd: repoDir });

        const config = testConfig(repoDir, [
            { name: "lane-A", branch: "br-A" },
            { name: "lane-B", branch: "br-B" },
        ]);

        await expect(setupAll(config, SESSION, baseDir)).rejects.toThrow();

        // lane-A should have been rolled back
        const wtPathA = worktreePath(repoDir, "lane-A", SESSION, baseDir);
        expect(existsSync(wtPathA)).toBe(false);
    });

    it("teardownAll removes all worktrees", async () => {
        const config = testConfig(repoDir, [
            { name: "lane-A", branch: "br-A" },
            { name: "lane-B", branch: "br-B" },
        ]);
        await setupAll(config, SESSION, baseDir);

        await teardownAll(config, SESSION, baseDir);

        for (const lane of config.lanes) {
            const wtPath = worktreePath(repoDir, lane.name, SESSION, baseDir);
            expect(existsSync(wtPath)).toBe(false);
        }

        const branches = execFileSync("git", ["branch", "--list"], {
            cwd: repoDir,
        })
            .toString()
            .trim();
        expect(branches).not.toContain("br-A");
        expect(branches).not.toContain("br-B");
    });

    it("teardownAll continues past errors", async () => {
        const config = testConfig(repoDir, [
            { name: "lane-A", branch: "br-A" },
            { name: "lane-B", branch: "br-B" },
        ]);
        await setupAll(config, SESSION, baseDir);

        // Manually remove lane-A's worktree so teardown hits an error on it
        const wtPathA = worktreePath(repoDir, "lane-A", SESSION, baseDir);
        execFileSync("git", ["worktree", "remove", wtPathA, "--force"], {
            cwd: repoDir,
        });

        // Should not throw; lane-B should still be cleaned up
        await teardownAll(config, SESSION, baseDir);

        const wtPathB = worktreePath(repoDir, "lane-B", SESSION, baseDir);
        expect(existsSync(wtPathB)).toBe(false);
    });

    it("throws on non-existent base branch", async () => {
        const wtPath = worktreePath(repoDir, "test-lane", SESSION, baseDir);
        await expect(
            createWorktree(repoDir, "nonexistent-base", "new-branch", wtPath),
        ).rejects.toThrow(/nonexistent-base/);
    });
});
