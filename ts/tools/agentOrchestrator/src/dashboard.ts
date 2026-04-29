// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Session, LaneState } from "./session.js";
import type { OrchestratorConfig } from "./config.js";
import { worktreePath, commitCount } from "./worktree.js";

// --- ANSI escape helpers ---

const ESC = "\x1b";
const CLEAR = `${ESC}[H${ESC}[J`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;
const GRAY = `${ESC}[90m`;

function stateStyle(state: LaneState): string {
    switch (state) {
        case "IDLE":
            return `${GRAY}\u25CB ${state}${RESET}`;
        case "RUNNING":
            return `${GREEN}\u25CF ${state}${RESET}`;
        case "BLOCKED":
            return `${YELLOW}\u25C9 ${state}${RESET}`;
        case "DONE":
            return `${GREEN}${BOLD}\u2713 ${state}${RESET}`;
        case "FAILED":
            return `${RED}\u2717 ${state}${RESET}`;
        case "KILLED":
            return `${RED}${DIM}\u2717 ${state}${RESET}`;
        case "TIMED_OUT":
            return `${RED}${DIM}\u231B ${state}${RESET}`;
        case "PUSHED":
            return `${CYAN}\u2191 ${state}${RESET}`;
        case "ABANDONED":
            return `${GRAY}\u2717 ${state}${RESET}`;
    }
}

function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
        return `${h}h${String(m).padStart(2, "0")}m`;
    }
    if (m > 0) {
        return `${m}m${String(s).padStart(2, "0")}s`;
    }
    return `${s}s`;
}

/** Options for creating a Dashboard. */
export interface DashboardOptions {
    sessions: Session[];
    sessionId: string;
    config: OrchestratorConfig;
    baseDir?: string;
}

/** Ctrl-] byte: exits focus mode. */
const CTRL_CLOSE_BRACKET = 0x1d;

/**
 * Text-mode dashboard for the agent orchestrator.
 *
 * Renders lane status to stdout using ANSI escape codes on a
 * 500ms interval. Handles keyboard input in raw mode for lane
 * selection, focus mode, kill, and quit.
 */
export class Dashboard {
    private readonly sessions: Session[];
    private readonly sessionId: string;
    private readonly config: OrchestratorConfig;
    private readonly baseDir: string | undefined;

    private selectedIndex = 0;
    private focusedIndex: number | undefined = undefined;
    private renderTimer: ReturnType<typeof setInterval> | undefined = undefined;
    private commitTimer: ReturnType<typeof setInterval> | undefined = undefined;
    private commits: number[];
    private focusListener: ((lane: string, line: string) => void) | undefined =
        undefined;
    private inputHandler: ((data: Buffer) => void) | undefined = undefined;
    private _quitting = false;
    private _resolveDone: (() => void) | undefined = undefined;
    private readonly _done: Promise<void>;

    constructor(opts: DashboardOptions) {
        this.sessions = opts.sessions;
        this.sessionId = opts.sessionId;
        this.config = opts.config;
        this.baseDir = opts.baseDir;
        this.commits = new Array(opts.sessions.length).fill(0) as number[];
        this._done = new Promise<void>((resolve) => {
            this._resolveDone = resolve;
        });
    }

    /** Start rendering and keyboard handling. */
    start(): void {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        this.inputHandler = (data: Buffer) => this.handleInput(data);
        process.stdin.on("data", this.inputHandler);
        process.stdout.write(HIDE_CURSOR);

        this.renderTimer = setInterval(() => this.render(), 500);
        this.commitTimer = setInterval(() => {
            void this.updateCommits();
        }, 10_000);
        this.render();
        void this.updateCommits();
    }

    /** Promise that resolves when the user quits. */
    done(): Promise<void> {
        return this._done;
    }

    /** Graceful quit: stop rendering, shutdown active sessions. */
    async quit(): Promise<void> {
        if (this._quitting) {
            return;
        }
        this._quitting = true;
        this.stop();

        // Shutdown all active sessions
        const active = this.sessions.filter((s) => {
            const st = s.info.state;
            return st === "RUNNING" || st === "BLOCKED";
        });
        await Promise.all(active.map((s) => s.shutdown()));

        if (this._resolveDone !== undefined) {
            this._resolveDone();
        }
    }

    // --- Internal ---

    private stop(): void {
        if (this.renderTimer !== undefined) {
            clearInterval(this.renderTimer);
            this.renderTimer = undefined;
        }
        if (this.commitTimer !== undefined) {
            clearInterval(this.commitTimer);
            this.commitTimer = undefined;
        }
        this.exitFocus();
        if (this.inputHandler !== undefined) {
            process.stdin.removeListener("data", this.inputHandler);
            this.inputHandler = undefined;
        }
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        process.stdout.write(SHOW_CURSOR);
        process.stdout.write(CLEAR);
    }

