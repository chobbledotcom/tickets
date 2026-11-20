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

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { clearTokenAttempts } from "#db/token-attempts.ts";
import { MAX_TOKEN_404S } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

/** Ask for one path and insist it answers `status`. */
const expectStatus = async (path: string, status: number): Promise<void> => {
  const response = await awaitTestRequest(path);
  expect(response.status).toBe(status);
};

/** Ask for `count` paths built by `pathFor`, and insist each answers `status`.
 *  A run of requests is what moves the miss count the guard keeps. */
const expectEachStatus = async (
  pathFor: (index: number) => string,
  count: number,
  status: number,
): Promise<void> => {
  for (let index = 0; index < count; index++) {
    await expectStatus(pathFor(index), status);
  }
};

describeWithEnv("ticket view rate limit", { db: true }, () => {
  // Tests use "direct" as the fallback IP, so each case starts from a clean
  // count rather than inheriting the one before it.
  const startClean = () => clearTokenAttempts("direct");

  // Any URL that records a miss counts towards the same lockout, so each case
  // guesses distinct codes on its own kind of request.
  for (const [what, pathFor, lockedPath] of [
    [
      "locks out after MAX_TOKEN_404S distinct misses",
      (index: number) => `/t/bad-token-${index}`,
      "/t/any-token",
    ],
    [
      "counts misses on the QR image towards the same lockout",
      (index: number) => `/t/bad-svg-${index}/svg`,
      "/t/some-token/svg",
    ],
  ] as const) {
    test(what, async () => {
      await startClean();

      await expectEachStatus(pathFor, MAX_TOKEN_404S, 404);

      await expectStatus(lockedPath, 429);
    });
  }

  test("never locks out on repeated tries of one wrong code", async () => {
    // Somebody following a stale link hits the same wrong code over and over;
    // only DISTINCT codes look like guessing.
    await startClean();

    await expectEachStatus(
      () => "/t/same-invalid-token",
      MAX_TOKEN_404S * 3,
      404,
    );

    await expectStatus("/t/other-invalid", 404);
  });

  test("never counts a ticket that was found", async () => {
    await startClean();
    const { token } = await createTestAttendeeWithToken("Hal", "hal@test.com");

    await expectEachStatus(() => `/t/${token}`, MAX_TOKEN_404S * 2, 200);

    await expectStatus(`/t/${token}`, 200);
  });

  test("clears earlier misses once a ticket is found", async () => {
    // Mistyping a code a few times and then getting it right is a person with
    // a ticket, so the count starts again rather than staying one miss from a
    // lockout for the rest of the window.
    await startClean();
    const { token } = await createTestAttendeeWithToken("Ivy", "ivy@test.com");

    await expectEachStatus(
      (index) => `/t/fatfinger-${index}`,
      MAX_TOKEN_404S - 1,
      404,
    );

    await expectStatus(`/t/${token}`, 200);

    await expectEachStatus(
      (index) => `/t/after-reset-${index}`,
      MAX_TOKEN_404S - 1,
      404,
    );

    await expectStatus("/t/probe", 404);
  });
});
