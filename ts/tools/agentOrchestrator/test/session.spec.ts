// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { Session } from "../src/session.js";
import type { LaneState } from "../src/session.js";
import type { AgentDriver, SpawnSpec } from "../src/driver.js";
import type { LaneConfig } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../test/fixtures");

function mockAgent(script: string, exitCode?: number): AgentDriver {
    const args = [resolve(FIXTURES, script)];
    if (exitCode !== undefined) {
        args.push(String(exitCode));
    }
    return {
        name: "mock",
        supportsToolAllowList: false,
        supportsSessionResume: true,
        buildCommand(_config: LaneConfig, _promptText: string): SpawnSpec {
            return { file: "bash", args };
        },
        buildResumeCommand(
            _config: LaneConfig,
            _sessionId?: string,
        ): SpawnSpec | null {
            return { file: "bash", args };
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

function makeLane(overrides?: Partial<LaneConfig>): LaneConfig {
    const base: LaneConfig = {
        name: "test-lane",
        branch: "orch/test",
        agent: "mock",
        promptFile: "/tmp/prompt.md",
    };
    return { ...base, ...overrides };
}

/** Wait for a session to reach a specific state. */
function waitForState(
    session: Session,
    target: LaneState,
    timeoutMs: number = 10000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (session.info.state === target) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `Timed out waiting for state ${target}, current: ${session.info.state}`,
                ),
            );
        }, timeoutMs);
        session.on(
            "stateChange",
            (_name: string, _from: LaneState, to: LaneState) => {
                if (to === target) {
                    clearTimeout(timer);
                    resolve();
                }
            },
        );
    });
}

describe("session manager", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(resolve(tmpdir(), "orch-session-"));
    });

    it("starts in IDLE state", () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh"),
            tmpDir,
            "main",
        );
        expect(session.info.state).toBe("IDLE");
    });

    it("spawn transitions to RUNNING", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh"),
            tmpDir,
            "main",
        );
        const states: LaneState[] = [];
        session.on("stateChange", (_n: string, _f: LaneState, to: LaneState) =>
            states.push(to),
        );
        session.spawn("test prompt");
        expect(states).toContain("RUNNING");
        await waitForState(session, "DONE");
    });

    it("emits output events for each line", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh"),
            tmpDir,
            "main",
        );
        const lines: string[] = [];
        session.on("output", (_name: string, line: string) => lines.push(line));
        session.spawn("test prompt");
        await waitForState(session, "DONE");
        expect(lines.some((l) => l.includes("Starting mock agent"))).toBe(true);
        expect(lines.some((l) => l.includes("Working on task"))).toBe(true);
    });

    it("transitions to DONE on exit code 0", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh"),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");
        await waitForState(session, "DONE");
        expect(session.info.state).toBe("DONE");
        expect(session.info.exitCode).toBe(0);
    });

    it("transitions to FAILED on non-zero exit", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh", 1),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");
        await waitForState(session, "FAILED");
        expect(session.info.state).toBe("FAILED");
        expect(session.info.exitCode).toBe(1);
    });

    it("kill transitions to KILLED", async () => {
        // Use the echo agent which waits for input, so it stays RUNNING
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent-echo.sh"),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");

        // Wait a bit for process to start
        await new Promise((r) => setTimeout(r, 200));
        expect(session.info.state).toBe("RUNNING");

        session.kill();
        expect(session.info.state).toBe("KILLED");
    });

    it("captures session ID from output", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh"),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");
        await waitForState(session, "DONE");
        expect(session.info.sessionId).toBe("mock-session-123");
    });

    it("resume re-spawns with RUNNING state", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh"),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");
        await waitForState(session, "DONE");

        const states: LaneState[] = [];
        session.on("stateChange", (_n: string, _f: LaneState, to: LaneState) =>
            states.push(to),
        );
        session.resume("follow up");
        expect(states).toContain("RUNNING");
        await waitForState(session, "DONE");
    });

    it("retry re-spawns with RUNNING state", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh", 1),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");
        await waitForState(session, "FAILED");

        // Swap to a driver that succeeds for the retry
        const states: LaneState[] = [];
        session.on("stateChange", (_n: string, _f: LaneState, to: LaneState) =>
            states.push(to),
        );
        session.retry("new prompt");
        expect(states).toContain("RUNNING");
        // The retry still uses the same driver (exit code 1), so it
        // will FAIL again. That's fine: we're testing that retry
        // transitions through RUNNING.
        await waitForState(session, "FAILED");
    });

    it("write sends input to pty", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent-echo.sh"),
            tmpDir,
            "main",
        );
        const lines: string[] = [];
        session.on("output", (_name: string, line: string) => lines.push(line));
        session.spawn("test prompt");

        // Wait for the "Waiting for input..." line
        await new Promise<void>((resolve) => {
            const check = () => {
                if (lines.some((l) => l.includes("Waiting for input"))) {
                    resolve();
                } else {
                    setTimeout(check, 50);
                }
            };
            check();
        });

        session.write("hello world\n");
        await waitForState(session, "DONE");
        expect(lines.some((l) => l.includes("Got: hello world"))).toBe(true);
    });

    it("shutdown sends SIGTERM then resolves", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent-echo.sh"),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");

        // Wait for process to start
        await new Promise((r) => setTimeout(r, 200));

        await session.shutdown();
        // After shutdown, state should be terminal
        const state = session.info.state;
        expect(["KILLED", "DONE", "FAILED"]).toContain(state);
    });

    it("elapsed time increases while running", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent.sh"),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");
        await waitForState(session, "DONE");
        expect(session.info.elapsedMs).toBeGreaterThan(0);
    });

    it("recentOutput is capped at buffer size", async () => {
        const session = new Session(
            makeLane(),
            mockAgent("mock-agent-verbose.sh"),
            tmpDir,
            "main",
        );
        session.spawn("test prompt");
        await waitForState(session, "DONE");
        // Buffer size is 100
        expect(session.info.recentOutput.length).toBeLessThanOrEqual(100);
        // Should still have the session ID in recent output
        expect(session.info.sessionId).toBe("verbose-session-789");
    });
});
