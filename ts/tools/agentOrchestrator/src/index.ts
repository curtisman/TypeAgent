// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { loadConfig } from "./config.js";
export type { OrchestratorConfig, LaneConfig, NotifyConfig } from "./config.js";

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

export type { SpawnSpec, AgentDriver } from "./driver.js";
export { getDriver, registerDriver } from "./driver.js";

export type { LaneState, SessionEvents, SessionInfo } from "./session.js";
export { Session } from "./session.js";

export type {
    OrchestratorSession,
    PersistedLaneState,
} from "./orchestratorSession.js";
export {
    createSession,
    saveSession,
    loadSession,
    listSessions,
    sessionDir,
} from "./orchestratorSession.js";

// Register built-in drivers (side-effect imports).
import "./drivers/copilot.js";
import "./drivers/claude.js";
