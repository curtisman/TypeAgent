#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { getDriver } from "./driver.js";
import { Session } from "./session.js";
import { createSession, saveSession } from "./orchestratorSession.js";
import type { OrchestratorSession } from "./orchestratorSession.js";
import { setupAll, worktreePath } from "./worktree.js";
import { Dashboard } from "./dashboard.js";
import { createNotifier } from "./notifier.js";

// Side-effect imports: register agent drivers
import "./drivers/copilot.js";
import "./drivers/claude.js";

function updateSessionState(
    orchSession: OrchestratorSession,
    sessions: Session[],
): void {
    for (let i = 0; i < sessions.length; i++) {
        const info = sessions[i].info;
        orchSession.lanes[i].state = info.state;
        orchSession.lanes[i].elapsedMs = info.elapsedMs;
        if (info.exitCode !== undefined) {
            orchSession.lanes[i].exitCode = info.exitCode;
        }
        if (info.sessionId !== undefined) {
            orchSession.lanes[i].agentSessionId = info.sessionId;
        }
    }
}

async function main(): Promise<void> {
    const configPath = process.argv[2];
    if (!configPath) {
        console.error("Usage: agent-orchestrator <lanes.yaml>");
        process.exit(1);
    }

    const fullPath = resolve(configPath);
    const config = loadConfig(fullPath);

    // Create orchestrator session
    const orchSession = createSession(fullPath, config);
    console.log(`Session ${orchSession.id}: ${config.lanes.length} lane(s)`);

    // Setup worktrees
    process.stdout.write("Setting up worktrees...\n");
    await setupAll(config, orchSession.id);

    // Read prompts and create sessions
    const sessions: Session[] = [];
    const prompts: string[] = [];
    for (const lane of config.lanes) {
        const wtPath = worktreePath(config.repo, lane.name, orchSession.id);
        const driver = getDriver(lane.agent);
        sessions.push(new Session(lane, driver, wtPath, config.base));
        prompts.push(readFileSync(lane.promptFile, "utf-8"));
    }

    // Start dashboard
    const notifier = createNotifier(config.notify);
    const dashboard = new Dashboard({
        sessions,
        sessionId: orchSession.id,
        config,
        notifier,
    });
    dashboard.start();

    // Spawn all agents
    for (let i = 0; i < sessions.length; i++) {
        sessions[i].spawn(prompts[i]);
    }

    // Periodically save session state
    const saveTimer = setInterval(() => {
        updateSessionState(orchSession, sessions);
        saveSession(orchSession);
    }, 5000);

    // Handle signals
    const onSignal = () => {
        void dashboard.quit();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    // Wait for quit
    await dashboard.done();

    // Final save
    clearInterval(saveTimer);
    updateSessionState(orchSession, sessions);
    saveSession(orchSession);

    process.stdout.write(`Session saved: ${orchSession.id}\n`);
}

main().catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
});
