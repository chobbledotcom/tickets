/**
 * Authenticating with an API key instead of a session cookie.
 *
 * The key travels as a Bearer token. A wrong key is counted against the
 * caller's address, so guessing runs out of tries, and every refusal is logged
 * with the reason it was refused.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import {
  ADMIN_API,
  type AuthPolicy,
  type AuthSession,
  getAuthenticatedApiKey,
  withAuth,
} from "#routes/auth.ts";
import { MAX_APIKEY_ATTEMPTS } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { createTestApiKeyToken, requestAsApiKey } from "#test-utils/session.ts";
import { CONTENT_ADMIN_LEVELS } from "#types";

const contentApi: AuthPolicy<"json"> = {
  allowApiKey: true,
  body: "json",
  roles: CONTENT_ADMIN_LEVELS,
};
const ownerApi: AuthPolicy<"json"> = {
  allowApiKey: true,
  body: "json",
  role: "owner",
};

/** A request carrying whatever the caller wants in the Authorization header. */
const withAuthorization = (value: string): Request =>
  new Request("http://localhost/api/admin/x", {
    headers: { authorization: value, host: "localhost" },
  });

const sessionFor = (request: Request): Promise<AuthSession | null> =>
  getAuthenticatedApiKey(request);

describeWithEnv("reading the Bearer token", { db: true }, () => {
  test("accepts a key sent the way the API documents it", async () => {
    const apiKey = await createTestApiKeyToken();

    const session = await sessionFor(withAuthorization(`Bearer ${apiKey}`));

    expect(session?.adminLevel).toBe("owner");
  });

  test("ignores a key sent without the Bearer word", async () => {
    const apiKey = await createTestApiKeyToken();

    expect(await sessionFor(withAuthorization(apiKey))).toBe(null);
  });

  test("ignores an authorization header of another scheme", async () => {
    const apiKey = await createTestApiKeyToken();

    expect(await sessionFor(withAuthorization(`Basic ${apiKey}`))).toBe(null);
  });

  test("ignores a scheme that only looks like Bearer", async () => {
    // "Bearer!" is the same length as "Bearer ", so a check that counted
    // characters instead of matching the word would let this through.
    const apiKey = await createTestApiKeyToken();

    expect(await sessionFor(withAuthorization(`Bearer!${apiKey}`))).toBe(null);
  });

  test("ignores a request with no authorization header at all", async () => {
    expect(await sessionFor(new Request("http://localhost/api/admin/x"))).toBe(
      null,
    );
  });
});

describeWithEnv("refusing a Bearer token", { db: true }, () => {
  const errors = setupErrorSpy();

  /** Create a real key, break it with `damage`, then require the request to be
   *  refused and the log to name `reason`. */
  const expectRefusedKey = async (
    reason: string,
    damage?: () => Promise<unknown>,
  ): Promise<void> => {
    const apiKey = await createTestApiKeyToken();
    await damage?.();

    expect(await sessionFor(withAuthorization(`Bearer ${apiKey}`))).toBe(null);
    expect(errors.contains(reason)).toBe(true);
  };

  test("says the token matched no key", async () => {
    expect(await sessionFor(withAuthorization("Bearer nonsense"))).toBe(null);
    expect(errors.contains("Bearer token does not match any API key")).toBe(
      true,
    );
  });

  test("counts each wrong token and locks the caller out", async () => {
    for (let attempt = 0; attempt < MAX_APIKEY_ATTEMPTS; attempt++) {
      await sessionFor(withAuthorization(`Bearer wrong-${attempt}`));
    }

    // The lockout is by address, so even the real key is refused while it
    // holds — that is what makes the counting observable.
    await expectRefusedKey("API key authentication rate limited");
  });

  test("says the key's stored data key could not be opened", async () => {
    await expectRefusedKey("API key wrapped data key corrupted", () =>
      execute(
        sql`UPDATE api_keys SET wrapped_data_key = ${"not-a-wrapped-key"} WHERE user_id = 1`,
      ),
    );
  });

  test("says the key points at a user who is gone", async () => {
    await expectRefusedKey("API key references non-existent user", () =>
      execute(sql`UPDATE api_keys SET user_id = 9999 WHERE user_id = 1`),
    );
  });
});

describeWithEnv("which JSON policies accept a key", { db: true }, () => {
  const answerRole = (policy: typeof ADMIN_API) => async (request: Request) =>
    await withAuth(request, policy, (session) =>
      Promise.resolve(new Response(session.adminLevel)),
    );

  for (const [name, policy] of [
    ["admin API", ADMIN_API],
    ["owner API", ownerApi],
    ["content API", contentApi],
  ] as const) {
    test(`the ${name} does`, async () => {
      const apiKey = await createTestApiKeyToken();

      const response = await answerRole(policy)(
        requestAsApiKey("/api/admin/x", apiKey),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("owner");
    });
  }
});
