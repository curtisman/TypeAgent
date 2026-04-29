// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import {
    sessionDir,
    createSession,
    saveSession,
    loadSession,
    listSessions,
} from "../src/orchestratorSession.js";
import type { OrchestratorConfig } from "../src/config.js";

function testConfig(repo: string): OrchestratorConfig {
    return {
        repo,
        base: "main",
        notify: { channel: "none", on: [] },
        lanes: [
            {
                name: "lane-A",
                branch: "br-A",
                agent: "copilot",
                promptFile: "/tmp/prompt-a.md",
            },
            {
                name: "lane-B",
                branch: "br-B",
                agent: "claude",
                promptFile: "/tmp/prompt-b.md",
            },
        ],
    };
}

describe("orchestrator session", () => {
    let baseDir: string;

    beforeEach(() => {
        baseDir = mkdtempSync(join(tmpdir(), "orch-session-"));
    });

    afterEach(() => {
        if (baseDir) {
            rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("sessionDir includes repo path and session ID", () => {
        const dir = sessionDir(
            "/home/user/src/repo",
            "20260428-143052",
            baseDir,
        );
        expect(dir).toBe(
            resolve(baseDir, "home/user/src/repo", "20260428-143052"),
        );
    });

    it("createSession generates timestamp-based ID", () => {
        const config = testConfig("/tmp/repo");
        const session = createSession("/tmp/config.yaml", config, baseDir);
        expect(session.id).toMatch(/^\d{8}-\d{6}/);
    });

    it("createSession initializes all lanes as IDLE", () => {
        const config = testConfig("/tmp/repo");
        const session = createSession("/tmp/config.yaml", config, baseDir);
        expect(session.lanes).toHaveLength(2);
        for (const lane of session.lanes) {
            expect(lane.state).toBe("IDLE");
            expect(lane.elapsedMs).toBe(0);
            expect(lane.commitCount).toBe(0);
        }
        expect(session.lanes[0].name).toBe("lane-A");
        expect(session.lanes[1].name).toBe("lane-B");
    });

    it("saveSession creates directory and session.json", () => {
        const config = testConfig("/tmp/repo");
        const session = createSession("/tmp/config.yaml", config, baseDir);
        saveSession(session, baseDir);

        const dir = sessionDir("/tmp/repo", session.id, baseDir);
        expect(existsSync(dir)).toBe(true);

        const filePath = resolve(dir, "session.json");
        expect(existsSync(filePath)).toBe(true);

        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        expect(parsed.id).toBe(session.id);
    });

    it("loadSession round-trips through save", () => {
        const config = testConfig("/tmp/repo");
        const session = createSession("/tmp/config.yaml", config, baseDir);
        saveSession(session, baseDir);

        const loaded = loadSession("/tmp/repo", session.id, baseDir);
        expect(loaded).toEqual(session);
    });

    it("loadSession throws for missing session", () => {
        expect(() =>
            loadSession("/tmp/repo", "nonexistent-session", baseDir),
        ).toThrow(/not found/i);
    });

    it("listSessions returns IDs sorted newest first", () => {
        const config = testConfig("/tmp/repo");

        // Create 3 sessions with different IDs
        const s1 = createSession("/tmp/config.yaml", config, baseDir);
        s1.id = "20260101-100000";
        saveSession(s1, baseDir);

        const s2 = createSession("/tmp/config.yaml", config, baseDir);
        s2.id = "20260102-100000";
        saveSession(s2, baseDir);

        const s3 = createSession("/tmp/config.yaml", config, baseDir);
        s3.id = "20260103-100000";
        saveSession(s3, baseDir);

        const ids = listSessions("/tmp/repo", baseDir);
        expect(ids).toEqual([
            "20260103-100000",
            "20260102-100000",
            "20260101-100000",
        ]);
    });

    it("listSessions returns empty array for new repo", () => {
        const ids = listSessions("/tmp/nonexistent-repo", baseDir);
        expect(ids).toEqual([]);
    });

    it("saveSession overwrites existing session.json", () => {
        const config = testConfig("/tmp/repo");
        const session = createSession("/tmp/config.yaml", config, baseDir);
        saveSession(session, baseDir);

        // Update a lane state and save again
        session.lanes[0].state = "DONE";
        session.lanes[0].exitCode = 0;
        session.lanes[0].elapsedMs = 5000;
        session.lanes[0].commitCount = 3;
        saveSession(session, baseDir);

        const loaded = loadSession("/tmp/repo", session.id, baseDir);
        expect(loaded.lanes[0].state).toBe("DONE");
        expect(loaded.lanes[0].exitCode).toBe(0);
        expect(loaded.lanes[0].elapsedMs).toBe(5000);
        expect(loaded.lanes[0].commitCount).toBe(3);
    });
});
