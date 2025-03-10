// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type ClarifyActions = LookupActions | ClarifyRequestAction;

export type LookupActions =
    | LookupConversationAction
    | LookupInternetInformationAction;

export type DateVal = {
    day: number;
    month: number;
    year: number;
};

export type TimeVal = {
    // In 24 hour form
    hour: number;
    minute: number;
    seconds: number;
};

export type DateTime = {
    date: DateVal;
    time?: TimeVal | undefined;
};

export type DateTimeRange = {
    startDate: DateTime;
    stopDate?: DateTime | undefined;
};

export type LookupTerms = {
    // action verb terms to look for
    verbs?: string[];
    // Terms are one of the following:
    // Entity Terms:
    // - the name of an entity or thing such as "Bach", "Great Gatsby", "frog" or "piano"
    // - the *type* of the entity such as "speaker", "person", "artist", "animal", "object", "instrument", "school", "room", "museum", "food" etc.
    //   An entity can have multiple types; entity types should be single words
    // - facets: specific, inherent, defining, or non-immediate facet of an entity such as "blue", "old", "famous", "sister", "aunt_of", "weight: 4 kg"
    // Action Terms:
    // - subject, object and indirectObject associated with the verb
    // verbs are not duplicated.
    terms: string[];
    // Use only if request explicitly asks for time range
    timeRange?: DateTimeRange | undefined; // in this time range
};

// For request that references information from past conversations and discussions, use this action to look up the information.
// E.g. song we discussed last week, the list we create when talking about flowers.
// Additional private information can be found from past conversations include personal facts like birthdays, private events, plans, projects in progress, attachments, files, file names, and other items from discussions with team members or the assistant, use the conversation lookup filters
export interface LookupConversationAction {
    actionName: "lookupConversation";
    parameters: {
        // the current understood user request that needs to be clarified
        request: string;
        // The missing information that needs to be found in past conversation
        missingInformation: string;
        // All the terms and filters to be used to lookup the missing information.
        conversationLookup?: LookupTerms[];
    };
}

// if the request requires contemporary internet information including sports scores, news events, or current commerce offerings, use the lookups parameter to lookup of the information and load it into context for next pending action
// Lookup *facts* you don't know or if your facts are out of date.
// E.g. stock prices, time sensitive data, etc
// the search strings to look up on the user's behalf should be specific enough to return the correct information
// it is recommended to include the same entities as in the user request
export interface LookupInternetInformationAction {
    actionName: "lookupInternetInformation";
    parameters: {
        // the current understood user request that needs to be clarified
        request: string;
        internetLookups?: string[];
    };
}

export type ClarifyRequestAction =
    | ClarifyMultiplePossibleActionName
    | ClarifyMissingParameter
    | ClarifyUnresolvedPronounReference;

// Ask the user for clarification for ambiguous request that have multiple possible known action as interpretation.
// Don't clarify "unknown" action.
export interface ClarifyMultiplePossibleActionName {
    actionName: "clarifyMultiplePossibleActionName";
    parameters: {
        // the current understood user request that needs to be clarified
        request: string;
        // Known actionNames to be clarify.  Don't clarify "unknown" action.
        possibleActionNames: string[];
        clarifyingQuestion: string;
    };
}

// Ask the user for clarification for a request with missing parameter of an known action. Don't clarify unknown action.
// If the information refer to previous conversation, use lo
export interface ClarifyMissingParameter {
    actionName: "clarifyMissingParameter";
    parameters: {
        // the current understood user request that needs to be clarified
        request: string;
        // A known actionName to be clarify.  Don't clarify "unknown" action.
        actionName: string;
        parameterName: string;
        clarifyingQuestion: string;
    };
}

// Ask the user for clarification for the request that parameters are referring to unresolved pronoun references
export interface ClarifyUnresolvedPronounReference {
    actionName: "clarifyUnresolvedPronounReference";
    parameters: {
        // the current understood user request that needs to be clarified
        request: string;
        actionName: string;
        parameterName: string;
        reference: string; // words of the unresolved pronoun references
        clarifyingQuestion: string;
    };
}
