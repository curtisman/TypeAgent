// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EventEmitter } from "events";
import * as pty from "node-pty";
import type { LaneConfig } from "./config.js";
import type { AgentDriver } from "./driver.js";

/** Possible states in the lane state machine. */
export type LaneState =
    | "IDLE"
    | "RUNNING"
    | "BLOCKED"
    | "DONE"
    | "FAILED"
    | "KILLED"
    | "TIMED_OUT"
    | "PUSHED"
    | "ABANDONED";

/** Events emitted by a Session. */
export interface SessionEvents {
    /** Emitted on every state transition. */
    stateChange: (lane: string, from: LaneState, to: LaneState) => void;
    /** Emitted for every output line from the pty. */
    output: (lane: string, line: string) => void;
}

/** Read-only snapshot of session state. */
export interface SessionInfo {
    /** Lane name. */
    readonly name: string;
    /** Current state. */
    readonly state: LaneState;
    /** Elapsed time in milliseconds since spawn. */
    readonly elapsedMs: number;
    /** Last N output lines (ring buffer). */
    readonly recentOutput: readonly string[];
    /** Captured session ID (if agent printed one on exit). */
    readonly sessionId: string | undefined;
    /** Exit code (set after process exit). */
    readonly exitCode: number | undefined;
}

/** Maximum number of output lines kept in the ring buffer. */
const OUTPUT_BUFFER_SIZE = 100;

/** Grace period (ms) after SIGTERM before sending SIGKILL. */
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Manages a single agent process in a pty with a state machine.
 *
 * Usage:
 *   const session = new Session(lane, driver, wtPath, baseBranch);
 *   session.on("stateChange", (name, from, to) => { ... });
 *   session.on("output", (name, line) => { ... });
 *   session.spawn(promptText);
 */
export class Session extends EventEmitter {
    private readonly lane: LaneConfig;
    private readonly driver: AgentDriver;
    private readonly wtPath: string;

    private _state: LaneState = "IDLE";
    private _elapsedMs: number = 0;
    private _spawnTime: number = 0;
    private _recentOutput: string[] = [];
    private _sessionId: string | undefined = undefined;
    private _exitCode: number | undefined = undefined;
    private _partialLine: string = "";
    private _ptyProcess: pty.IPty | undefined = undefined;
    private _silenceTimer: ReturnType<typeof setTimeout> | undefined =
        undefined;
    private _timeoutMs: number | undefined = undefined;

    constructor(
        lane: LaneConfig,
        driver: AgentDriver,
        wtPath: string,
        _baseBranch: string,
    ) {
        super();
        this.lane = lane;
        this.driver = driver;
        this.wtPath = wtPath;
        this._timeoutMs = parseTimeout(lane.timeout);
    }

    /** Current session info snapshot. */
    get info(): SessionInfo {
        const elapsedMs =
            this._state === "RUNNING" || this._state === "BLOCKED"
                ? performance.now() - this._spawnTime
                : this._elapsedMs;
        return {
            name: this.lane.name,
            state: this._state,
            elapsedMs,
            recentOutput: this._recentOutput,
            sessionId: this._sessionId,
            exitCode: this._exitCode,
        };
    }

    /** Spawn the agent process. Transitions IDLE -> RUNNING. */
    spawn(promptText: string): void {
        this.assertStates("spawn", "IDLE");
        const spec = this.driver.buildCommand(this.lane, promptText);
        this.startProcess(spec);
    }

    /** Write input to the pty (for focus mode type-through). */
    write(input: string): void {
        if (this._ptyProcess === undefined) {
            throw new Error(`Cannot write: no process running`);
        }
        this._ptyProcess.write(input);
    }

    /** Force-kill the process. Transitions RUNNING/BLOCKED -> KILLED. */
    kill(): void {
        this.assertStates("kill", "RUNNING", "BLOCKED");
        this.clearSilenceTimer();
        if (this._ptyProcess !== undefined) {
            this._ptyProcess.kill("SIGKILL");
        }
        // State transition happens in onExit handler, but we set KILLED
        // explicitly since SIGKILL may not produce a clean exit.
        this.transition("KILLED");
        this.finalizeElapsed();
    }

