// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LaneConfig } from "./config.js";

/** Command specification for spawning an agent process. */
export interface SpawnSpec {
    /** Executable name or path. */
    file: string;
    /** Command-line arguments. */
    args: string[];
    /** Optional environment variable overrides. */
    env?: Record<string, string>;
}

/** Abstract interface for agent CLI drivers. */
export interface AgentDriver {
    /** Human-readable driver name (e.g. "copilot", "claude"). */
    readonly name: string;

    /** Whether this driver supports --allow-tool style pre-auth. */
    readonly supportsToolAllowList: boolean;

    /** Whether this driver supports session resume. */
    readonly supportsSessionResume: boolean;

    /** Build the spawn command for a fresh agent session. */
    buildCommand(config: LaneConfig, promptText: string): SpawnSpec;

    /**
     * Build a resume command. Returns null if not supported.
     * @param config - Lane configuration.
     * @param sessionId - Captured from the agent's exit output.
     * @param followUp - Optional follow-up instructions.
     */
    buildResumeCommand(
        config: LaneConfig,
        sessionId?: string,
        followUp?: string,
    ): SpawnSpec | null;

    /**
     * Extract a session ID from the agent's output buffer.
     * Called after process exit to capture the ID for resume.
     * Returns undefined if no session ID is found.
     */
    extractSessionId(outputLines: string[]): string | undefined;
}

/** Internal registry of known drivers. */
const drivers = new Map<string, AgentDriver>();

/** Register a driver in the internal registry. */
export function registerDriver(driver: AgentDriver): void {
    drivers.set(driver.name, driver);
}

/** Look up a driver by name. Throws if unknown. */
export function getDriver(name: string): AgentDriver {
    const driver = drivers.get(name);
    if (driver === undefined) {
        throw new Error(`Unknown agent driver: "${name}"`);
    }
    return driver;
}
