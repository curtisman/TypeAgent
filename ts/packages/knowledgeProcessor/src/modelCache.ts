// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TextEmbeddingModel } from "aiclient";
import { collections } from "typeagent";
import { Result, success } from "typechat";

export function createEmbeddingCache(
    model: TextEmbeddingModel,
    cacheSize: number,
): TextEmbeddingModel {
    const cache: collections.Cache<string, number[]> =
        collections.createLRUCache(cacheSize);
    return {
        generateEmbedding,
        get maxBatchSize() {
            return model.maxBatchSize;
        },
    };
    async function generateEmbedding(input: string): Promise<Result<number[]>>;
    async function generateEmbedding(
        input: string[],
    ): Promise<Result<number[][]>>;
    async function generateEmbedding(
        input: string | string[],
    ): Promise<Result<number[] | number[][]>> {
        if (Array.isArray(input)) {
            const result: (number[] | undefined)[] = new Array(input.length);
            const pending: string[] = [];
            const pendingIndex: number[] = [];
            for (let index = 0; index < input.length; index++) {
                const i = input[index];
                const embedding = cache.get(i);
                result.push(embedding);
                if (!embedding) {
                    pending.push(i);
                    pendingIndex.push(index);
                }
            }
            if (pending.length > 0) {
                const embeddings = await model.generateEmbedding(pending);
                if (!embeddings.success) {
                    return embeddings;
                }
                for (let i = 0; i < pending.length; i++) {
                    const index = pendingIndex[i];
                    const embedding = embeddings.data[i];
                    result[index] = embedding;
                    cache.put(pending[i], embedding);
                }
            }
            return success(result as number[][]);
        }

        let embedding = cache.get(input);
        if (embedding) {
            return success(embedding);
        }
        const result = await model.generateEmbedding(input);
        if (result.success) {
            cache.put(input, result.data);
        }
        return result;
    }
}
