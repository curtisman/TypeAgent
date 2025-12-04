// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    ParsedActionSchemaJSON,
    ActionSchemaTypeDefinition,
    fromJSONParsedActionSchema,
    parseActionSchemaSource,
    SchemaConfig,
    toJSONParsedActionSchema,
} from "action-schema";
import { ActionConfig, getSchemaContent } from "./actionConfig.js";
import {
    ActionConfigProvider,
    ActionSchemaFile,
} from "./actionConfigProvider.js";
import {
    AppAction,
    SchemaFormat,
    SchemaTypeNames,
    Storage,
} from "@typeagent/agent-sdk";
import { DeepPartialUndefined, simpleStarRegex } from "@typeagent/common-utils";
import crypto from "node:crypto";
import registerDebug from "debug";
import { SchemaInfoProvider } from "agent-cache";
import {
    getActionSchemaTypeName,
    getActivitySchemaTypeName,
} from "./agentTranslators.js";
import { getEntityPropertyTypeName } from "../execute/pendingActions.js";
import { getActionSchema } from "./actionSchemaUtils.js";

const debug = registerDebug("typeagent:dispatcher:schema:cache");
const debugError = registerDebug("typeagent:dispatcher:schema:cache:error");
function hashStrings(...str: string[]) {
    const hash = crypto.createHash("sha256");
    for (const s of str) {
        hash.update(s);
    }
    return hash.digest("base64");
}

const ActionSchemaFileCacheVersion = 3;

type ActionSchemaFileJSON = {
    schemaName: string;
    sourceHash: string;
    parsedActionSchema: ParsedActionSchemaJSON;
};

type ActionSchemaFileCacheJSON = {
    version: number;
    entries: [string, ActionSchemaFileJSON][];
};

function loadParsedActionSchema(
    schemaName: string,
    schemaType: string | SchemaTypeNames,
    sourceHash: string,
    source: string,
): ActionSchemaFile {
    try {
        if (!source) {
            throw new Error("No data");
        }
        const parsedActionSchemaJSON = JSON.parse(
            source,
        ) as ParsedActionSchemaJSON;
        // TODO: validate the json
        const parsedActionSchema = fromJSONParsedActionSchema(
            parsedActionSchemaJSON,
        );
        const actionTypeName = getActionSchemaTypeName(schemaType);
        if (parsedActionSchema.entry.action?.name !== actionTypeName) {
            throw new Error(
                `Schema type mismatch: actual: ${parsedActionSchema.entry.action?.name}, expected:${actionTypeName}`,
            );
        }
        const activityTypeName = getActivitySchemaTypeName(schemaType);
        if (parsedActionSchema.entry.activity?.name !== activityTypeName) {
            throw new Error(
                `Schema type mismatch: actual: ${parsedActionSchema.entry.action?.name}, expected:${activityTypeName}`,
            );
        }

        return {
            schemaName,
            sourceHash,
            parsedActionSchema,
        };
    } catch (e: any) {
        throw new Error(
            `Failed to load parsed action schema '${schemaName}': ${e.message}`,
        );
    }
}

function loadCachedActionSchemaFile(
    record: ActionSchemaFileJSON,
): ActionSchemaFile | undefined {
    try {
        return {
            schemaName: record.schemaName,
            sourceHash: record.sourceHash,
            parsedActionSchema: fromJSONParsedActionSchema(
                structuredClone(record.parsedActionSchema), // Clone to avoid modifying the original data
            ),
        };
    } catch (e: any) {
        debugError(
            `Failed to load cached action schema '${record.schemaName}': ${e.message}`,
        );
        return undefined;
    }
}

function saveActionSchemaFile(
    actionSchemaFile: ActionSchemaFile,
): ActionSchemaFileJSON {
    return {
        schemaName: actionSchemaFile.schemaName,
        sourceHash: actionSchemaFile.sourceHash,
        parsedActionSchema: toJSONParsedActionSchema(
            actionSchemaFile.parsedActionSchema,
        ),
    };
}

