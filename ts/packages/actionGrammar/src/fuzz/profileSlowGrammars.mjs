// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Profile harness for the "tail-call promote shapes" fuzz dimension.
 *
 * Two modes:
 *   - default: per-grammar wall-clock timing summary for all 40
 *     grammars in the dimension.
 *   - --grammar=N: skip prior grammars (generation only, RNG kept in
 *     lockstep) and validate just grammar N with a per-component
 *     breakdown so we can see which optimizer variant / step is slow.
 *
 * Run from `packages/actionGrammar`:
 *   node src/fuzz/profileSlowGrammars.mjs                   # all grammars, summary
 *   node src/fuzz/profileSlowGrammars.mjs --all             # print every grammar timing
 *   node src/fuzz/profileSlowGrammars.mjs --grammar=1       # validate g=1, dump it
 *   node src/fuzz/profileSlowGrammars.mjs --grammar=1 --quiet  # timing only
 */

import {
    DEFAULT_CONFIG,
    DEFAULT_OPTIMIZER_VARIANTS,
    MINIMAL_FEATURES,
    mergeFeatures,
    validateOptimizerEquivalence,
} from "../../dist/fuzz/fuzzHarness.js";
import {
    buildRandomGrammar,
    generateExtraInputs,
    makeRng,
} from "../../dist/fuzz/grammarGenerator.js";
import { loadGrammarRules } from "../../dist/grammarLoader.js";
import { matchGrammar } from "../../dist/grammarMatcher.js";

const SLOW_MS = 200;
const argv = process.argv.slice(2);
const args = new Set(argv);
const showAll = args.has("--all");
const quiet = args.has("--quiet");
const grammarArg = argv.find((a) => a.startsWith("--grammar="));
const onlyIdx =
    grammarArg !== undefined ? Number(grammarArg.split("=")[1]) : undefined;

// Tail-call promote dimension: matches the fuzz spec config.
const baseFeats = {
    partKinds: {
        literal: 1,
        ruleRef: 3,
        nestedRuleRef: 2,
        wildcard: 1,
        number: 1,
    },
    values: { attachProb: 0.7 },
};
const cfg = {
    ...DEFAULT_CONFIG,
    seed: 0xf022c,
    count: 40,
    features: mergeFeatures(MINIMAL_FEATURES, baseFeats),
    validations: ["optimizer", "roundtrip-text"],
};

const rng = makeRng(cfg.seed);

/**
 * Advance the RNG through one grammar's generation + extra-inputs
 * draw without paying the validation cost.  Mirrors what `runFuzz`
 * does so RNG stays in lockstep with the spec.
 */
function advanceOneGrammar() {
    const gen = buildRandomGrammar(rng, cfg.features, cfg.generator);
    const extraCount = Math.max(
        0,
        cfg.inputsPerGrammar - gen.testInputs.length,
    );
    const extras = generateExtraInputs(rng, extraCount, cfg.generator.words);
    return { gen, inputs: [...gen.testInputs, ...extras] };
}

/**
 * Per-component timing breakdown for a single grammar across all
 * configured optimizer variants.  Splits work into:
 *   - baseline compile (once)
 *   - per-variant: optimized compile, baseline match (per input),
 *     optimized match (per input)
 *
 * Calls `onRow(rowText)` after each variant finishes so progress is
 * visible incrementally, and `onInputRow(rowText)` for each input
 * within a variant.  Returns { totalMs, perVariant, baselineCompileMs }.
 */
