/**
 * Tests for the 404 rate limit on the token URLs /t/:tokens and /t/:token/svg
 *
 * Sits beside the story `@story:attendees.the-ticket-a-customer-holds`: the
 * story owns the ticket a holder opens, and these own the guard that stops
 * somebody guessing at codes — how many distinct misses lock an address out,
 * what does not count towards that, and that the QR image is guarded too. A
 * lockout is about counting attempts over time, which no single journey can
 * show.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { clearTokenAttempts } from "#db/token-attempts.ts";
import { MAX_TOKEN_404S } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

/** Ask for `count` distinct made-up codes, each labelled so no two repeat, and
 * insist every one is a plain miss rather than a lockout. */
const missDistinctCodes = async (
  label: string,
  count: number,
): Promise<void> => {
  for (let index = 0; index < count; index++) {
    const response = await awaitTestRequest(`/t/${label}-${index}`);
    expect(response.status).toBe(404);
  }
};

describeWithEnv("ticket view rate limit", { db: true }, () => {
  // Tests use "direct" as the fallback IP, so each case starts from a clean
  // count rather than inheriting the one before it.
  const startClean = () => clearTokenAttempts("direct");

  test("locks out after MAX_TOKEN_404S distinct misses", async () => {
    await startClean();

    await missDistinctCodes("bad-token", MAX_TOKEN_404S);

    const locked = await awaitTestRequest("/t/any-token");
    expect(locked.status).toBe(429);
  });

  test("counts misses on the QR image towards the same lockout", async () => {
    await startClean();

    for (let index = 0; index < MAX_TOKEN_404S; index++) {
      const response = await awaitTestRequest(`/t/bad-svg-${index}/svg`);
      expect(response.status).toBe(404);
    }

    const locked = await awaitTestRequest("/t/some-token/svg");
    expect(locked.status).toBe(429);
  });

  test("never locks out on repeated tries of one wrong code", async () => {
    // Somebody following a stale link hits the same wrong code over and over;
    // only DISTINCT codes look like guessing.
    await startClean();

    for (let index = 0; index < MAX_TOKEN_404S * 3; index++) {
      const response = await awaitTestRequest("/t/same-invalid-token");
      expect(response.status).toBe(404);
    }

    const stillAllowed = await awaitTestRequest("/t/other-invalid");
    expect(stillAllowed.status).toBe(404);
  });

  test("never counts a ticket that was found", async () => {
    await startClean();
    const { token } = await createTestAttendeeWithToken("Hal", "hal@test.com");

    for (let index = 0; index < MAX_TOKEN_404S * 2; index++) {
      const response = await awaitTestRequest(`/t/${token}`);
      expect(response.status).toBe(200);
    }

    const stillOk = await awaitTestRequest(`/t/${token}`);
    expect(stillOk.status).toBe(200);
  });

  test("clears earlier misses once a ticket is found", async () => {
    // Mistyping a code a few times and then getting it right is a person with
    // a ticket, so the count starts again rather than staying one miss from a
    // lockout for the rest of the window.
    await startClean();
    const { token } = await createTestAttendeeWithToken("Ivy", "ivy@test.com");

    await missDistinctCodes("fatfinger", MAX_TOKEN_404S - 1);

    const good = await awaitTestRequest(`/t/${token}`);
    expect(good.status).toBe(200);

    await missDistinctCodes("after-reset", MAX_TOKEN_404S - 1);

    const notLocked = await awaitTestRequest("/t/probe");
    expect(notLocked.status).toBe(404);
  });
});
