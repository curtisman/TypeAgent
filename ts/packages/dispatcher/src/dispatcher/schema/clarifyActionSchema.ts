// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type ClarifyRequestAction =
    | ClarifyActionNameAction
    | ClarifyParameterAction;

// The request has ambiguities, including multiple possible actions, multiple interpretations, unresolved references, missing parameters, etc.
export interface ClarifyActionNameAction {
    actionName: "clarifyAction";
    parameters: {
        // the current understood user request that needs to be clarified
        request: string;

        // Possible action name that can be matched to the request.
        possibleActionName: string[];
        ambiguity: string[]; // multiple possible actions, multiple interpretations, etc.

        // Respond to the user of what you understand and question for the user to clarify the actions to take.
        clarifyingRespondAndQuestion: string;
    };
}

export interface ClarifyParameterAction {
    actionName: "clarifyParameter";
    parameters: {
        // the current understood user request that needs to be clarified
        request: string;
        targetActionName: string;

        ambiguity: string[]; // missing parameters, unresolved pronoun or references (e.g. it, this, that, etc.), multiple possible interpretation of references, non-typical parameters, etc.

        // Respond to the user of what you understand and question for the user to clarify possible parameters, parameters or specify missing.
        clarifyingRespondAndQuestion: string;
    };
}
