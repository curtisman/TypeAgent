// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { Session } from "../src/session.js";
import type { LaneState } from "../src/session.js";
import type { AgentDriver, SpawnSpec } from "../src/driver.js";
import type { LaneConfig, OrchestratorConfig } from "../src/config.js";
import {
    createSession,
    saveSession,
    loadSession,
} from "../src/orchestratorSession.js";
import { setupAll, teardownAll, worktreePath } from "../src/worktree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../test/fixtures");

/** Create a temp git repo with one commit on "main". */
function createTestRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "orch-e2e-"));
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

/** Build a mock driver that runs a bash script from fixtures. */
function mockDriver(script: string): AgentDriver {
    const scriptPath = resolve(FIXTURES, script);
    return {
        name: "mock",
        supportsToolAllowList: false,
        supportsSessionResume: true,
        buildCommand(_config: LaneConfig, _promptText: string): SpawnSpec {
            return { file: "bash", args: [scriptPath] };
        },
        buildResumeCommand(
            _config: LaneConfig,
            _sessionId?: string,
        ): SpawnSpec | null {
            return { file: "bash", args: [scriptPath] };
        },
        extractSessionId(outputLines: string[]): string | undefined {
            for (let i = outputLines.length - 1; i >= 0; i--) {
                const m = /Session ID:\s*(\S+)/i.exec(outputLines[i]);
                if (m !== null) {
                    return m[1];
                }
            }
            return undefined;
        },
    };
}

/** Wait for a session to reach a terminal state. */
function waitForTerminal(
    session: Session,
    timeoutMs: number = 15000,
): Promise<LaneState> {
    const terminalStates: LaneState[] = [
        "DONE",
        "FAILED",
        "KILLED",
        "TIMED_OUT",
    ];
    return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error("Timeout")), timeoutMs);
        const check = () => {
            if (terminalStates.includes(session.info.state)) {
                clearTimeout(timer);
                res(session.info.state);
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

describe("e2e orchestration", () => {
    let repoDir: string;
    let baseDir: string;

    beforeEach(() => {
        repoDir = createTestRepo();
        baseDir = mkdtempSync(join(tmpdir(), "orch-e2e-base-"));
    });

    afterEach(() => {
        if (repoDir) {
            try {
                execFileSync("git", ["worktree", "prune"], { cwd: repoDir });
            } catch {
                // ignore
            }
            rmSync(repoDir, { recursive: true, force: true });
        }
        if (baseDir) {
            rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("runs 3 lanes to completion with mixed outcomes", async () => {
        const config: OrchestratorConfig = {
            repo: repoDir,
            base: "main",
            notify: { channel: "none", on: [] },
            lanes: [
                {
                    name: "lane-ok",
                    branch: "orch/ok",
                    agent: "mock",
                    promptFile: "/dev/null",
                },
                {
                    name: "lane-fail",
                    branch: "orch/fail",
                    agent: "mock",
                    promptFile: "/dev/null",
                },
                {
                    name: "lane-slow",
                    branch: "orch/slow",
                    agent: "mock",
                    promptFile: "/dev/null",
                },
            ],
        };

        // Create orchestrator session
        const orchSession = createSession("/tmp/test-config.yaml", config);

        // Setup worktrees
        await setupAll(config, orchSession.id, baseDir);

        // Create sessions with different mock scripts
        const okDriver = mockDriver("mock-agent.sh");
        const failDriver = mockDriver("mock-agent-fail.sh");
        const slowDriver = mockDriver("mock-agent-slow.sh");

        const sessions: Session[] = [
            new Session(
                config.lanes[0],
                okDriver,
                worktreePath(repoDir, "lane-ok", orchSession.id, baseDir),
                "main",
            ),
            new Session(
                config.lanes[1],
                failDriver,
                worktreePath(repoDir, "lane-fail", orchSession.id, baseDir),
                "main",
            ),
            new Session(
                config.lanes[2],
                slowDriver,
                worktreePath(repoDir, "lane-slow", orchSession.id, baseDir),
                "main",
            ),
        ];

        // Spawn all
        for (const s of sessions) {
            s.spawn("test prompt");
        }

        // Wait for all to reach terminal states
        const results = await Promise.all(
            sessions.map((s) => waitForTerminal(s)),
        );

        // Verify outcomes
        expect(results[0]).toBe("DONE"); // mock-agent.sh exits 0
        expect(results[1]).toBe("FAILED"); // mock-agent-fail.sh exits 1
        expect(results[2]).toBe("DONE"); // mock-agent-slow.sh exits 0

        // Verify info is populated
        expect(sessions[0].info.exitCode).toBe(0);
        expect(sessions[1].info.exitCode).toBe(1);
        expect(sessions[2].info.exitCode).toBe(0);

        // Verify output was captured
        expect(sessions[0].info.recentOutput.length).toBeGreaterThan(0);
        expect(sessions[1].info.recentOutput.length).toBeGreaterThan(0);
        expect(sessions[2].info.recentOutput.length).toBeGreaterThan(0);

        // Session IDs should be extracted for ok and slow agents
        expect(sessions[1].info.sessionId).toBe("fail-session-001");
        expect(sessions[2].info.sessionId).toBe("slow-session-002");

        // Save and reload session state
        for (let i = 0; i < sessions.length; i++) {
            orchSession.lanes[i].state = sessions[i].info.state;
            orchSession.lanes[i].elapsedMs = sessions[i].info.elapsedMs;
            const exitCode = sessions[i].info.exitCode;
            if (exitCode !== undefined) {
                orchSession.lanes[i].exitCode = exitCode;
            }
        }
        saveSession(orchSession, baseDir);

        const loaded = loadSession(repoDir, orchSession.id, baseDir);
        expect(loaded).not.toBeNull();
        expect(loaded!.lanes[0].state).toBe("DONE");
        expect(loaded!.lanes[1].state).toBe("FAILED");
        expect(loaded!.lanes[2].state).toBe("DONE");

        // Teardown worktrees
        const stderrCapture: string[] = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderrCapture.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;

        await teardownAll(config, orchSession.id, baseDir);

        process.stderr.write = origWrite;

        // Worktree dirs should be gone
        for (const lane of config.lanes) {
            const wtDir = worktreePath(
                repoDir,
                lane.name,
                orchSession.id,
                baseDir,
            );
            expect(existsSync(wtDir)).toBe(false);
        }
    }, 30000);

    it("allows kill on a running session", async () => {
        const config: OrchestratorConfig = {
            repo: repoDir,
            base: "main",
            notify: { channel: "none", on: [] },
            lanes: [
                {
                    name: "lane-kill",
                    branch: "orch/kill",
                    agent: "mock",
                    promptFile: "/dev/null",
                },
            ],
        };

        const orchSession = createSession("/tmp/test-config.yaml", config);
        await setupAll(config, orchSession.id, baseDir);

        // Use a script that runs long enough to be killed
        const slowDriver = mockDriver("mock-agent-slow.sh");
        const session = new Session(
            config.lanes[0],
            slowDriver,
            worktreePath(repoDir, "lane-kill", orchSession.id, baseDir),
            "main",
        );

        session.spawn("test prompt");

        // Ensure it's running
        expect(session.info.state).toBe("RUNNING");

        // Kill it
        session.kill();

        const finalState = await waitForTerminal(session);
        expect(finalState).toBe("KILLED");

        // Teardown
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (() => true) as typeof process.stderr.write;
        await teardownAll(config, orchSession.id, baseDir);
        process.stderr.write = origWrite;
    }, 15000);
});
