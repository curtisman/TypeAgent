// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { loadConfig } from "../src/config.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Fixtures live in test/fixtures/ (source tree), not dist/test/fixtures/.
// When compiled, __dirname is dist/test/, so go up two levels to the
// package root, then into test/fixtures/.
const fixture = (name: string) =>
    resolve(__dirname, "..", "..", "test", "fixtures", name);

describe("loadConfig", () => {
    it("parses a valid 3-lane config", () => {
        const config = loadConfig(fixture("valid-config.yaml"));
        expect(config.repo).toBe("/home/user/src/TypeAgent3/ts");
        expect(config.base).toBe("grammartool");
        expect(config.lanes).toHaveLength(3);
        expect(config.notify.channel).toBe("ntfy");
        expect(config.notify.on).toEqual(["blocked", "failed", "done"]);
    });

    it("parses a minimal config with defaults", () => {
        const config = loadConfig(fixture("minimal-config.yaml"));
        expect(config.lanes).toHaveLength(1);
        expect(config.notify.channel).toBe("none");
        expect(config.notify.on).toEqual([]);
    });

    it("resolves prompt-file relative to the YAML file", () => {
        const config = loadConfig(fixture("valid-config.yaml"));
        const lane = config.lanes[0];
        const fixturesDir = resolve(__dirname, "..", "..", "test", "fixtures");
        expect(lane.promptFile).toBe(
            resolve(fixturesDir, "prompts", "L2-core.md"),
        );
    });

    it("preserves per-lane env overrides", () => {
        const config = loadConfig(fixture("valid-config.yaml"));
        const lane = config.lanes.find((l) => l.name === "L4-cli-scaffold");
        expect(lane?.env).toEqual({
            OPENAI_API_KEY: "$OPENAI_API_KEY_SECONDARY",
        });
    });

    it("preserves allow-tools list", () => {
        const config = loadConfig(fixture("valid-config.yaml"));
        const lane = config.lanes[0];
        expect(lane.allowTools).toEqual(["shell(pnpm *)", "read", "write"]);
    });

    it("throws on missing config file", () => {
        expect(() => loadConfig("/nonexistent/path.yaml")).toThrow();
    });

    it("throws on missing repo field", () => {
        expect(() => loadConfig(fixture("missing-repo.yaml"))).toThrow(
            '"repo" must be a non-empty string',
        );
    });

    it("throws on empty lanes array", () => {
        expect(() => loadConfig(fixture("no-lanes.yaml"))).toThrow(
            "must define at least one lane",
        );
    });

    it("throws on duplicate lane names", () => {
        expect(() => loadConfig(fixture("duplicate-names.yaml"))).toThrow(
            "Duplicate lane name",
        );
    });

    it("throws on duplicate lane branches", () => {
        expect(() => loadConfig(fixture("duplicate-branches.yaml"))).toThrow(
            "Duplicate lane branch",
        );
    });
});
