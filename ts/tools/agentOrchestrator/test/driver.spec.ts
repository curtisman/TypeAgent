// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getDriver } from "../src/driver.js";
// Side-effect imports to register drivers.
import "../src/drivers/copilot.js";
import "../src/drivers/claude.js";

import type { LaneConfig } from "../src/config.js";

function makeLane(overrides?: Partial<LaneConfig>): LaneConfig {
    const base: LaneConfig = {
        name: "test-lane",
        branch: "orch/test",
        agent: "copilot",
        promptFile: "/tmp/prompt.md",
    };
    return { ...base, ...overrides };
}

describe("copilot driver", () => {
    const driver = getDriver("copilot");

    it("buildCommand includes -p and prompt text", () => {
        const spec = driver.buildCommand(makeLane(), "do stuff");
        expect(spec.file).toBe("copilot");
        expect(spec.args).toContain("-p");
        const pIdx = spec.args.indexOf("-p");
        expect(spec.args[pIdx + 1]).toBe("do stuff");
    });

    it("buildCommand includes --allow-tool flags", () => {
        const lane = makeLane({ allowTools: ["tool-a", "tool-b"] });
        const spec = driver.buildCommand(lane, "do stuff");
        const toolArgs = spec.args.reduce<string[]>((acc, arg, i, arr) => {
            if (arg === "--allow-tool" && i + 1 < arr.length) {
                acc.push(arr[i + 1]);
            }
            return acc;
        }, []);
        expect(toolArgs).toEqual(["tool-a", "tool-b"]);
    });

    it("buildCommand omits --allow-tool when empty", () => {
        const spec = driver.buildCommand(makeLane(), "do stuff");
        expect(spec.args).not.toContain("--allow-tool");
    });

    it("buildResumeCommand with session ID", () => {
        const spec = driver.buildResumeCommand(makeLane(), "sess-123");
        expect(spec).not.toBeNull();
        expect(spec!.args).toContain("--resume");
        const rIdx = spec!.args.indexOf("--resume");
        expect(spec!.args[rIdx + 1]).toBe("sess-123");
    });

    it("buildResumeCommand without ID uses --continue", () => {
        const spec = driver.buildResumeCommand(makeLane());
        expect(spec).not.toBeNull();
        expect(spec!.args).toContain("--continue");
        expect(spec!.args).not.toContain("--resume");
    });

    it("extractSessionId finds ID in output", () => {
        const lines = [
            "Working on task...",
            "Session ID: abc-123-def",
            "Done.",
        ];
        expect(driver.extractSessionId(lines)).toBe("abc-123-def");
    });

    it("extractSessionId returns undefined on miss", () => {
        const lines = ["Working on task...", "Done."];
        expect(driver.extractSessionId(lines)).toBeUndefined();
    });
});

describe("claude driver", () => {
    const driver = getDriver("claude");

    it("buildCommand includes -p and prompt text", () => {
        const lane = makeLane({ agent: "claude" });
        const spec = driver.buildCommand(lane, "do stuff");
        expect(spec.file).toBe("claude");
        expect(spec.args).toContain("-p");
        const pIdx = spec.args.indexOf("-p");
        expect(spec.args[pIdx + 1]).toBe("do stuff");
    });

    it("buildCommand includes --allowedTools", () => {
        const lane = makeLane({
            agent: "claude",
            allowTools: ["tool-a", "tool-b"],
        });
        const spec = driver.buildCommand(lane, "do stuff");
        expect(spec.args).toContain("--allowedTools");
        const tIdx = spec.args.indexOf("--allowedTools");
        expect(spec.args.slice(tIdx + 1, tIdx + 3)).toEqual([
            "tool-a",
            "tool-b",
        ]);
    });

    it("buildResumeCommand with session ID", () => {
        const lane = makeLane({ agent: "claude" });
        const spec = driver.buildResumeCommand(lane, "sess-456");
        expect(spec).not.toBeNull();
        expect(spec!.args).toContain("--resume");
        const rIdx = spec!.args.indexOf("--resume");
        expect(spec!.args[rIdx + 1]).toBe("sess-456");
    });

    it("buildResumeCommand without ID uses --continue", () => {
        const lane = makeLane({ agent: "claude" });
        const spec = driver.buildResumeCommand(lane);
        expect(spec).not.toBeNull();
        expect(spec!.args).toContain("--continue");
    });

    it("getDriver returns copilot driver", () => {
        expect(getDriver("copilot").name).toBe("copilot");
    });

    it("getDriver throws on unknown name", () => {
        expect(() => getDriver("unknown-agent")).toThrow(/unknown/i);
    });
});
