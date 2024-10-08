// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type AddToCartAction = {
    actionName: "addToCartAction";
    parameters: {
        productName: string;
    };
};

export type PickUpAtStoreAction = {
    actionName: "pickUpAtStoreAction";
    parameters: {
        productName: string;
        storeLocation?: string;
    };
};

export type LookupAtStoreAction = {
    actionName: "lookupAtStoreAction";
    parameters: {
        productName: string;
    };
};

export type SearchForProductAction = {
    actionName: "searchForProductAction";
    parameters: {
        productName: string;
    };
};

export type SelectSearchResult = {
    actionName: "selectSearchResult";
    parameters: {
        // Selection criteria such as "best rated", "top selling", "first result" etc.
        selectionCriteria: string;
    };
};

// select this action when the user's request needs an answer based on the content on the current webpage
export type AnswerQuestionBasedOnPage = {
    actionName: "answerPageQuestion";
    parameters: {
        question: string;
    };
};

export type UnknownAction = {
    actionName: "unknown";
    parameters: {
        // text provided by the user that the system did not understand
        text: string;
    };
};

export type ShoppingAction =
    | AddToCartAction
    | PickUpAtStoreAction
    | LookupAtStoreAction
    | SearchForProductAction
    | SelectSearchResult
    | AnswerQuestionBasedOnPage
    | UnknownAction;

export type ShoppingPlan = {
    steps: ShoppingAction[];
};
