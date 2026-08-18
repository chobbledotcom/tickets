import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { logActivities } from "#shared/db/activity-log.ts";
import { backupDir } from "#shared/db/backup-storage.ts";
import { runWithStorageConfig, uploadRaw } from "#shared/storage.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { TEST_STORAGE_ZONE } from "#test-utils/internal.ts";
import {
  awaitTestRequest,
  installUrlHandler,
  withFetchMock,
  withStorageDisabled,
} from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";

describeWithEnv("server (admin backup)", { db: true, storage: "local" }, () => {
  describe("GET /admin/backup", () => {
    testRequiresAuth("/admin/backup");

    test("returns 403 for manager users", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/backup", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(403);
    });

    test("shows backup details and console restore instructions", async () => {
      const response = await adminGet("/admin/backup");
      await expectHtmlResponse(
        response,
        200,
        "Database backup",
        "Encryption key",
        "deno task restore",
      );
    });

    test("highlights the backup navigation link", async () => {
      const html = await (await adminGet("/admin/backup")).text();
      expect(html).toContain('class="active" href="/admin/backup"');
    });

    test("shows the encryption key", async () => {
      const html = await (await adminGet("/admin/backup")).text();
      expect(html).toContain("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    });

    test("shows storage not configured when disabled", async () => {
      await withStorageDisabled(async () => {
        const html = await (await adminGet("/admin/backup")).text();
        expect(html).toContain("Storage is not configured");
      });
    });

    test("shows where backups are stored", async () => {
      const html = await (await adminGet("/admin/backup")).text();
      expect(html).toContain(
        `Backups for this database live in the ${backupDir()} folder.`,
      );
    });

    test("shows the failure when the storage listing fails", async () => {
      await runWithStorageConfig(TEST_STORAGE_ZONE, () =>
        withFetchMock(async (originalFetch) => {
          installUrlHandler(originalFetch, (url) =>
            url.includes("storage.bunnycdn.com")
              ? Promise.reject(new Error("list failed"))
              : null,
          );
          const html = await (await adminGet("/admin/backup")).text();
          // The key and restore instructions still render, but the failure is
          // named instead of masquerading as an empty backup list.
          expect(html).toContain("deno task restore");
          expect(html).toContain(
            "Could not read the list of backups: list failed",
          );
          expect(html).not.toContain("No backups found");
          // Under Bunny storage the page also names the zone it reads.
          expect(html).toContain(
            `of the ${TEST_STORAGE_ZONE.zoneName} storage zone`,
          );
        }),
      );
    });
  });

  describe("POST /admin/backup/create", () => {
    testRequiresAuth("/admin/backup/create", {
      body: {},
      method: "POST",
    });

    test("creates a backup", async () => {
      await createTestListing({ name: "Backup Test" });
      const { response } = await adminFormPost("/admin/backup/create");
      await expectFlashRedirect(
        "/admin/backup",
        "Database backup created",
      )(response);
    });

    test("lists only valid backup files", async () => {
      await uploadRaw(new Uint8Array(0), `${backupDir()}backup-stale.tmp`);
      await adminFormPost("/admin/backup/create");
      const html = await (await adminGet("/admin/backup")).text();
      expect(html).not.toContain("backup-stale.tmp");
      expect(html).toContain(".zip");
    });

    test("shows the timestamp from the stored filename", async () => {
      await adminFormPost("/admin/backup/create");
      const html = await (await adminGet("/admin/backup")).text();
      const token = html.match(
        /backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.zip/,
      )?.[1];
      expect(token).toBeDefined();
      expect(html).toContain(`<code>${token}</code>`);
    });

    test("shows the retention summary", async () => {
      await adminFormPost("/admin/backup/create");
      const html = await (await adminGet("/admin/backup")).text();
      expect(html).toContain("There is 1 backup");
      expect(html).toContain("Up to 30 are kept");
    });
  });

  describe("when the dump cannot fit one request", () => {
    // A page size of one makes every row past each table's first page cost a
    // read of its own, and a hundred log rows (written as ONE batch) push the
    // dump far past any request's 50-call allowance — deterministically, no
    // matter what the fixture tables hold.
    const seedOversizedDatabase = (): Promise<unknown> =>
      logActivities(
        Array.from({ length: 100 }, (_, index) => ({
          message: `filler ${index}`,
        })),
      );

    test("replaces the create button with an explanation", async () => {
      using _env = withEnv({ BACKUP_PAGE_SIZE: "1" });
      await seedOversizedDatabase();
      const html = await (await adminGet("/admin/backup")).text();
      expect(html).toContain("too big to back up from this page");
      expect(html).toContain("deno task backup");
      expect(html).not.toContain('action="/admin/backup/create"');
    });

    test("refuses to create a backup, with a plain explanation", async () => {
      using _env = withEnv({ BACKUP_PAGE_SIZE: "1" });
      await seedOversizedDatabase();
      const { response } = await adminFormPost("/admin/backup/create");
      await expectFlashRedirect(
        "/admin/backup",
        "This database is too big to back up from this page. Run deno task backup from a checkout of this app instead.",
        false,
      )(response);
    });
  });

  describe("GET /admin/backup/download/:filename", () => {
    testRequiresAuth("/admin/backup/download/backup-local-test.zip");

    test("rejects an invalid filename", async () => {
      const response = await adminGet(
        "/admin/backup/download/not-a-backup.txt",
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid backup filename");
    });

    test("returns 404 for a missing backup", async () => {
      const response = await adminGet(
        "/admin/backup/download/backup-2024-01-15T12-30-00-000Z.zip",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Backup file not found");
    });

    test("rejects path traversal", async () => {
      const response = await adminGet(
        "/admin/backup/download/backup-local-..%2F..%2Fetc.zip",
      );
      expect(response.status).toBe(400);
    });

    test("downloads an existing backup", async () => {
      await adminFormPost("/admin/backup/create");
      const html = await (await adminGet("/admin/backup")).text();
      const filename = html.match(
        /\/admin\/backup\/download\/(backup-[^"]+\.zip)/,
      )?.[1];
      expect(filename).toBeDefined();

      const response = await adminGet(`/admin/backup/download/${filename}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/zip");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });
  });
});