function timedValidate(gen, inputs, onRow, onInputRow) {
    const loadOpts = {
        startValueRequired: gen.startValueRequired,
        enableValueExpressions: gen.usesValueExpressions,
    };

    const tBase0 = Date.now();
    const baseline = loadGrammarRules("fuzz.grammar", gen.text, loadOpts);
    const baselineCompileMs = Date.now() - tBase0;
    onRow(`  ${pad("baseline", 18)}  ${pad(baselineCompileMs + "ms", 8)}\n`);

    const perVariant = [];
    let totalMs = baselineCompileMs;

    for (const variant of DEFAULT_OPTIMIZER_VARIANTS) {
        const tCompile0 = Date.now();
        const optimized = loadGrammarRules("fuzz.grammar", gen.text, {
            ...loadOpts,
            optimizations: variant.options,
        });
        const compileMs = Date.now() - tCompile0;

        let baseMatchMs = 0;
        let optMatchMs = 0;
        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            const tB = Date.now();
            try {
                matchGrammar(baseline, input);
            } catch {
                // ignored - timing only
            }
            const bMs = Date.now() - tB;
            baseMatchMs += bMs;

            const tO = Date.now();
            try {
                matchGrammar(optimized, input);
            } catch {
                // ignored - timing only
            }
            const oMs = Date.now() - tO;
            optMatchMs += oMs;

            if (onInputRow) {
                onInputRow(
                    `      input[${pad(i, 2)}] base=${pad(bMs + "ms", 6)}  opt=${pad(oMs + "ms", 6)}  len=${input.length}\n`,
                );
            }
        }

        const variantTotal = compileMs + baseMatchMs + optMatchMs;
        perVariant.push({
            name: variant.name,
            compileMs,
            baseMatchMs,
            optMatchMs,
            totalMs: variantTotal,
        });
        totalMs += variantTotal;
        onRow(
            `  ${pad(variant.name, 18)}  ${pad(compileMs + "ms", 8)}  ${pad(baseMatchMs + "ms", 10)}  ${pad(optMatchMs + "ms", 9)}  ${pad(variantTotal + "ms", 7)}\n`,
        );
    }

    return { totalMs, baselineCompileMs, perVariant };
}

function pad(x, w) {
    return String(x).padStart(w);
}

if (onlyIdx !== undefined) {
    // Fast-skip prior grammars (generation only, no validation).
    for (let g = 0; g < onlyIdx; g++) advanceOneGrammar();

    const { gen, inputs } = advanceOneGrammar();

    const maxInputLen = Math.max(...inputs.map((s) => s.length));
    const ruleCount = gen.text.split(";").length - 1;
    process.stdout.write(
        `g=${onlyIdx}  rules=${ruleCount}  inputs=${inputs.length}  maxlen=${maxInputLen}\n`,
    );

    // Dump grammar + inputs up front so the user can copy them into a
    // repro script before the (potentially slow) timing run begins.
    if (!quiet) {
        process.stdout.write(
            `\n--- grammar ---\n${gen.text}\n--- inputs ---\n`,
        );
        for (const inp of inputs) {
            process.stdout.write(`  ${JSON.stringify(inp)}\n`);
        }
    }

    process.stdout.write(
        `\n  ${pad("variant", 18)}  ${pad("compile", 8)}  ${pad("baseMatch", 10)}  ${pad("optMatch", 9)}  ${pad("total", 7)}\n`,
    );

    const write = (s) => process.stdout.write(s);
    const breakdown = timedValidate(gen, inputs, write, write);

    process.stdout.write(
        `\nSum: ${breakdown.totalMs}ms (baselineCompile=${breakdown.baselineCompileMs}ms)\n`,
    );
} else {
    let totalMs = 0;
    const slow = [];
    for (let g = 0; g < cfg.count; g++) {
        const { gen, inputs } = advanceOneGrammar();
        const t0 = Date.now();
        validateOptimizerEquivalence(g, gen.text, inputs, gen);
        const dt = Date.now() - t0;
        totalMs += dt;
        const maxInputLen = Math.max(...inputs.map((s) => s.length));
        const ruleCount = gen.text.split(";").length - 1;
        if (showAll || dt > SLOW_MS) {
            slow.push({ g, dt, ruleCount, inputs: inputs.length, maxInputLen });
        }
    }
    process.stdout.write(
        `\nTotal: ${totalMs}ms across ${cfg.count} grammars\n`,
    );
    process.stdout.write(
        `Slow (>${SLOW_MS}ms): ${slow.length} grammars, ${slow.reduce((s, x) => s + x.dt, 0)}ms\n\n`,
    );
    for (const s of slow.sort((a, b) => b.dt - a.dt)) {
        process.stdout.write(
            `  g=${pad(s.g, 2)}  ${pad(s.dt + "ms", 7)}  rules=${s.ruleCount}  inputs=${s.inputs}  maxlen=${s.maxInputLen}\n`,
        );
    }
}
