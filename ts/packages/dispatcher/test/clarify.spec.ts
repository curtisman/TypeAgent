// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import {
    CommandHandlerContext,
    initializeCommandHandlerContext,
    processCommand,
} from "../src/internal.js";
import { ActionContext } from "@typeagent/agent-sdk";
import { translateRequest } from "../src/handlers/requestCommandHandler.js";
import { HistoryContext } from "agent-cache";

dotenv.config({ path: new URL("../../../../.env", import.meta.url) });
function getTestActionContext(
    context: CommandHandlerContext,
): ActionContext<CommandHandlerContext> {
    return {
        actionIO: {
            type: "text",
            setDisplay() {},
            // Append content to the display, default mode is "inline"
            appendDisplay() {},
            takeAction(action: string) {
                throw new Error("Method not implemented.");
            },
        },
        sessionContext: {
            agentContext: context,
            notify() {},
            async toggleTransientAgent() {},
        },
    };
}

const test = process.env["AZURE_OPENAI_API_KEY"] !== undefined ? it : it.skip;

describe("clarify", () => {
    test("should clarify the intent of the user", async () => {
        const context = await initializeCommandHandlerContext("clarify test", {
            translators: { list: true, "dispatcher.clarify": true },
            actions: {},
            commands: {},
        });
        const result = await translateRequest(
            "add it to list",
            getTestActionContext(context),
        );
        expect(result).toBeDefined();

        expect(result?.requestAction.actions.action?.actionName).toBe(
            "clarifyParameter",
        );
    }, 10000);

    test("should clarify the intent of the user", async () => {
        const context = await initializeCommandHandlerContext("clarify test", {
            translators: { chat: true, list: true, "dispatcher.clarify": true },
            actions: {},
            commands: {},
        });
        const result = await translateRequest(
            "add it to list",
            getTestActionContext(context),
        );
        expect(result).toBeDefined();

        expect(result?.requestAction.actions.action?.actionName).toBe(
            "clarifyParameter",
        );
    }, 10000);
});
