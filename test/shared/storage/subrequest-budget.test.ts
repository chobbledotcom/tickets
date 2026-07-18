import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  deleteFile,
  downloadRaw,
  listFiles,
  uploadRaw,
} from "#shared/storage.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withBunnyStorageStub } from "#test-utils/mocks.ts";

const expectOneExternalCall = async (
  operation: () => Promise<unknown>,
): Promise<void> => {
  await runWithSubrequestBudget(async () => {
    await operation();
    expect(getSubrequestUsage()).toEqual({
      database: 0,
      external: 1,
      total: 1,
    });
  });
};

const storageResponse = (status = 200): Response =>
  new Response(JSON.stringify({ HttpCode: status }), { status });

describeWithEnv(
  "storage subrequest budget",
  {
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    test("counts an upload", () =>
      withBunnyStorageStub(
        () => storageResponse(201),
        () =>
          expectOneExternalCall(() =>
            uploadRaw(new Uint8Array([1]), "budget.bin"),
          ),
      ));

    test("counts a download", () =>
      withBunnyStorageStub(
        () => new Response(new Uint8Array([1])),
        () => expectOneExternalCall(() => downloadRaw("budget.bin")),
      ));

    test("counts a delete", () =>
      withBunnyStorageStub(
        () => storageResponse(),
        () => expectOneExternalCall(() => deleteFile("budget.bin")),
      ));

    test("counts a directory listing", () =>
      withBunnyStorageStub(
        () => Response.json([]),
        () => expectOneExternalCall(() => listFiles("")),
      ));
  },
);
