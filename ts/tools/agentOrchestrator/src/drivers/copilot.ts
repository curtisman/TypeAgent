// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LaneConfig } from "../config.js";
import type { AgentDriver, SpawnSpec } from "../driver.js";
import { registerDriver } from "../driver.js";

/**
 * Session ID pattern for Copilot CLI.
 * Copilot prints something like: "Session ID: abc123-def456"
 */
const SESSION_ID_RE = /Session ID:\s*(\S+)/i;

const copilotDriver: AgentDriver = {
    name: "copilot",
    supportsToolAllowList: true,
    supportsSessionResume: true,

    buildCommand(config: LaneConfig, promptText: string): SpawnSpec {
        const args: string[] = ["-p", promptText];
        if (config.allowTools !== undefined) {
            for (const tool of config.allowTools) {
                args.push("--allow-tool", tool);
            }
        }
        const spec: SpawnSpec = { file: "copilot", args };
        if (config.env !== undefined) {
            spec.env = config.env;
        }
        return spec;
    },

    buildResumeCommand(
        config: LaneConfig,
        sessionId?: string,
        followUp?: string,
    ): SpawnSpec | null {
        const args: string[] = [];
        if (sessionId !== undefined) {
            args.push("--resume", sessionId);
        } else {
            args.push("--continue");
        }
        if (followUp !== undefined) {
            args.push("-p", followUp);
        }
        if (config.allowTools !== undefined) {
            for (const tool of config.allowTools) {
                args.push("--allow-tool", tool);
            }
        }
        const spec: SpawnSpec = { file: "copilot", args };
        if (config.env !== undefined) {
            spec.env = config.env;
        }
        return spec;
    },

    extractSessionId(outputLines: string[]): string | undefined {
        for (let i = outputLines.length - 1; i >= 0; i--) {
            const match = SESSION_ID_RE.exec(outputLines[i]);
            if (match !== null) {
                return match[1];
            }
        }
        return undefined;
    },
};

registerDriver(copilotDriver);

export default copilotDriver;