    private render(): void {
        if (this.focusedIndex !== undefined) {
            return;
        }

        const cols = process.stdout.columns || 80;
        const n = this.sessions.length;
        let out = CLEAR;

        // Header
        out += `${BOLD}Agent Orchestrator${RESET}  ${this.sessionId}  ${n} lane(s)\n\n`;

        // Lane cards
        for (let i = 0; i < n; i++) {
            const info = this.sessions[i].info;
            const sel = i === this.selectedIndex;
            const prefix = sel ? `${BOLD}>` : " ";
            const suffix = sel ? RESET : "";
            const indicator = stateStyle(info.state);
            const elapsed = formatElapsed(info.elapsedMs);
            const commits = this.commits[i];

            out += `  ${prefix} ${i + 1}  ${info.name.padEnd(22)} ${indicator}  ${elapsed.padStart(8)}  ${commits} commit${commits !== 1 ? "s" : ""}${suffix}\n`;

            // Last output line, truncated
            const lastLine =
                info.recentOutput.length > 0
                    ? info.recentOutput[info.recentOutput.length - 1]
                    : "";
            const maxLen = cols - 8;
            const truncated =
                lastLine.length > maxLen
                    ? lastLine.slice(0, maxLen - 1) + "\u2026"
                    : lastLine;
            out += `       ${GRAY}${truncated}${RESET}\n\n`;
        }

        // Status bar
        const maxLane = Math.min(n, 9);
        out += `  ${DIM}[1-${maxLane}] select  [f]ocus  [k]ill  [q]uit${RESET}\n`;

        process.stdout.write(out);
    }

    private handleInput(data: Buffer): void {
        if (this.focusedIndex !== undefined) {
            this.handleFocusInput(data);
            return;
        }

        const key = data.toString();

        // Number keys for lane selection
        const num = parseInt(key, 10);
        if (!isNaN(num) && num >= 1 && num <= this.sessions.length) {
            this.selectedIndex = num - 1;
            this.render();
            return;
        }

        switch (key) {
            case "f":
                this.enterFocus();
                break;
            case "k":
                this.killSelected();
                break;
            case "q":
                void this.quit();
                break;
        }
    }

    private handleFocusInput(data: Buffer): void {
        // Ctrl-] exits focus mode
        if (data.length === 1 && data[0] === CTRL_CLOSE_BRACKET) {
            this.exitFocus();
            this.render();
            return;
        }

        // Pass through to the pty
        if (this.focusedIndex !== undefined) {
            const session = this.sessions[this.focusedIndex];
            const st = session.info.state;
            if (st === "RUNNING" || st === "BLOCKED") {
                session.write(data.toString());
            }
        }
    }

    private enterFocus(): void {
        const idx = this.selectedIndex;
        const session = this.sessions[idx];
        const info = session.info;

        this.focusedIndex = idx;
        process.stdout.write(CLEAR);

        // Header
        const indicator = stateStyle(info.state);
        const elapsed = formatElapsed(info.elapsedMs);
        process.stdout.write(
            `${BOLD}Focus: ${info.name}${RESET}  ${indicator}  ${elapsed}  ${DIM}Ctrl-] to exit${RESET}\n`,
        );
        process.stdout.write(`${DIM}${"─".repeat(60)}${RESET}\n`);

        // Show recent output
        for (const line of info.recentOutput) {
            process.stdout.write(line + "\n");
        }

        // Stream live output
        this.focusListener = (lane: string, line: string) => {
            if (lane === info.name && this.focusedIndex === idx) {
                process.stdout.write(line + "\n");
            }
        };
        session.on("output", this.focusListener);
    }

    private exitFocus(): void {
        if (this.focusedIndex === undefined) {
            return;
        }
        const session = this.sessions[this.focusedIndex];
        if (this.focusListener !== undefined) {
            session.removeListener("output", this.focusListener);
            this.focusListener = undefined;
        }
        this.focusedIndex = undefined;
    }

    private killSelected(): void {
        const session = this.sessions[this.selectedIndex];
        const st = session.info.state;
        if (st === "RUNNING" || st === "BLOCKED") {
            session.kill();
        }
    }

    private async updateCommits(): Promise<void> {
        for (let i = 0; i < this.sessions.length; i++) {
            const lane = this.config.lanes[i];
            const wtPath = worktreePath(
                this.config.repo,
                lane.name,
                this.sessionId,
                this.baseDir,
            );
            try {
                this.commits[i] = await commitCount(wtPath, this.config.base);
            } catch {
                // Worktree may not exist yet or lane still IDLE
            }
        }
    }
}
