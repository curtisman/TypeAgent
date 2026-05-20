// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { TaskRegistry } from "./taskRegistry.js";
export { WorkflowEngine, RunResult, RunOptions } from "./runner.js";
export { WorkflowEvent, WorkflowEventListener } from "./events.js";
export {
    intAdd,
    intLessThan,
    listLength,
    listElementAt,
    listAppend,
    boolToLabel,
    shellExec,
    llmGenerate,
    copilotInvoke,
    httpGet,
    fileRead,
    fileWrite,
    textTemplate,
    stringJoin,
    stringSplit,
    standardLibraryTasks,
    allBuiltinTasks,
} from "./builtinTasks.js";

// TODO: The @github/copilot-sdk dependency hints that copilotInvoke may be
//       a good first candidate for an external task.
export {
    setCopilotClientFactory,
    resetCopilotClientFactory,
    shutdownCopilotHost,
    type CopilotClientFactory,
    type MinimalCopilotClient,
    type MinimalCopilotSession,
} from "./copilotClientHost.js";