async function loadExistingCache(cacheStorage: Storage, cacheFilePath: string) {
    try {
        const data = await cacheStorage.read(cacheFilePath, "utf8");
        const content = JSON.parse(data) as any;
        if (content.version !== ActionSchemaFileCacheVersion) {
            debugError(
                `Invalid cache version: ${cacheFilePath}: ${content.version}`,
            );
            return undefined;
        }
        return content as ActionSchemaFileCacheJSON;
    } catch {}
    return undefined;
}

export class ActionSchemaFileCache {
    private readonly actionSchemaFiles = new Map<string, ActionSchemaFile>();
    private readonly prevSaved = new Map<string, ActionSchemaFileJSON>();
    public static async create(
        cacheStorage?: Storage | undefined,
        cacheFilePath: string = "actionSchemaFileCache.json",
    ): Promise<ActionSchemaFileCache> {
        if (cacheStorage !== undefined) {
            try {
                const cache = await loadExistingCache(
                    cacheStorage,
                    cacheFilePath,
                );
                if (cache) {
                    // We will rewrite it.
                    cacheStorage.delete(cacheFilePath);
                }

                debug(`Loaded parsed schema cache: ${cacheFilePath}`);

                const updateCache = async (
                    key: string,
                    actionSchemaFile: ActionSchemaFileJSON,
                ) => {
                    try {
                        const cache = (await loadExistingCache(
                            cacheStorage,
                            cacheFilePath,
                        )) ?? {
                            version: ActionSchemaFileCacheVersion,
                            entries: [],
                        };
                        cache.entries.push([key, actionSchemaFile]);
                        await cacheStorage.write(
                            cacheFilePath,
                            JSON.stringify(cache),
                            "utf8",
                        );
                    } catch (e: any) {
                        // ignore error
                        debugError(
                            `Failed to write parsed schema cache: ${cacheFilePath}: ${e.message}`,
                        );
                    }
                };
                return new ActionSchemaFileCache(cache, updateCache);
            } catch (e) {
                debugError(`Failed to load parsed schema cache: ${e}`);
            }
        }
        return new ActionSchemaFileCache();
    }

    private constructor(
        cache?: ActionSchemaFileCacheJSON,
        private readonly updateCache?: (
            key: string,
            actionSchameFile: ActionSchemaFileJSON,
        ) => Promise<void>,
    ) {
        if (cache !== undefined) {
            for (const [key, entry] of cache.entries) {
                this.prevSaved.set(key, entry);
            }
        }
    }

    private getSchemaSource(actionConfig: ActionConfig): {
        source: string;
        config: string | undefined;
        fullPath: string | undefined;
        format: SchemaFormat;
    } {
        const schemaContent = getSchemaContent(actionConfig);
        if (schemaContent.format === "ts" || schemaContent.format === "pas") {
            return {
                source: schemaContent.content,
                config: undefined,
                fullPath: undefined,
                format: schemaContent.format,
            };
        }
        throw new Error(
            `Unsupported schema source type ${schemaContent.format}`,
        );
    }
    public getActionSchemaFile(actionConfig: ActionConfig): ActionSchemaFile {
        const actionSchemaFile = this.actionSchemaFiles.get(
            actionConfig.schemaName,
        );
        if (actionSchemaFile !== undefined) {
            return actionSchemaFile;
        }

        const { source, config, fullPath, format } =
            this.getSchemaSource(actionConfig);

        const schemaTypeString = JSON.stringify(actionConfig.schemaType);
        const hash = config
            ? hashStrings(schemaTypeString, source, config)
            : hashStrings(schemaTypeString, source);
        const cacheKey = `${format}|${actionConfig.schemaName}|${schemaTypeString}|${fullPath ?? ""}`;
        const lastCached = this.prevSaved.get(cacheKey);
        if (lastCached !== undefined) {
            this.prevSaved.delete(cacheKey);
            if (lastCached.sourceHash === hash) {
                debug(`Cached action schema used: ${actionConfig.schemaName}`);
                const cached = loadCachedActionSchemaFile(lastCached);
                if (cached !== undefined) {
                    // Add and save the cache first before convert it back (which will modify the data)
                    this.addToCache(cacheKey, lastCached);
                    this.actionSchemaFiles.set(actionConfig.schemaName, cached);
                    return cached;
                }
            } else {
                debugError(
                    `Cached action schema hash mismatch: ${actionConfig.schemaName}`,
                );
            }
        }

        const parsed: ActionSchemaFile =
            format === "pas"
                ? loadParsedActionSchema(
                      actionConfig.schemaName,
                      actionConfig.schemaType,
                      hash,
                      source,
                  )
                : {
                      schemaName: actionConfig.schemaName,
                      sourceHash: hash,
                      parsedActionSchema: parseActionSchemaSource(
                          source,
                          actionConfig.schemaName,
                          actionConfig.schemaType,
                          fullPath,
                          config ? <SchemaConfig>JSON.parse(config) : undefined,
                          true,
                      ),
                  };
        this.actionSchemaFiles.set(actionConfig.schemaName, parsed);

        if (this.updateCache !== undefined) {
            this.addToCache(cacheKey, saveActionSchemaFile(parsed));
        }
        return parsed;
    }

