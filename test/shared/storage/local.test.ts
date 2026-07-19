import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  downloadRaw,
  listFiles,
  listFilesWithMeta,
  runWithStorageConfig,
  uploadAttachment,
  uploadRaw,
} from "#shared/storage.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withLocalStorageEnabled } from "#test-utils/mocks.ts";
import { STORAGE_TEST_ENV } from "./fixtures.ts";

describeWithEnv("local storage", STORAGE_TEST_ENV, () => {
  test("uploadAttachment stores any file type", async () => {
    await withLocalStorageEnabled(async (dir) => {
      const filename = "report.pdf";
      await uploadAttachment(
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        filename,
      );
      expect((await Deno.stat(`${dir}/${filename}`)).isFile).toBe(true);
    });
  });

  test("uploadRaw stores bytes without encryption", async () => {
    await withLocalStorageEnabled(async (dir) => {
      const data = new TextEncoder().encode("hello raw");
      await uploadRaw(data, "raw-test.txt");
      expect(await Deno.readFile(`${dir}/raw-test.txt`)).toEqual(data);
    });
  });

  test("downloadRaw reads bytes without decryption", async () => {
    await withLocalStorageEnabled(async () => {
      const data = new TextEncoder().encode("raw roundtrip");
      await uploadRaw(data, "raw-dl.txt");
      expect(await downloadRaw("raw-dl.txt")).toEqual(data);
    });
  });

  test("downloadRaw returns null for a missing file", async () => {
    await withLocalStorageEnabled(async () => {
      expect(await downloadRaw("nonexistent.txt")).toBeNull();
    });
  });

  test("listFiles filters and sorts names", async () => {
    await withLocalStorageEnabled(async () => {
      await uploadRaw(new Uint8Array(), "backup-z.zip");
      await uploadRaw(new Uint8Array(), "backup-a.zip");
      await uploadRaw(new Uint8Array(), "other-file.txt");
      expect(await listFiles("backup-")).toEqual([
        "backup-a.zip",
        "backup-z.zip",
      ]);
    });
  });

  test("listFiles returns no unmatched files", async () => {
    await withLocalStorageEnabled(async () => {
      expect(await listFiles("nonexistent-")).toEqual([]);
    });
  });

  test("listFiles returns empty when the directory is missing", async () => {
    await runWithStorageConfig(
      {
        localPath: `/tmp/nonexistent-dir-${crypto.randomUUID()}`,
        zoneKey: "",
        zoneName: "",
      },
      async () => expect(await listFiles("backup-")).toEqual([]),
    );
  });

  test("listFiles skips directory entries", async () => {
    await withLocalStorageEnabled(async (dir) => {
      await uploadRaw(new Uint8Array(), "backup-a.zip");
      await Deno.mkdir(`${dir}/backup-subdir`);
      expect(await listFiles("backup-")).toEqual(["backup-a.zip"]);
    });
  });

  test("listFilesWithMeta returns each file size", async () => {
    await withLocalStorageEnabled(async () => {
      await uploadRaw(new Uint8Array(3), "backup-a.zip");
      await uploadRaw(new Uint8Array(7), "backup-b.zip");
      expect(await listFilesWithMeta("backup-")).toEqual([
        { name: "backup-a.zip", size: 3 },
        { name: "backup-b.zip", size: 7 },
      ]);
    });
  });

  test("lists files in a subfolder", async () => {
    await withLocalStorageEnabled(async () => {
      await uploadRaw(new Uint8Array(), "acme/backup-a.zip");
      await uploadRaw(new Uint8Array(), "acme/backup-b.zip");
      expect(await listFiles("acme/")).toEqual([
        "acme/backup-a.zip",
        "acme/backup-b.zip",
      ]);
    });
  });

  test("filters a subfolder by its leaf prefix", async () => {
    await withLocalStorageEnabled(async () => {
      await uploadRaw(new Uint8Array(), "acme/backup-a.zip");
      await uploadRaw(new Uint8Array(), "acme/notes.txt");
      expect(await listFiles("acme/backup-")).toEqual(["acme/backup-a.zip"]);
    });
  });

  test("handles a one-character folder name", async () => {
    await withLocalStorageEnabled(async () => {
      await uploadRaw(new Uint8Array(), "a/file.zip");
      expect(await listFiles("a/")).toEqual(["a/file.zip"]);
    });
  });

  test("keeps similarly named folders separate", async () => {
    await withLocalStorageEnabled(async () => {
      await uploadRaw(new Uint8Array(), "tickets/backup-a.zip");
      await uploadRaw(new Uint8Array(), "tickets-spencer/backup-b.zip");
      expect(await listFiles("tickets/")).toEqual(["tickets/backup-a.zip"]);
      expect(await listFiles("tickets-spencer/")).toEqual([
        "tickets-spencer/backup-b.zip",
      ]);
    });
  });

  test("a root listing does not descend into subfolders", async () => {
    await withLocalStorageEnabled(async () => {
      await uploadRaw(new Uint8Array(), "root-file.zip");
      await uploadRaw(new Uint8Array(), "acme/backup-a.zip");
      expect(await listFiles("")).toEqual(["root-file.zip"]);
    });
  });
});
