// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { asyncArray } from "../src/index.js";
import { removeDir } from "../src/objStream.js";
import {
    createObjectFolder,
    ObjectFolder,
    ObjectFolderSettings,
} from "../src/storage/objectFolder.js";
import { testDirectoryPath } from "./common.js";

type TestObject = {
    key: string;
    value: string | number;
};

function makeObjects(count: number): TestObject[] {
    const items: TestObject[] = [];
    for (let i = 0; i < count; ++i) {
        items.push({ key: "key" + i, value: "value" + i });
    }
    return items;
}

async function addObjects(folder: ObjectFolder<TestObject>, objCount: number) {
    const objects = makeObjects(objCount);
    return await asyncArray.mapAsync(objects, 1, async (o) => folder!.put(o));
}

async function ensureStore<T>(
    folderPath: string,
    createNew: boolean = true,
    safeWrites: boolean | undefined = undefined,
) {
    if (createNew) {
        await removeDir(folderPath);
    }
    const settings: ObjectFolderSettings = { safeWrites };
    return await createObjectFolder<T>(folderPath, settings);
}

describe("storage.objectFolder", () => {
    let folder: ObjectFolder<TestObject> | undefined;
    const folderPath = testDirectoryPath("./data/test/testStore");
    beforeAll(async () => {
        folder = await ensureStore(folderPath, true);
    });
    test("putAndGet", async () => {
        const obj: TestObject = {
            key: "Foo",
            value: "Bar",
        };
        const id = await folder!.put(obj);
        const loaded = await folder!.get(id);
        expect(loaded).toEqual(obj);
    });
    test("putMultiple", async () => {
        const objCount = 10;
        const ids = await addObjects(folder!, objCount);
        expect(ids.length).toBe(objCount);
    });
    test("remove", async () => {
        await folder!.clear();
        const size = await folder!.size();
        expect(size).toBe(0);
    });
    test("readBatch", async () => {
        await folder!.clear();
        const objCount = 17;
        await addObjects(folder!, objCount);
        let countRead = 0;
        for await (const batch of asyncArray.readBatches(folder!.all(), 4)) {
            countRead += batch.value.length;
        }
        expect(countRead).toBe(objCount);
    });
});

describe("storage.objectFolder.safeWrites", () => {
    let folder: ObjectFolder<TestObject> | undefined;
    const folderPath = testDirectoryPath("./data/test/testStoreSafe");
    beforeAll(async () => {
        folder = await ensureStore(folderPath, true, true);
    });
    test("putAndGet", async () => {
        const obj: TestObject = {
            key: "Foo",
            value: "Bar",
        };
        const id = await folder!.put(obj);
        let loaded = await folder!.get(id);
        expect(loaded).toEqual(obj);

        obj.value = "Goo";
        await folder!.put(obj, id);
        loaded = await folder!.get(id);
        expect(loaded).toEqual(obj);

        const allIds = await folder!.allNames();
        expect(allIds).toHaveLength(1);
    });
});