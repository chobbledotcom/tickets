import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { zipSync } from "fflate";
import { handleRequest } from "#routes";
import { backupDir, createBackupZip } from "#shared/db/backup.ts";
import { downloadRaw, uploadRaw } from "#shared/storage.ts";
import { recordScriptVersion, setBuildCommitForTest } from "#shared/update.ts";
import { RESTORE_CONFIRM_PHRASE } from "#templates/admin/backup.tsx";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  getTestSession,
  testRequiresAuth,
  withLocalStorageEnabled,
} from "#test-utils";

describeWithEnv("server (admin backup)", { db: true }, () => {
  describe("GET /admin/backup", () => {
    testRequiresAuth("/admin/backup");

    test("returns 403 for manager users", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/backup", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(403);
    });

    test("shows backup page for owner", async () => {
      const response = await adminGet("/admin/backup");
      await expectHtmlResponse(
        response,
        200,
        "Database Backup",
        "Encryption Key",
      );
    });

    test("shows encryption key on page", async () => {
      const response = await adminGet("/admin/backup");
      const html = await response.text();
      expect(html).toContain("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    });

    test("shows storage not configured when disabled", async () => {
      const response = await adminGet("/admin/backup");
      const html = await response.text();
      expect(html).toContain("Storage is not configured");
    });

    test("cleans up stale restore-pending files on page load", async () => {
      await withLocalStorageEnabled(async () => {
        await uploadRaw(new Uint8Array(1), "restore-pending-stale.zip");

        await adminGet("/admin/backup");

        // Give the fire-and-forget cleanup a moment to complete
        await new Promise((r) => setTimeout(r, 50));

        const data = await downloadRaw("restore-pending-stale.zip");
        expect(data).toBeNull();
      });
    });
  });

  describe("POST /admin/backup/create", () => {
    testRequiresAuth("/admin/backup/create", {
      body: {},
      method: "POST",
    });

    test("creates backup and redirects with success", async () => {
      await withLocalStorageEnabled(async () => {
        await createTestListing({ name: "Backup Test" });
        const { response } = await adminFormPost("/admin/backup/create");
        await expectFlashRedirect(
          "/admin/backup",
          "Database backup created",
        )(response);
      });
    });

    test("lists only valid backup files on backup page", async () => {
      await withLocalStorageEnabled(async () => {
        // A non-backup file sharing the folder must not appear in the list.
        await uploadRaw(new Uint8Array(0), `${backupDir()}backup-stale.tmp`);
        await adminFormPost("/admin/backup/create");
        const response = await adminGet("/admin/backup");
        const html = await response.text();
        expect(html).not.toContain("backup-stale.tmp");
        expect(html).toContain(".zip");
      });
    });

    test("shows the retention summary once a backup exists", async () => {
      await withLocalStorageEnabled(async () => {
        await adminFormPost("/admin/backup/create");
        const response = await adminGet("/admin/backup");
        const html = await response.text();
        expect(html).toContain("There is 1 backup");
        expect(html).toContain("Up to 30 are kept");
      });
    });
  });

  describe("GET /admin/backup/download/:filename", () => {
    testRequiresAuth("/admin/backup/download/backup-local-test.zip");

    test("returns 400 for invalid filename", async () => {
      const response = await adminGet(
        "/admin/backup/download/not-a-backup.txt",
      );
      expect(response.status).toBe(400);
    });

    test("returns 404 for missing file", async () => {
      await withLocalStorageEnabled(async () => {
        // Validly formatted leaf, but no such backup exists in this DB's folder.
        const response = await adminGet(
          "/admin/backup/download/backup-2024-01-15T12-30-00-000Z.zip",
        );
        expect(response.status).toBe(404);
      });
    });

    test("returns 400 for filename with path traversal", async () => {
      const response = await adminGet(
        "/admin/backup/download/backup-local-..%2F..%2Fetc.zip",
      );
      expect(response.status).toBe(400);
    });

    test("downloads existing backup as zip", async () => {
      await withLocalStorageEnabled(async () => {
        await adminFormPost("/admin/backup/create");
        const listResp = await adminGet("/admin/backup");
        const html = await listResp.text();
        const linkMatch = html.match(
          /\/admin\/backup\/download\/(backup-[^"]+\.zip)/,
        );
        expect(linkMatch).toBeTruthy();
        const response = await adminGet(
          `/admin/backup/download/${linkMatch![1]}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/zip");
      });
    });
  });

  describe("POST /admin/backup/restore", () => {
    testRequiresAuth("/admin/backup/restore", {
      body: {},
      method: "POST",
    });

    /** POST a restore upload with `csrfToken` + optional file fields, returning
     *  the response. Collapses the repeated FormData + Request scaffold. */
    const postRestore = async (
      cookie: string,
      csrfToken: string,
      files: Record<string, File> = {},
    ): Promise<Response> => {
      const formData = new FormData();
      formData.append("csrf_token", csrfToken);
      for (const [name, file] of Object.entries(files)) {
        formData.append(name, file);
      }
      return handleRequest(
        new Request("http://localhost/admin/backup/restore", {
          body: formData,
          headers: { cookie, host: "localhost" },
          method: "POST",
        }),
      );
    };

    test("shows confirm page after uploading valid zip", async () => {
      await withLocalStorageEnabled(async () => {
        const zipData = await createBackupZip();
        const { cookie, csrfToken } = await getTestSession();
        const response = await postRestore(cookie, csrfToken, {
          backup_file: new File([zipData.buffer as ArrayBuffer], "backup.zip"),
        });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Confirm Database Restore");
      });
    });

    test("shows schema mismatch warning for different schema", async () => {
      await withLocalStorageEnabled(async () => {
        const encoder = new TextEncoder();
        const fakeZip = zipSync({
          "manifest.json": encoder.encode(
            JSON.stringify({
              latestUpdate: "",
              schemaHash: "wrong",
              tables: {},
              timestamp: "",
            }),
          ),
          "settings.sql": new Uint8Array(0),
        });
        const { cookie, csrfToken } = await getTestSession();
        const response = await postRestore(cookie, csrfToken, {
          backup_file: new File([fakeZip.buffer as ArrayBuffer], "backup.zip"),
        });
        const html = await response.text();
        expect(html).toContain("Schema mismatch");
      });
    });

    test("rejects missing file field", async () => {
      await withLocalStorageEnabled(async () => {
        const { cookie, csrfToken } = await getTestSession();
        const response = await postRestore(cookie, csrfToken);
        expect(response.status).toBe(302);
      });
    });

    test("rejects invalid zip file", async () => {
      await withLocalStorageEnabled(async () => {
        const { cookie, csrfToken } = await getTestSession();
        const response = await postRestore(cookie, csrfToken, {
          backup_file: new File([new ArrayBuffer(100)], "bad.zip"),
        });
        expect(response.status).toBe(302);
      });
    });
  });

  describe("POST /admin/backup/restore/confirm", () => {
    testRequiresAuth("/admin/backup/restore/confirm", {
      body: {},
      method: "POST",
    });

    test("rejects invalid filename", async () => {
      const { response } = await adminFormPost(
        "/admin/backup/restore/confirm",
        {
          backup_filename: "bad.zip",
          confirm_identifier: RESTORE_CONFIRM_PHRASE,
        },
      );
      await expectFlashRedirect(
        "/admin/backup",
        "Invalid backup reference",
        false,
      )(response);
    });

    test("rejects wrong confirmation phrase", async () => {
      const { response } = await adminFormPost(
        "/admin/backup/restore/confirm",
        {
          backup_filename: "restore-pending-x.zip",
          confirm_identifier: "WRONG",
        },
      );
      await expectFlashRedirect(
        "/admin/backup",
        "Confirmation phrase does not match",
        false,
      )(response);
    });

    test("rejects missing backup file", async () => {
      await withLocalStorageEnabled(async () => {
        const { response } = await adminFormPost(
          "/admin/backup/restore/confirm",
          {
            backup_filename: "restore-pending-gone.zip",
            confirm_identifier: RESTORE_CONFIRM_PHRASE,
          },
        );
        await expectFlashRedirect(
          "/admin/backup",
          "Backup file expired or not found. Please upload again.",
          false,
        )(response);
      });
    });

    test("successfully restores from backup", async () => {
      await withLocalStorageEnabled(async () => {
        const listing = await createTestListing({ name: "Restore Me" });
        const zipData = await createBackupZip();
        // Delete the listing after capturing it in the backup so we can
        // verify the restore actually writes data back to the DB.
        const { deleteListing, getAllListings } = await import(
          "#shared/db/listings.ts"
        );
        await deleteListing(listing.id);
        expect((await getAllListings()).find((e) => e.id === listing.id)).toBe(
          undefined,
        );

        await uploadRaw(zipData, "restore-pending-test.zip");
        const { response } = await adminFormPost(
          "/admin/backup/restore/confirm",
          {
            backup_filename: "restore-pending-test.zip",
            confirm_identifier: RESTORE_CONFIRM_PHRASE,
          },
        );
        await expectFlashRedirect(
          "/admin/login",
          "Database restored from backup",
        )(response);

        const restored = (await getAllListings()).find(
          (e) => e.id === listing.id,
        );
        expect(restored).toBeDefined();
        expect(restored!.name).toBe("Restore Me");
      });
    });

    test("surfaces the full recorded commit so the operator can redeploy the code", async () => {
      await withLocalStorageEnabled(async () => {
        // The running build records its commit into settings; the dump carries
        // it, so the restore tells the operator which commit to redeploy. The
        // FULL SHA is shown because the restore-deploy workflow requires one.
        const fullSha = "0123456789abcdef0123456789abcdef01234567";
        setBuildCommitForTest(fullSha);
        try {
          await getTestSession(); // ensure session row is in DB before backup
          await recordScriptVersion();
          const zipData = await createBackupZip();
          await uploadRaw(zipData, "restore-pending-commit.zip");

          const { response } = await adminFormPost(
            "/admin/backup/restore/confirm",
            {
              backup_filename: "restore-pending-commit.zip",
              confirm_identifier: RESTORE_CONFIRM_PHRASE,
            },
          );
          await expectFlashRedirect(
            "/admin/login",
            `Database restored from backup. It was running commit ${fullSha} — run the restore-deploy workflow with that commit to restore the code to this point in time.`,
          )(response);
        } finally {
          setBuildCommitForTest(null);
        }
      });
    });

    test("omits the redeploy hint when the restored commit is not a full SHA", async () => {
      await withLocalStorageEnabled(async () => {
        // An uploaded/old backup may hold a non-SHA commit value; it must not be
        // echoed into the flash (it's unusable by restore-deploy and could be
        // oversized), so the message falls back to the plain confirmation.
        setBuildCommitForTest("not-a-real-sha");
        try {
          await getTestSession(); // ensure session row is in DB before backup
          await recordScriptVersion();
          const zipData = await createBackupZip();
          await uploadRaw(zipData, "restore-pending-badsha.zip");

          const { response } = await adminFormPost(
            "/admin/backup/restore/confirm",
            {
              backup_filename: "restore-pending-badsha.zip",
              confirm_identifier: RESTORE_CONFIRM_PHRASE,
            },
          );
          await expectFlashRedirect(
            "/admin/login",
            "Database restored from backup",
          )(response);
        } finally {
          setBuildCommitForTest(null);
        }
      });
    });

    test("rejects filename with traversal despite valid prefix and suffix", async () => {
      await withLocalStorageEnabled(async () => {
        // Place a decoy at the traversal target — if traversal were allowed,
        // the restore would attempt to read it. The validation layer must
        // reject before any filesystem access.
        await uploadRaw(new Uint8Array(1), "etc-passwd-decoy.zip");
        const { response } = await adminFormPost(
          "/admin/backup/restore/confirm",
          {
            backup_filename: "restore-pending-x/../../etc-passwd-decoy.zip",
            confirm_identifier: RESTORE_CONFIRM_PHRASE,
          },
        );
        await expectFlashRedirect(
          "/admin/backup",
          "Invalid backup reference",
          false,
        )(response);
      });
    });

    test("routes restoreFromZip failure to login page", async () => {
      await withLocalStorageEnabled(async () => {
        // Upload raw non-zip bytes — restoreFromZip throws from unzipSync
        // (PostResetRestoreError) and onError redirects to /admin/login.
        await uploadRaw(
          new Uint8Array([0, 1, 2, 3]),
          "restore-pending-badzip.zip",
        );
        const { response } = await adminFormPost(
          "/admin/backup/restore/confirm",
          {
            backup_filename: "restore-pending-badzip.zip",
            confirm_identifier: RESTORE_CONFIRM_PHRASE,
          },
        );
        await expectFlashRedirect(
          "/admin/login",
          expect.any(String),
          false,
        )(response);
      });
    });

    test("cleans up temp file even on restore failure", async () => {
      await withLocalStorageEnabled(async () => {
        // Upload an invalid zip (valid zip format but contains bad SQL)
        const badZip = zipSync({
          "settings.sql": new TextEncoder().encode("INVALID SQL SYNTAX;"),
        });
        await uploadRaw(badZip, "restore-pending-fail.zip");

        // Attempt restore — should fail but still clean up the temp file
        try {
          await adminFormPost("/admin/backup/restore/confirm", {
            backup_filename: "restore-pending-fail.zip",
            confirm_identifier: RESTORE_CONFIRM_PHRASE,
          });
        } catch {
          // Restore failure is expected
        }

        // Temp file should be cleaned up regardless
        const data = await downloadRaw("restore-pending-fail.zip");
        expect(data).toBeNull();
      });
    });
  });
});
