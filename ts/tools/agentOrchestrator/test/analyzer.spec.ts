// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { analyzeLine } from "../src/analyzer.js";

describe("output analyzer", () => {
    // --- BLOCKED signals (highest priority) ---

    it("detects tool approval prompt as blocked", () => {
        const sig = analyzeLine("Do you want to run this tool?");
        expect(sig.kind).toBe("blocked");
    });

    it("detects Y/N confirmation as blocked", () => {
        const sig = analyzeLine("Continue? (y/n)");
        expect(sig.kind).toBe("blocked");
    });

    it("detects permission request as blocked", () => {
        const sig = analyzeLine("Permission to write to file.ts");
        expect(sig.kind).toBe("blocked");
    });

    // --- ERROR signals ---

    it("detects error keyword", () => {
        const sig = analyzeLine("Error: ENOENT no such file");
        expect(sig.kind).toBe("error");
    });

    it("detects FAIL keyword", () => {
        const sig = analyzeLine("FAIL  src/test.spec.ts");
        expect(sig.kind).toBe("error");
    });

    it("detects Traceback", () => {
        const sig = analyzeLine("Traceback (most recent call last):");
        expect(sig.kind).toBe("error");
    });

    it("detects panic", () => {
        const sig = analyzeLine("panic: runtime error");
        expect(sig.kind).toBe("error");
    });

    // --- PROGRESS signals ---

    it("detects file creation as progress", () => {
        const sig = analyzeLine("Created file src/index.ts");
        expect(sig.kind).toBe("progress");
    });

    it("detects file edit as progress", () => {
        const sig = analyzeLine("Editing src/config.ts");
        expect(sig.kind).toBe("progress");
    });

    it("detects npm run as progress", () => {
        const sig = analyzeLine("running npm run build");
        expect(sig.kind).toBe("progress");
    });

    // --- MILESTONE signals ---

    it("detects test pass as milestone", () => {
        const sig = analyzeLine("Tests: 5 passed, 5 total");
        expect(sig.kind).toBe("milestone");
    });

    it("detects build success as milestone", () => {
        const sig = analyzeLine("build succeeded");
        expect(sig.kind).toBe("milestone");
    });

    it("detects commit as milestone", () => {
        const sig = analyzeLine("committed changes to main");
        expect(sig.kind).toBe("milestone");
    });

    // --- NOISE ---

    it("returns noise for unrecognized line", () => {
        const sig = analyzeLine("thinking about the problem...");
        expect(sig.kind).toBe("noise");
    });

    it("returns noise for empty string", () => {
        const sig = analyzeLine("");
        expect(sig.kind).toBe("noise");
    });

    // --- Priority tests ---

    it("blocked takes priority over progress", () => {
        // "Do you want to run npm install?" matches both blocked and progress
        const sig = analyzeLine("Do you want to run npm install?");
        expect(sig.kind).toBe("blocked");
    });

    it("error takes priority over progress", () => {
        // "Error running npm run build" matches both error and progress
        const sig = analyzeLine("Error running npm run build");
        expect(sig.kind).toBe("error");
    });
});
