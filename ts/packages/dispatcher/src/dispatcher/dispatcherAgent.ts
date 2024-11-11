// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    CommandHandlerTable,
    getCommandInterface,
} from "@typeagent/agent-sdk/helpers/command";
import { RequestCommandHandler } from "../handlers/requestCommandHandler.js";
import { TranslateCommandHandler } from "../handlers/translateCommandHandler.js";
import { ExplainCommandHandler } from "../handlers/explainCommandHandler.js";
import { CorrectCommandHandler } from "../handlers/correctCommandHandler.js";
import { ActionContext, AppAction, AppAgent } from "@typeagent/agent-sdk";
import { CommandHandlerContext } from "../internal.js";
import { createActionResultNoDisplay } from "@typeagent/agent-sdk/helpers/action";
import {
    DispatcherActions,
    UnknownAction,
} from "./schema/dispatcherActionSchema.js";
import { ClarifyRequestAction } from "./schema/clarifyActionSchema.js";

export function isUnknownAction(action: AppAction): action is UnknownAction {
    return action.actionName === "unknown";
}

const dispatcherHandlers: CommandHandlerTable = {
    description: "Type Agent Dispatcher Commands",
    commands: {
        request: new RequestCommandHandler(),
        translate: new TranslateCommandHandler(),
        explain: new ExplainCommandHandler(),
        correct: new CorrectCommandHandler(),
    },
};

async function executeDispatcherAction(
    action: DispatcherActions | ClarifyRequestAction,
    context: ActionContext<CommandHandlerContext>,
) {
    switch (action.actionName) {
        case "clarifyAction":
        case "clarifyParameter":
            return ClarifyRequestAction(action, context);

        default:
            throw new Error(`Unknown dispatcher action: ${action.actionName}`);
    }
}

function ClarifyRequestAction(
    action: ClarifyRequestAction,
    context: ActionContext<CommandHandlerContext>,
) {
    const { request, clarifyingRespondAndQuestion } = action.parameters;
    context.actionIO.appendDisplay({
        type: "text",
        speak: true,
        content: clarifyingRespondAndQuestion,
    });

    const result = createActionResultNoDisplay(clarifyingRespondAndQuestion);
    result.additionalInstructions = [
        `Asked the user to clarify the request '${request}'`,
    ];
    return result;
}

export const dispatcherAgent: AppAgent = {
    executeAction: executeDispatcherAction,
    ...getCommandInterface(dispatcherHandlers),
};
