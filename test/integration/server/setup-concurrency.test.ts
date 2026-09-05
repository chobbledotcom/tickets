import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { extractCsrfToken } from "#test-utils/csrf.ts";
import { createTestDb, describeWithEnv, resetDb } from "#test-utils/db.ts";
import { mockRequest, mockSetupFormRequest } from "#test-utils/mocks.ts";

describeWithEnv("server (setup concurrency)", { db: true }, () => {
  beforeEach(async () => {
    resetDb();
    await createTestDb();
  });

  test("concurrent setup posts only let one owner commit", async () => {
    let attempts = 0;
    let releaseAttempts!: () => void;
    const bothAttemptsStarted = new Promise<void>((resolve) => {
      releaseAttempts = resolve;
    });
    const originalComplete = settings.setup.complete;
    const completeStub = stub(
      settings.setup,
      "complete",
      async (...args: Parameters<typeof originalComplete>) => {
        attempts++;
        if (attempts === 2) releaseAttempts();
        await bothAttemptsStarted;
        await originalComplete(...args);
      },
    );

    try {
      const getToken = async (): Promise<string> => {
        const response = await handleRequest(mockRequest("/setup/"));
        const token = extractCsrfToken(await response.text());
        if (!token) throw new Error("Setup page did not include a CSRF token");
        return token;
      };

      const [firstToken, secondToken] = await Promise.all([
        getToken(),
        getToken(),
      ]);
      const postSetup = (
        username: string,
        csrfToken: string,
      ): Promise<Response> =>
        handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              admin_username: username,
              country: "GB",
            },
            csrfToken,
          ),
        );

      const responses = await Promise.all([
        postSetup("firstadmin", firstToken),
        postSetup("secondadmin", secondToken),
      ]);

      expect(
        responses.map((response) => response.headers.get("location")).sort(),
      ).toEqual(["/", "/setup/complete"]);
      const count = await getDb().execute(
        "SELECT COUNT(*) AS n FROM users AS user",
      );
      expect(Number(count.rows[0]!.n)).toBe(1);
      const setupDone = await getDb().execute({
        args: [CONFIG_KEYS.SETUP_COMPLETE],
        sql: "SELECT value FROM settings AS setting WHERE key = ?",
      });
      expect(setupDone.rows.map((row) => row.value)).toEqual(["true"]);
    } finally {
      completeStub.restore();
    }
  });
});
