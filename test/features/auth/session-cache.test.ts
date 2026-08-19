/**
 * Working out who is calling, once per request.
 *
 * The answer is kept for the rest of the request, so a route that asks again
 * after the router already asked does not go back to the database. A request
 * that turns out to be nobody is remembered too.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { createSession } from "#db/sessions.ts";
import {
  getAuthenticatedApiKey,
  getAuthenticatedSession,
} from "#routes/auth.ts";
import { getSessionCookieName } from "#shared/cookies.ts";
import { runWithSessionContext } from "#shared/session-context.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  createTestApiKeyToken,
  getTestSession,
  requestAsApiKey,
} from "#test-utils/session.ts";

const requestWith = (cookie?: string): Request =>
  new Request("http://localhost/admin/", {
    headers: cookie ? { cookie, host: "localhost" } : { host: "localhost" },
  });

const cookieFor = (token: string) => `${getSessionCookieName()}=${token}`;

describeWithEnv("who is calling, kept for the request", { db: true }, () => {
  test("answers the same session after the row it came from is gone", async () => {
    const { cookie } = await getTestSession();

    await runWithSessionContext(async () => {
      const first = await getAuthenticatedSession(requestWith(cookie));
      expect(first?.adminLevel).toBe("owner");

      await execute("DELETE FROM sessions");

      expect(await getAuthenticatedSession(requestWith(cookie))).toEqual(first);
    });
  });

  test("answers nobody again after a session appears mid-request", async () => {
    // The first ask settles the question. A row created afterwards belongs to
    // the next request, not this one.
    const token = "a-token-nothing-knows-yet";

    await runWithSessionContext(async () => {
      expect(await getAuthenticatedSession(requestWith(cookieFor(token)))).toBe(
        null,
      );

      await createSession(token, "csrf", Date.now() + 60_000, null, 1);

      expect(await getAuthenticatedSession(requestWith(cookieFor(token)))).toBe(
        null,
      );
    });
  });

  test("keeps an API key's answer for whatever asks next", async () => {
    // The request carries no cookie, so anything that asks for the session
    // after the key was accepted would otherwise be told nobody is there.
    const apiKey = await createTestApiKeyToken();
    const request = requestAsApiKey("/api/admin/x", apiKey);

    await runWithSessionContext(async () => {
      const byKey = await getAuthenticatedApiKey(request);
      expect(byKey?.adminLevel).toBe("owner");

      expect(await getAuthenticatedSession(request)).toEqual(byKey);
    });
  });
});

describeWithEnv("a session that cannot be honoured", { db: true }, () => {
  const errors = setupErrorSpy();

  test("is refused when it has run out", async () => {
    const token = "expired-token";
    await createSession(token, "csrf", Date.now() - 1000, null, 1);

    await runWithSessionContext(async () => {
      expect(await getAuthenticatedSession(requestWith(cookieFor(token)))).toBe(
        null,
      );
    });
  });

  test("is refused, and reported, when its user is gone", async () => {
    const token = "orphan-token";
    await createSession(token, "csrf", Date.now() + 60_000, null, 1);
    await execute("DELETE FROM users WHERE id = 1");

    await runWithSessionContext(async () => {
      expect(await getAuthenticatedSession(requestWith(cookieFor(token)))).toBe(
        null,
      );
    });

    expect(
      errors.contains("Session references non-existent user, invalidating"),
    ).toBe(true);
  });

  test("is refused when the request carries no cookie at all", async () => {
    await runWithSessionContext(async () => {
      expect(await getAuthenticatedSession(requestWith())).toBe(null);
    });
  });
});
