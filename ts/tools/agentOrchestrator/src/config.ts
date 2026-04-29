// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { parse as parseYaml } from "yaml";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";

/** Notification channel configuration. */
export interface NotifyConfig {
    /** Channel type. */
    channel: "ntfy" | "desktop" | "webhook" | "none";
    /** ntfy topic name, or webhook URL. */
    topic?: string;
    /** Which events trigger notifications. */
    on: Array<"blocked" | "failed" | "done" | "error">;
}

/** Per-lane configuration. */
export interface LaneConfig {
    /** Human-readable lane name (used in dashboard and worktree dir). */
    name: string;
    /** Git branch name to create for this lane's worktree. */
    branch: string;
    /** Agent driver name (e.g. "copilot", "claude"). */
    agent: string;
    /** Absolute path to the prompt file. Resolved from YAML-relative path. */
    promptFile: string;
    /** Timeout duration string (e.g. "30m", "1h"). */
    timeout?: string;
    /** Tool allow-list passed to the agent CLI. */
    allowTools?: string[];
    /** Per-lane environment variable overrides. */
    env?: Record<string, string>;
}

/** Top-level orchestrator configuration. */
export interface OrchestratorConfig {
    /** Absolute path to the repository root. */
    repo: string;
    /** Base branch to create worktrees from. */
    base: string;
    /** Notification settings. */
    notify: NotifyConfig;
    /** Lane definitions. */
    lanes: LaneConfig[];
}

/**
 * Load and validate an orchestrator config from a YAML file.
 * Resolves relative paths (prompt-file) against the YAML file's directory.
 */
export function loadConfig(configPath: string): OrchestratorConfig {
    const raw = readFileSync(configPath, "utf-8");
    const doc = parseYaml(raw);
    return validateConfig(doc, dirname(configPath));
}

function requireString(obj: Record<string, unknown>, key: string): string {
    const value = obj[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`"${key}" must be a non-empty string`);
    }
    return value;
}

function validateNotify(raw: unknown): NotifyConfig {
    if (raw === undefined || raw === null) {
        return { channel: "none", on: [] };
    }
    if (typeof raw !== "object") {
        throw new Error(`"notify" must be an object`);
    }
    const obj = raw as Record<string, unknown>;
    const channel = requireString(obj, "channel");
    const validChannels = ["ntfy", "desktop", "webhook", "none"];
    if (!validChannels.includes(channel)) {
        throw new Error(
            `"notify.channel" must be one of: ${validChannels.join(", ")}`,
        );
    }
    const on = validateEventList(obj["on"]);
    const result: NotifyConfig = {
        channel: channel as NotifyConfig["channel"],
        on,
    };
    if (typeof obj["topic"] === "string") {
        result.topic = obj["topic"];
    }
    return result;
}

function validateEventList(
    raw: unknown,
): Array<"blocked" | "failed" | "done" | "error"> {
    if (!Array.isArray(raw)) {
        return [];
    }
    const valid = ["blocked", "failed", "done", "error"];
    for (const item of raw) {
        if (typeof item !== "string" || !valid.includes(item)) {
            throw new Error(
                `Invalid notify event "${item}". Must be one of: ${valid.join(", ")}`,
            );
        }
    }
    return raw as Array<"blocked" | "failed" | "done" | "error">;
}

function validateLanes(raw: unknown, baseDir: string): LaneConfig[] {
    if (!Array.isArray(raw)) {
        throw new Error(`"lanes" must be an array`);
    }
    const names = new Set<string>();
    const branches = new Set<string>();
    return raw.map((item, index) => {
        if (typeof item !== "object" || item === null) {
            throw new Error(`Lane at index ${index} must be an object`);
        }
        const obj = item as Record<string, unknown>;
        const name = requireString(obj, "name");
        if (names.has(name)) {
            throw new Error(`Duplicate lane name: "${name}"`);
        }
        names.add(name);

        const branch = requireString(obj, "branch");
        if (branches.has(branch)) {
            throw new Error(`Duplicate lane branch: "${branch}"`);
        }
        branches.add(branch);

        const agent = requireString(obj, "agent");
        const promptFileRel = requireString(obj, "prompt-file");
        const promptFile = resolve(baseDir, promptFileRel);

        const lane: LaneConfig = {
            name,
            branch,
            agent,
            promptFile,
        };
        if (typeof obj["timeout"] === "string") {
            lane.timeout = obj["timeout"];
        }
        if (Array.isArray(obj["allow-tools"])) {
            lane.allowTools = obj["allow-tools"] as string[];
        }
        if (typeof obj["env"] === "object" && obj["env"] !== null) {
            lane.env = obj["env"] as Record<string, string>;
        }
        return lane;
    });
}

function validateConfig(doc: unknown, baseDir: string): OrchestratorConfig {
    if (typeof doc !== "object" || doc === null) {
        throw new Error("Config must be a YAML object");
    }

    const obj = doc as Record<string, unknown>;

    const repo = requireString(obj, "repo");
    const base = requireString(obj, "base");
    const notify = validateNotify(obj["notify"]);
    const lanes = validateLanes(obj["lanes"], baseDir);

    if (lanes.length === 0) {
        throw new Error("Config must define at least one lane");
    }

    return { repo, base, notify, lanes };
}