    public unloadActionSchemaFile(schemaName: string) {
        this.actionSchemaFiles.delete(schemaName);
    }

    private async addToCache(
        key: string,
        actionSchemaFile: ActionSchemaFileJSON,
    ) {
        if (this.updateCache === undefined) {
            return;
        }

        this.updateCache(key, actionSchemaFile);
    }
}

export function tryGetActionSchema(
    action: DeepPartialUndefined<AppAction>,
    provider: ActionConfigProvider,
): ActionSchemaTypeDefinition | undefined {
    const { schemaName, actionName } = action;
    if (schemaName === undefined || actionName === undefined) {
        return undefined;
    }
    const config = provider.tryGetActionConfig(schemaName);
    if (config === undefined) {
        return undefined;
    }

    const actionSchemaFile = provider.getActionSchemaFileForConfig(config);
    return actionSchemaFile.parsedActionSchema.actionSchemas.get(actionName);
}

export function getParamPatternValue<T>(
    patternMap: Record<string, T> | undefined,
    paramName: string,
): T | undefined {
    if (patternMap === undefined) {
        return undefined;
    }
    for (const [key, value] of Object.entries(patternMap)) {
        if (key.includes("*")) {
            const regex = simpleStarRegex(key);
            if (regex.test(paramName)) {
                return value;
            }
        } else if (key === paramName) {
            return value;
        }
    }
    return undefined;
}

export function createSchemaInfoProvider(
    provider: ActionConfigProvider,
): SchemaInfoProvider {
    const getActionSchemaFile = (schemaName: string) => {
        return provider.getActionSchemaFileForConfig(
            provider.getActionConfig(schemaName),
        );
    };

    const result: SchemaInfoProvider = {
        getActionSchemaFileHash: (schemaName) =>
            getActionSchemaFile(schemaName).sourceHash,
        getActionNamespace: (schemaName) =>
            getActionSchemaFile(schemaName).parsedActionSchema.actionNamespace,
        getActionCacheEnabled: (schemaName, actionName) =>
            getActionSchema(getActionSchemaFile(schemaName), actionName)
                .paramSpecs !== false,
        getActionParamSpec: (schemaName, actionName, paramName) => {
            const actionSchemaFile = getActionSchemaFile(schemaName);
            const actionSchema = getActionSchema(actionSchemaFile, actionName);
            const paramSpecs = actionSchema.paramSpecs;
            if (paramSpecs === false) {
                // cache is disabled. This shouldn't be called, but just return undefined.
                return undefined;
            }
            // Check the paramSpec if there are explicit entries.
            if (paramSpecs !== undefined) {
                return getParamPatternValue(paramSpecs, paramName);
            }

            // Check if it is an entity-type.
            const entityPropertyTypeName = getEntityPropertyTypeName(
                actionName,
                paramName,
                actionSchemaFile,
            );
            return entityPropertyTypeName !== undefined
                ? "entity_wildcard"
                : undefined;
        },
    };
    return result;
}
