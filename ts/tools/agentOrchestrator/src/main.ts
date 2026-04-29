#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { loadConfig } from "./config.js";
import { resolve } from "path";

function main(): void {
    const configPath = process.argv[2];
    if (!configPath) {
        console.error("Usage: agent-orchestrator <lanes.yaml>");
        process.exit(1);
    }

    const fullPath = resolve(configPath);
    const config = loadConfig(fullPath);
    console.log(`Loaded ${config.lanes.length} lane(s) from ${fullPath}`);
}

main();
