import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { RESTORE_CONFIRM_PHRASE } from "#templates/admin/backup.tsx";
import { handleRequest } from "#routes";
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
  });
});
