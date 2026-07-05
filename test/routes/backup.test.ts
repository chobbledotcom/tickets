import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  downloadRaw,
  runWithStorageConfig,
  uploadRaw,
} from "#shared/storage.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import {
  describeWithEnv,
  installUrlHandler,
  mockRequest,
  TEST_STORAGE_ZONE,
  testCookie,
  withFetchMock,
  withLocalStorageEnabled,
} from "#test-utils";

describeWithEnv("backup routes", { db: true }, () => {
  describe("GET /admin/backup", () => {
    test("loads backup page without storage enabled", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/backup", { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Backup");
    });

    test("loads backup page when storage cleanup fails (fire-and-forget)", async () => {
      const cookie = await testCookie();

      await withLocalStorageEnabled(async (dir) => {
        // Create a stale restore-pending file
        const pendingFile = `${dir}/restore-pending-stale.zip`;
        await Deno.writeTextFile(pendingFile, "stale data");

        // Make deleteFile throw
        setDeleteOverride(new Error("delete failed"));
        try {
          const response = await handleRequest(
            mockRequest("/admin/backup", { headers: { cookie } }),
          );
          // Page should still load despite deleteFile throwing
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Backup");
        } finally {
          setDeleteOverride(null);
        }
      });
    });

    test("loads backup page when stale cleanup listing fails", async () => {
      const cookie = await testCookie();

      await runWithStorageConfig(TEST_STORAGE_ZONE, () =>
        withFetchMock(async (originalFetch) => {
          let calls = 0;
          installUrlHandler(originalFetch, (url) => {
            if (!url.includes("storage.bunnycdn.com")) return null;
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error("list failed"))
              : Promise.resolve(Response.json([]));
          });

          const response = await handleRequest(
            mockRequest("/admin/backup", { headers: { cookie } }),
          );

          expect(response.status).toBe(200);
          expect(await response.text()).toContain("Backup");
        }),
      );
    });
  });

  describe("POST /admin/backup/restore/confirm", () => {
    test("completes restore even when temp file cleanup fails", async () => {
      const cookie = await testCookie();

      // Create a valid session with owner role
      const { getDb } = await import("#shared/db/client.ts");
      const { encrypt } = await import("#shared/crypto/encryption.ts");

      // Ensure user 1 is owner
      const adminLevel = await encrypt("owner");
      await getDb().execute({
        args: [adminLevel, 1],
        sql: "UPDATE users SET admin_level = ? WHERE id = 1",
      });

      // Create a minimal valid backup zip
      const { zipSync } = await import("fflate");
      const encoder = new TextEncoder();
      const { SCHEMA_HASH } = await import("#shared/db/migrations.ts");
      const zipData = zipSync({
        "manifest.json": encoder.encode(
          JSON.stringify({
            latestUpdate: "2024-01-01T00:00:00.000Z",
            schemaHash: SCHEMA_HASH,
            tables: {},
            timestamp: "2024-01-01T00:00:00.000Z",
          }),
        ),
      });

      const dir = await Deno.makeTempDir();
      try {
        // Upload the zip as a pending restore file
        const tempFilename = `restore-pending-${crypto.randomUUID()}.zip`;
        await runWithStorageConfig(
          { localPath: dir, zoneKey: "", zoneName: "" },
          async () => {
            await uploadRaw(zipData, tempFilename);
            await Deno.chmod(dir, 0o500);

            // Get CSRF token
            const csrfToken = await signCsrfToken();

            // Use URL-encoded form (action handlers default to form mode)
            const body = new URLSearchParams({
              backup_filename: tempFilename,
              confirm_phrase: "restore",
              csrf_token: csrfToken,
            });

            const request = new Request(
              "http://localhost/admin/backup/restore/confirm",
              {
                body: body.toString(),
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  cookie,
                },
                method: "POST",
              },
            );

            const response = await handleRequest(request);
            // Should succeed (redirect) even though deleteFile threw
            expect(response.status).toBe(302);
            const location = response.headers.get("location");
            expect(location).toContain("/admin/backup");
            expect(await downloadRaw(tempFilename)).not.toBeNull();
          },
        );
      } finally {
        await Deno.chmod(dir, 0o700).catch(() => {});
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
