// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    mkdirSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    existsSync,
} from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { OrchestratorConfig } from "./config.js";
import type { LaneState } from "./session.js";

/** Persisted state for a single lane. */
export interface PersistedLaneState {
    name: string;
    state: LaneState;
    exitCode?: number;
    agentSessionId?: string;
    elapsedMs: number;
    commitCount: number;
}

/** Persisted orchestrator session. */
export interface OrchestratorSession {
    /** Session ID (timestamp-based). */
    id: string;
    /** Absolute path to the original YAML config file. */
    configPath: string;
    /** Absolute path to the repository root. */
    repo: string;
    /** ISO timestamp of session start. */
    startedAt: string;
    /** Per-lane state snapshots. */
    lanes: PersistedLaneState[];
}

/**
 * Compute the session directory path for a given repo and session ID.
 * Convention: ~/.agent-orchestrator/<repo-path>/<session-id>/
 */
export function sessionDir(
    repoRoot: string,
    sessionId: string,
    baseDir?: string,
): string {
    const base = baseDir ?? resolve(homedir(), ".agent-orchestrator");
    const absRepo = resolve(repoRoot);
    const repoRelative = absRepo.startsWith("/") ? absRepo.slice(1) : absRepo;
    return resolve(base, repoRelative, sessionId);
}

/**
 * Generate a timestamp-based session ID: YYYYMMDD-HHmmss
 * Appends -N suffix if collisions exist.
 */
function generateSessionId(repoRoot: string, baseDir?: string): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const base =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const existing = listSessions(repoRoot, baseDir);
    if (!existing.includes(base)) {
        return base;
    }

    // Resolve collision
    let suffix = 2;
    while (existing.includes(`${base}-${suffix}`)) {
        suffix++;
    }
    return `${base}-${suffix}`;
}

/**
 * Create a new orchestrator session with IDLE lanes and timestamp ID.
 */
export function createSession(
    configPath: string,
    config: OrchestratorConfig,
    baseDir?: string,
): OrchestratorSession {
    const id = generateSessionId(config.repo, baseDir);
    const lanes: PersistedLaneState[] = config.lanes.map((lane) => {
        const s: PersistedLaneState = {
            name: lane.name,
            state: "IDLE",
            elapsedMs: 0,
            commitCount: 0,
        };
        return s;
    });
    return {
        id,
        configPath: resolve(configPath),
        repo: resolve(config.repo),
        startedAt: new Date().toISOString(),
        lanes,
    };
}

/**
 * Write session.json to the session directory.
 * Creates the directory if it doesn't exist.
 * Uses synchronous I/O to avoid data loss on crash.
 */
export function saveSession(
    session: OrchestratorSession,
    baseDir?: string,
): void {
    const dir = sessionDir(session.repo, session.id, baseDir);
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, "session.json");
    writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n");
}

/**
 * Read and parse session.json from the session directory.
 * Throws if the session does not exist.
 */
export function loadSession(
    repoRoot: string,
    sessionId: string,
    baseDir?: string,
): OrchestratorSession {
    const dir = sessionDir(repoRoot, sessionId, baseDir);
    const filePath = resolve(dir, "session.json");
    if (!existsSync(filePath)) {
        throw new Error(`Session "${sessionId}" not found at ${filePath}`);
    }
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as OrchestratorSession;
}

/**
 * List session IDs for a repo, sorted newest first.
 * Returns an empty array if no sessions exist.
 */
export function listSessions(repoRoot: string, baseDir?: string): string[] {
    const base = baseDir ?? resolve(homedir(), ".agent-orchestrator");
    const absRepo = resolve(repoRoot);
    const repoRelative = absRepo.startsWith("/") ? absRepo.slice(1) : absRepo;
    const repoDir = resolve(base, repoRelative);

    if (!existsSync(repoDir)) {
        return [];
    }

    const entries = readdirSync(repoDir, { withFileTypes: true });
    const sessionIds = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => /^\d{8}-\d{6}/.test(name))
        .sort()
        .reverse();

    return sessionIds;
}
