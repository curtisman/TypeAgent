// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Minimal repro for the slow-match case found via
 * `profileSlowGrammars.mjs --grammar=1`.  Loads a single hard-coded
 * grammar, then times `matchGrammar` for each input.
 *
 * Run from `packages/actionGrammar`:
 *   node src/fuzz/reproSlowMatch.mjs
 *
 * Edit GRAMMAR / INPUTS below with the dumped output from
 * `profileSlowGrammars.mjs --grammar=1` (without --quiet).
 */

import { loadGrammarRules } from "../../dist/grammarLoader.js";
import { matchGrammar } from "../../dist/grammarMatcher.js";
import { compileGrammarToNFA } from "../../dist/nfaCompiler.js";
import { compileNFAToDFA } from "../../dist/dfaCompiler.js";
import { matchGrammarWithNFA, tokenizeRequest } from "../../dist/nfaMatcher.js";
import { matchDFAWithSplitting } from "../../dist/dfaMatcher.js";

// ── Paste grammar text here ──────────────────────────────────────────────────
const GRAMMAR = `<Start> = <R0>;
<R0> = <R1> <R2> <R1> <R1> | <R1> <R1> <R2> | <R3> <R2> <R2> <R3> | e;
<R1> = $(v1:string) c <R2> <R2> -> ({ k: v1 }).k | <R3> <R3> | <R2> $(n2:number) <R2> <R2> -> (6 + 6) * 3 | $(v3:string) $(v4:string) <R2>;
<R2> = <R3> <R3> <R3>;
<R3> = $(v0:string) b a e;
`;

// ── Paste inputs here (one per array entry) ──────────────────────────────────
const INPUTS = [
    // truncated prefix (slow case)
    "a c b b a e b b a e b b a e b b a e b b a e b b a e b b a e b b a e b b a e a c b b a e b b a e b b a e b b a e b b a e b b a e a c b b a e b b a e b b a e b b a e b b a e b b a",
];

// ── Load options: tweak to mirror the dumped grammar ─────────────────────────
const LOAD_OPTS = {
    startValueRequired: false,
    enableValueExpressions: true,
};

const grammar = loadGrammarRules("repro.grammar", GRAMMAR, LOAD_OPTS);

const nfaCompileT0 = Date.now();
const nfa = compileGrammarToNFA(grammar, "repro");
const nfaCompileMs = Date.now() - nfaCompileT0;

const dfaCompileT0 = Date.now();
const dfa = compileNFAToDFA(nfa, "repro");
const dfaCompileMs = Date.now() - dfaCompileT0;

process.stdout.write(
    `compile: NFA ${nfaCompileMs}ms (states=${nfa.states.length})  ` +
        `DFA ${dfaCompileMs}ms (states=${dfa.states.length})\n`,
);

function time(label, fn) {
    const t0 = Date.now();
    let result, error;
    try {
        result = fn();
    } catch (e) {
        error = e.message;
    }
    const dt = Date.now() - t0;
    return { label, dt, result, error };
}

for (let i = 0; i < INPUTS.length; i++) {
    const input = INPUTS[i];
    const tokens = tokenizeRequest(input);
    process.stdout.write(
        `\ninput[${i}] len=${input.length} tokens=${tokens.length}\n`,
    );

    const runs = [
        time("matchGrammar", () => matchGrammar(grammar, input)),
        time("matchGrammarWithNFA", () =>
            matchGrammarWithNFA(grammar, nfa, input),
        ),
        time("matchDFA", () => matchDFAWithSplitting(dfa, tokens)),
    ];

    for (const r of runs) {
        const count = Array.isArray(r.result)
            ? r.result.length
            : r.result?.matched
              ? 1
              : 0;
        process.stdout.write(
            `  ${r.label.padEnd(22)} ${String(r.dt).padStart(7)}ms  ` +
                `matches=${count}` +
                `${r.error ? "  ERROR: " + r.error : ""}\n`,
        );
    }
}