    /**
     * Graceful shutdown: SIGTERM, wait grace period, then SIGKILL.
     * Returns a promise that resolves when the process exits.
     */
    shutdown(): Promise<void> {
        if (this._state !== "RUNNING" && this._state !== "BLOCKED") {
            return Promise.resolve();
        }
        this.clearSilenceTimer();
        return new Promise<void>((resolve) => {
            if (this._ptyProcess === undefined) {
                resolve();
                return;
            }

            const proc = this._ptyProcess;
            let resolved = false;

            const onDone = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(graceTimer);
                    resolve();
                }
            };

            // Listen for process exit
            proc.onExit(() => onDone());

            // Send SIGTERM
            proc.kill("SIGTERM");

            // After grace period, force kill
            const graceTimer = setTimeout(() => {
                if (!resolved) {
                    proc.kill("SIGKILL");
                }
            }, SHUTDOWN_GRACE_MS);
        });
    }

    /**
     * Re-spawn with session resume (--continue/--resume <id>).
     * Transitions DONE/FAILED/KILLED/TIMED_OUT -> RUNNING.
     */
    resume(followUp?: string): void {
        this.assertStates("resume", "DONE", "FAILED", "KILLED", "TIMED_OUT");
        const spec = this.driver.buildResumeCommand(
            this.lane,
            this._sessionId,
            followUp,
        );
        if (spec === null) {
            throw new Error(
                `Driver "${this.driver.name}" does not support resume`,
            );
        }
        this.startProcess(spec);
    }

    /**
     * Re-spawn from scratch with a new prompt.
     * Transitions DONE/FAILED/KILLED/TIMED_OUT -> RUNNING.
     */
    retry(promptText: string): void {
        this.assertStates("retry", "DONE", "FAILED", "KILLED", "TIMED_OUT");
        const spec = this.driver.buildCommand(this.lane, promptText);
        this.startProcess(spec);
    }

    // --- Internal helpers ---

    private startProcess(spec: import("./driver.js").SpawnSpec): void {
        this._exitCode = undefined;
        this._partialLine = "";
        this._spawnTime = performance.now();
        this._elapsedMs = 0;

        const env: Record<string, string> = {
            ...process.env,
            ...(spec.env ?? {}),
        } as Record<string, string>;

        this._ptyProcess = pty.spawn(spec.file, spec.args, {
            name: "xterm-256color",
            cols: 120,
            rows: 40,
            cwd: this.wtPath,
            env,
        });

        this.transition("RUNNING");
        this.resetSilenceTimer();

        this._ptyProcess.onData((data: string) => {
            this.handleData(data);
        });

        this._ptyProcess.onExit(
            ({ exitCode }: { exitCode: number; signal?: number }) => {
                this.handleExit(exitCode);
            },
        );
    }

    private handleData(data: string): void {
        // Split on newlines, buffering partial lines
        const chunks = (this._partialLine + data).split("\n");
        // Last element is the partial (incomplete) line
        this._partialLine = chunks.pop() ?? "";

        for (const line of chunks) {
            this.pushOutput(line);
            this.emit("output", this.lane.name, line);
        }

        // Reset silence timer on any output
        if (chunks.length > 0) {
            this.resetSilenceTimer();
        }
    }

    private handleExit(exitCode: number): void {
        this.clearSilenceTimer();

        // Flush any remaining partial line
        if (this._partialLine.length > 0) {
            this.pushOutput(this._partialLine);
            this.emit("output", this.lane.name, this._partialLine);
            this._partialLine = "";
        }

        this._exitCode = exitCode;
        this._ptyProcess = undefined;

        // Extract session ID from recent output
        this._sessionId =
            this.driver.extractSessionId(this._recentOutput) ?? this._sessionId;

        this.finalizeElapsed();

        // Only transition if still RUNNING/BLOCKED (kill() may have
        // already transitioned to KILLED)
        if (this._state === "RUNNING" || this._state === "BLOCKED") {
            if (exitCode === 0) {
                this.transition("DONE");
            } else {
                this.transition("FAILED");
            }
        }
    }

    private pushOutput(line: string): void {
        this._recentOutput.push(line);
        if (this._recentOutput.length > OUTPUT_BUFFER_SIZE) {
            this._recentOutput.shift();
        }
    }

    private transition(to: LaneState): void {
        const from = this._state;
        this._state = to;
        this.emit("stateChange", this.lane.name, from, to);
    }

    private finalizeElapsed(): void {
        if (this._spawnTime > 0) {
            this._elapsedMs = performance.now() - this._spawnTime;
        }
    }

    private resetSilenceTimer(): void {
        this.clearSilenceTimer();
        if (this._timeoutMs !== undefined && this._timeoutMs > 0) {
            this._silenceTimer = setTimeout(() => {
                if (this._state === "RUNNING" || this._state === "BLOCKED") {
                    // Timeout: kill the process
                    if (this._ptyProcess !== undefined) {
                        this._ptyProcess.kill("SIGTERM");
                        setTimeout(() => {
                            if (this._ptyProcess !== undefined) {
                                this._ptyProcess.kill("SIGKILL");
                            }
                        }, SHUTDOWN_GRACE_MS);
                    }
                    this.transition("TIMED_OUT");
                    this.finalizeElapsed();
                }
            }, this._timeoutMs);
        }
    }

    private clearSilenceTimer(): void {
        if (this._silenceTimer !== undefined) {
            clearTimeout(this._silenceTimer);
            this._silenceTimer = undefined;
        }
    }

    private assertStates(action: string, ...allowed: LaneState[]): void {
        if (!allowed.includes(this._state)) {
            throw new Error(
                `Cannot ${action} in state ${this._state} (expected ${allowed.join(" | ")})`,
            );
        }
    }
}

/**
 * Parse a timeout string like "30m", "1h", "90s" into milliseconds.
 * Returns undefined if the input is undefined or empty.
 */
function parseTimeout(timeout: string | undefined): number | undefined {
    if (timeout === undefined || timeout.length === 0) {
        return undefined;
    }
    const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)$/i.exec(timeout);
    if (match === null) {
        throw new Error(
            `Invalid timeout format: "${timeout}" (expected e.g. "30m", "1h", "90s")`,
        );
    }
    const value = parseFloat(match[1]);
    switch (match[2].toLowerCase()) {
        case "s":
            return value * 1000;
        case "m":
            return value * 60 * 1000;
        case "h":
            return value * 60 * 60 * 1000;
        default:
            return undefined;
    }
}
