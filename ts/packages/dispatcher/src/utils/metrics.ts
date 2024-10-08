// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    createProfileLogger,
    ProfileLogger,
    ProfileMeasure,
    ProfileReader,
} from "common-utils";

import { ProfileNames } from "./profileNames.js";

export type Timing = {
    duration: number;
    count: number;
};

export type PhaseTiming = {
    marks?: Record<string, Timing>;
    duration?: number | undefined;
};
export type RequestMetrics = {
    parse?: PhaseTiming | undefined;
    actions: (PhaseTiming | undefined)[];
    duration?: number | undefined;
};

function minStart(measures: ProfileMeasure[]) {
    const value = measures.reduce(
        (start, measure) => Math.min(start, measure.start),
        Number.MAX_VALUE,
    );
    return value;
}

function totalDuration(measures: ProfileMeasure[] | undefined) {
    if (!measures) {
        return undefined;
    }
    const value = measures.reduce(
        (sum, measure) => sum + (measure.duration ?? 0),
        0,
    );
    return value === 0 ? undefined : value;
}

function totalMarkDuration(
    measures: ProfileMeasure[] | undefined,
    name: string,
): Timing | undefined {
    if (measures === undefined) {
        return undefined;
    }
    let duration = 0;
    let count = 0;

    for (const measure of measures) {
        for (const mark of measure.marks) {
            if (mark.name === name) {
                duration += mark.duration;
                count++;
            }
        }
    }
    return count === 0 ? undefined : { duration, count };
}

function getInfo(timing: PhaseTiming) {
    if (timing.duration === undefined && timing.marks === undefined) {
        return undefined;
    }
    return timing;
}

export class RequestMetricsManager {
    private readonly profileMap = new Map<
        string,
        { logger: ProfileLogger; reader: ProfileReader }
    >();

    public beginCommand(requestId: string) {
        const logger = createProfileLogger();
        this.profileMap.set(requestId, {
            logger,
            reader: new ProfileReader(),
        });
        return logger.measure(ProfileNames.command, true, requestId);
    }

    public getMetrics(requestId: string): RequestMetrics | undefined {
        const data = this.profileMap.get(requestId);
        if (data === undefined) {
            return undefined;
        }
        const { logger, reader } = data;
        const entries = logger.getUnreadEntries();
        if (entries !== undefined) {
            reader.addEntries(entries);
        }
        const commandMeasures = reader.getMeasures(ProfileNames.command);
        if (commandMeasures === undefined) {
            return undefined;
        }
        const commandStart = minStart(commandMeasures);
        const commandDuration = totalDuration(commandMeasures);

        const actions: PhaseTiming[] = [];
        let parseDuration: number | undefined;
        const requestMeasures = reader.getMeasures(ProfileNames.request);
        if (requestMeasures !== undefined) {
            // request command
            const actionMeasures = reader.getMeasures(
                ProfileNames.executeAction,
            );

            if (actionMeasures !== undefined) {
                parseDuration = minStart(actionMeasures) - commandStart;
                for (const actionMeasure of actionMeasures) {
                    if (actionMeasure.duration === undefined) {
                        continue;
                    }
                    const index = actionMeasure.startData as number;
                    if (actions[index] === undefined) {
                        actions[index] = { duration: 0 };
                    }
                    actions[index].duration! += actionMeasure.duration;
                }
            }
        } else {
            const executeCommandMeasures = reader.getMeasures(
                ProfileNames.executeCommand,
            );
            if (executeCommandMeasures) {
                parseDuration = minStart(executeCommandMeasures) - commandStart;

                const executeCommandDuration = totalDuration(
                    executeCommandMeasures,
                );
                if (executeCommandDuration !== undefined) {
                    actions[0] = { duration: executeCommandDuration };
                }
            }
        }

        const parse: PhaseTiming = {
            duration: parseDuration ?? commandDuration,
        };

        const firstToken = totalMarkDuration(
            reader.getMeasures(ProfileNames.translate),
            ProfileNames.firstToken,
        );

        if (firstToken !== undefined) {
            parse.marks = { "First Token": firstToken };
        }

        return { parse: getInfo(parse), actions, duration: commandDuration };
    }
    public endCommand(requestId: string) {
        const metrics = this.getMetrics(requestId);
        if (metrics) {
            this.profileMap.delete(requestId);
        }
        return metrics;
    }
}
