import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  deleteFile,
  downloadRaw,
  listFiles,
  listFilesWithMeta,
  runWithStorageConfig,
  uploadRaw,
} from "#shared/storage.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withBunnyStorageStub } from "#test-utils/mocks.ts";
import { STORAGE_TEST_ENV } from "./fixtures.ts";

const noExternalRequests = {
  database: 50,
  external: 0,
  total: 50,
};

const expectBlockedOperation = async (
  label: string,
  action: () => Promise<unknown>,
): Promise<void> => {
  await expect(
    runWithSubrequestBudget(() =>
      withSubrequestAllowance(noExternalRequests, action),
    ),
  ).rejects.toThrow(`Blocked external operation: ${label}`);
};

describeWithEnv("Bunny storage", STORAGE_TEST_ENV, () => {
  test("rejects incomplete Bunny credentials before loading the SDK", async () => {
    await runWithStorageConfig(
      { localPath: "", zoneKey: "key", zoneName: "" },
      async () => {
        await expect(
          uploadRaw(new Uint8Array([1]), "file.bin"),
        ).rejects.toThrow("Storage is not configured");
      },
    );
  });

  test("uploadRaw sends exact bytes and content type", async () => {
    const requests: Request[] = [];
    await withBunnyStorageStub(
      async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json({ HttpCode: 201 }, { status: 201 });
      },
      async () => {
        const raw = new Uint8Array([1, 2, 3, 4]);
        expect(await uploadRaw(raw, "raw-upload.bin")).toBe("raw-upload.bin");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe("PUT");
        expect(requests[0]?.url).toContain("/raw-upload.bin");
        expect(requests[0]?.headers.get("content-type")).toBe(
          "application/octet-stream",
        );
        expect(new Uint8Array(await requests[0]!.arrayBuffer())).toEqual(raw);
      },
    );
  });

  test("downloadRaw joins every response chunk", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    await withBunnyStorageStub(
      () => new Response(stream),
      async () => {
        expect(await downloadRaw("chunked.bin")).toEqual(
          new Uint8Array([1, 2, 3, 4, 5]),
        );
      },
    );
  });

  test("downloadRaw returns null for a missing file", async () => {
    await withBunnyStorageStub(
      () => new Response("File not found", { status: 404 }),
      async () => expect(await downloadRaw("missing.bin")).toBeNull(),
    );
  });

  test("downloadRaw surfaces non-missing failures", async () => {
    await withBunnyStorageStub(
      () => new Response("Server Error", { status: 500 }),
      async () => await expect(downloadRaw("broken.bin")).rejects.toThrow(),
    );
  });

  test("listFiles filters and sorts Bunny results", async () => {
    await withBunnyStorageStub(
      () =>
        Response.json([
          { ObjectName: "backup-2025.zip" },
          { ObjectName: "backup-2024.zip" },
          { ObjectName: "other-file.txt" },
        ]),
      async () => {
        expect(await listFiles("backup-")).toEqual([
          "backup-2024.zip",
          "backup-2025.zip",
        ]);
      },
    );
  });

  test("listFiles requests and returns a subfolder path", async () => {
    const listed = { url: "" };
    await withBunnyStorageStub(
      (url) => {
        listed.url = url;
        return Response.json([{ ObjectName: "backup-2024.zip" }]);
      },
      async () => {
        expect(await listFiles("acme/")).toEqual(["acme/backup-2024.zip"]);
        expect(listed.url).toContain("/testzone/acme/");
      },
    );
  });

  test("a missing Bunny folder is empty", async () => {
    await withBunnyStorageStub(
      () => new Response("Not Found", { status: 404 }),
      async () => expect(await listFiles("newsite/")).toEqual([]),
    );
  });

  test("a non-404 listing failure names the status", async () => {
    await withBunnyStorageStub(
      () => new Response("Server Error", { status: 500 }),
      async () =>
        await expect(listFiles("acme/")).rejects.toThrow(
          "Storage listing for acme/ failed: HTTP 500",
        ),
    );
  });

  test("an unauthorized listing surfaces as an error, not garbage", async () => {
    // Bunny answers a bad access key with a JSON error object; before the
    // status check this fed the object into the file filter and threw a
    // meaningless TypeError.
    await withBunnyStorageStub(
      () =>
        Response.json(
          { HttpCode: 401, Message: "Unauthorized" },
          { status: 401 },
        ),
      async () =>
        await expect(listFiles("")).rejects.toThrow(
          "Storage listing for the zone root failed: HTTP 401",
        ),
    );
  });

  test("directory and nameless entries are excluded", async () => {
    await withBunnyStorageStub(
      () =>
        Response.json([
          { IsDirectory: true, ObjectName: "tickets" },
          {},
          { IsDirectory: false, ObjectName: "restore-pending-x.zip" },
        ]),
      async () => {
        expect(await listFiles("")).toEqual(["restore-pending-x.zip"]);
      },
    );
  });

  test("listFilesWithMeta reads and defaults file sizes", async () => {
    await withBunnyStorageStub(
      () =>
        Response.json([
          { Length: 1024, ObjectName: "backup-2024.zip" },
          { ObjectName: "backup-2025.zip" },
          { Length: 5, ObjectName: "other-file.txt" },
        ]),
      async () => {
        expect(await listFilesWithMeta("backup-")).toEqual([
          { name: "backup-2024.zip", size: 1024 },
          { name: "backup-2025.zip", size: 0 },
        ]);
      },
    );
  });
  test("upload identifies its blocked subrequest", async () => {
    await withBunnyStorageStub(
      () => Response.json({ HttpCode: 201 }),
      () =>
        expectBlockedOperation("storage upload", () =>
          uploadRaw(new Uint8Array([1]), "file.bin"),
        ),
    );
  });

  test("download identifies its blocked subrequest", async () => {
    await withBunnyStorageStub(
      () => new Response(new Uint8Array([1])),
      () =>
        expectBlockedOperation("storage download", () =>
          downloadRaw("file.bin"),
        ),
    );
  });

  test("delete identifies its blocked subrequest", async () => {
    await withBunnyStorageStub(
      () => Response.json({ HttpCode: 200 }),
      () =>
        expectBlockedOperation("storage delete", () => deleteFile("file.bin")),
    );
  });

  test("listing identifies its blocked subrequest", async () => {
    await withBunnyStorageStub(
      () => Response.json([]),
      () =>
        expectBlockedOperation("storage directory listing", () =>
          listFiles("backup-"),
        ),
    );
  });
});
