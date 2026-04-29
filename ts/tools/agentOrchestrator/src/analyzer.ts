// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Signal emitted by the output analyzer for a single line. */
export type Signal =
    | { kind: "progress"; summary: string }
    | { kind: "blocked"; reason: string }
    | { kind: "error"; message: string }
    | { kind: "milestone"; description: string }
    | { kind: "noise" };

// Patterns tested in priority order: blocked > error > milestone > progress.

/** Strip ANSI escape sequences so regexes match colored pty output. */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, "");
}

const BLOCKED_RE = /permission|approve|confirm|do you want|y\/n|\byes\/no\b/i;

const ERROR_RE = /\bError\b|FAIL|\bpanic\b|Traceback/;

const MILESTONE_RE =
    /tests?\s+pass|\d+\s+passed|build succeeded|\u2713|commit|pushed|merged/i;

const PROGRESS_RE =
    /created?\s+file|wrote\b|editing\b|modified\b|deleted\b|running\b|executing\b|pnpm\b|npm run\b|node /i;

/**
 * Classify a single output line into a signal.
 * Pure function, no side effects.
 *
 * Priority: blocked > error > milestone > progress > noise.
 */
export function analyzeLine(line: string): Signal {
    const clean = stripAnsi(line);
    if (clean.length === 0) {
        return { kind: "noise" };
    }

    let m: RegExpExecArray | null;

    m = BLOCKED_RE.exec(clean);
    if (m !== null) {
        return { kind: "blocked", reason: m[0] };
    }

    m = ERROR_RE.exec(clean);
    if (m !== null) {
        return { kind: "error", message: m[0] };
    }

    m = MILESTONE_RE.exec(clean);
    if (m !== null) {
        return { kind: "milestone", description: m[0] };
    }

    m = PROGRESS_RE.exec(clean);
    if (m !== null) {
        return { kind: "progress", summary: m[0] };
    }

    return { kind: "noise" };
}
