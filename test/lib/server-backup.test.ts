import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { zipSync } from "fflate";
import { createBackupZip } from "#lib/db/backup.ts";
import { RESTORE_CONFIRM_PHRASE } from "#templates/admin/backup.tsx";
import { handleRequest } from "#routes";
import { uploadRaw } from "#lib/storage.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestEvent,
  createTestManagerSession,
  describeWithEnv,
  expectAdminRedirect,
  expectHtmlResponse,
  expectRedirectWithFlash,
  getTestSession,
  mockFormRequest,
  mockRequest,
  withLocalStorageEnabled,
} from "#test-utils";

describeWithEnv("server (admin backup)", { db: true }, () => {
  describe("GET /admin/backup", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/backup"));
      expectAdminRedirect(response);
    });

    test("returns 403 for manager users", async () => {
      const managerCookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/backup", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(403);
    });

    test("shows backup page for owner", async () => {
      const { response } = await adminGet("/admin/backup");
      await expectHtmlResponse(
        response,
        200,
        "Database Backup",
        "Encryption Key",
      );
    });

    test("shows encryption key on page", async () => {
      const { response } = await adminGet("/admin/backup");
      const html = await response.text();
      expect(html).toContain("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    });

    test("shows storage not configured message when storage is disabled", async () => {
      const { response } = await adminGet("/admin/backup");
      const html = await response.text();
      expect(html).toContain("Storage is not configured");
    });
  });

  describe("POST /admin/backup/create", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/backup/create", {}),
      );
      expectAdminRedirect(response);
    });

    test("creates backup and redirects with success", async () => {
      await withLocalStorageEnabled(async () => {
        await createTestEvent({ name: "Backup Test Event" });
        const { response } = await adminFormPost("/admin/backup/create");
        expectRedirectWithFlash("/admin/backup")(response);
      });
    });

    test("backup list ignores non-zip files with backup prefix", async () => {
      await withLocalStorageEnabled(async () => {
        // Upload a non-zip file with backup- prefix (e.g. leftover temp file)
        await uploadRaw(new Uint8Array(0), "backup-stale.tmp");
        // Create a real backup
        const { response: createResp } = await adminFormPost(
          "/admin/backup/create",
        );
        expectRedirectWithFlash("/admin/backup")(createResp);

        // The page should only list .zip backups, not the .tmp file
        const { response } = await adminGet("/admin/backup");
        const html = await response.text();
        expect(html).not.toContain("backup-stale.tmp");
        expect(html).toContain(".zip");
      });
    });
  });

  describe("GET /admin/backup/download/:filename", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/backup/download/backup-test.zip"),
      );
      expectAdminRedirect(response);
    });

    test("returns 400 for invalid filename", async () => {
      const { response } = await adminGet(
        "/admin/backup/download/not-a-backup.txt",
      );
      expect(response.status).toBe(400);
    });

    test("returns 404 for missing file", async () => {
      await withLocalStorageEnabled(async () => {
        const { response } = await adminGet(
          "/admin/backup/download/backup-2024-test.zip",
        );
        expect(response.status).toBe(404);
      });
    });

    test("downloads existing backup as zip", async () => {
      await withLocalStorageEnabled(async () => {
        // Create a backup first
        await adminFormPost("/admin/backup/create");

        // List backups from the page
        const { response: listResp } = await adminGet("/admin/backup");
        const html = await listResp.text();
        const linkMatch = html.match(
          /\/admin\/backup\/download\/(backup-[^"]+\.zip)/,
        );
        expect(linkMatch).toBeTruthy();

        // Download it
        const { response } = await adminGet(
          `/admin/backup/download/${linkMatch![1]}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/zip");
        expect(response.headers.get("content-disposition")).toContain(".zip");
        const body = await response.arrayBuffer();
        expect(body.byteLength).toBeGreaterThan(0);
      });
    });
  });

  describe("POST /admin/backup/restore", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/backup/restore", {}),
      );
      expectAdminRedirect(response);
    });

    test("shows confirm page after uploading valid zip", async () => {
      await withLocalStorageEnabled(async () => {
        const zipData = await createBackupZip();
        const { cookie, csrfToken } = await getTestSession();
        const formData = new FormData();
        formData.append("csrf_token", csrfToken);
        formData.append(
          "backup_file",
          new File([zipData.buffer as ArrayBuffer], "backup.zip"),
        );
        const response = await handleRequest(
          new Request("http://localhost/admin/backup/restore", {
            method: "POST",
            headers: { cookie, host: "localhost" },
            body: formData,
          }),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Confirm Database Restore");
        expect(html).toContain("SQL statements");
      });
    });

    test("shows schema mismatch warning for zip with different schema hash", async () => {
      await withLocalStorageEnabled(async () => {
        const encoder = new TextEncoder();
        const manifest = JSON.stringify({
          schemaHash: "different-hash",
          latestUpdate: "test",
          timestamp: new Date().toISOString(),
          tables: {},
        });
        const fakeZip = zipSync({
          "manifest.json": encoder.encode(manifest),
          "settings.sql": new Uint8Array(0),
        });
        const { cookie, csrfToken } = await getTestSession();
        const formData = new FormData();
        formData.append("csrf_token", csrfToken);
        formData.append(
          "backup_file",
          new File([fakeZip.buffer as ArrayBuffer], "backup.zip"),
        );
        const response = await handleRequest(
          new Request("http://localhost/admin/backup/restore", {
            method: "POST",
            headers: { cookie, host: "localhost" },
            body: formData,
          }),
        );
        const html = await response.text();
        expect(html).toContain("Schema mismatch");
      });
    });

    test("rejects missing file field", async () => {
      await withLocalStorageEnabled(async () => {
        const { cookie, csrfToken } = await getTestSession();
        const formData = new FormData();
        formData.append("csrf_token", csrfToken);
        // No backup_file field at all
        const response = await handleRequest(
          new Request("http://localhost/admin/backup/restore", {
            method: "POST",
            headers: { cookie, host: "localhost" },
            body: formData,
          }),
        );
        expect(response.status).toBe(302);
      });
    });

    test("rejects empty file upload", async () => {
      await withLocalStorageEnabled(async () => {
        const { cookie, csrfToken } = await getTestSession();
        const formData = new FormData();
        formData.append("csrf_token", csrfToken);
        formData.append(
          "backup_file",
          new File([], "empty.zip"),
        );
        const response = await handleRequest(
          new Request("http://localhost/admin/backup/restore", {
            method: "POST",
            headers: { cookie, host: "localhost" },
            body: formData,
          }),
        );
        expect(response.status).toBe(302);
      });
    });

    test("rejects invalid zip file", async () => {
      await withLocalStorageEnabled(async () => {
        const { cookie, csrfToken } = await getTestSession();
        const formData = new FormData();
        formData.append("csrf_token", csrfToken);
        formData.append(
          "backup_file",
          new File([new ArrayBuffer(100)], "bad.zip"),
        );
        const response = await handleRequest(
          new Request("http://localhost/admin/backup/restore", {
            method: "POST",
            headers: { cookie, host: "localhost" },
            body: formData,
          }),
        );
        expect(response.status).toBe(302);
      });
    });
  });

  describe("POST /admin/backup/restore/confirm", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/backup/restore/confirm", {}),
      );
      expectAdminRedirect(response);
    });

    test("rejects filename without restore-pending prefix", async () => {
      const { response } = await adminFormPost(
        "/admin/backup/restore/confirm",
        {
          backup_filename: "backup-2024-test.zip",
          confirm_identifier: RESTORE_CONFIRM_PHRASE,
        },
      );
      expectRedirectWithFlash("/admin/backup")(response);
    });

    test("rejects filename without .zip extension", async () => {
      const { response } = await adminFormPost(
        "/admin/backup/restore/confirm",
        {
          backup_filename: "restore-pending-test.sql",
          confirm_identifier: RESTORE_CONFIRM_PHRASE,
        },
      );
      expectRedirectWithFlash("/admin/backup")(response);
    });

    test("rejects empty filename", async () => {
      const { response } = await adminFormPost(
        "/admin/backup/restore/confirm",
        {
          backup_filename: "",
          confirm_identifier: RESTORE_CONFIRM_PHRASE,
        },
      );
      expectRedirectWithFlash("/admin/backup")(response);
    });

    test("redirects with error when confirmation phrase is wrong", async () => {
      const { response } = await adminFormPost(
        "/admin/backup/restore/confirm",
        {
          backup_filename: "restore-pending-test.zip",
          confirm_identifier: "WRONG PHRASE",
        },
      );
      expectRedirectWithFlash("/admin/backup")(response);
    });

    test("redirects with error when backup file is missing", async () => {
      await withLocalStorageEnabled(async () => {
        const { response } = await adminFormPost(
          "/admin/backup/restore/confirm",
          {
            backup_filename: "restore-pending-nonexistent.zip",
            confirm_identifier: RESTORE_CONFIRM_PHRASE,
          },
        );
        expectRedirectWithFlash("/admin/backup")(response);
      });
    });

    test("successfully restores from uploaded backup", async () => {
      await withLocalStorageEnabled(async () => {
        await createTestEvent({ name: "Restore Me" });
        const zipData = await createBackupZip();

        // Upload the zip as a restore-pending file
        const tempFilename = "restore-pending-test-restore.zip";
        await uploadRaw(zipData, tempFilename);

        const { response } = await adminFormPost(
          "/admin/backup/restore/confirm",
          {
            backup_filename: tempFilename,
            confirm_identifier: RESTORE_CONFIRM_PHRASE,
          },
        );
        expectRedirectWithFlash("/admin/backup")(response);
      });
    });
  });
});
