/**
 * Wallet pass route fixtures shared by the Apple and Google wallet route
 * tests: make the attendee both routes render, ask for a pass, and assert
 * what either route answers.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { requireValue } from "#shared/required-value.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

/** Make the Alice attendee both wallet routes render and return her token.
 *  Configures the wallet first when the test needs one. */
export const walletAliceToken = async (
  configure?: () => Promise<unknown>,
): Promise<string> => {
  await configure?.();
  const { token } = await createTestAttendeeWithToken(
    "Alice",
    "alice@test.com",
  );
  return token;
};

/** Ask for a pass and insist the route reports it can serve none. */
export const expectWalletPass404 = async (passPath: string): Promise<void> => {
  const response = await awaitTestRequest(passPath);
  expect(response.status).toBe(404);
};

/** Ask for two attendees' passes in one request, which no pass answers. */
export const expectMultiTokenPass404 = async (
  passPath: (first: string, second: string) => string,
): Promise<void> => {
  const { token: first } = await createTestAttendeeWithToken("A", "a@test.com");
  const { token: second } = await createTestAttendeeWithToken(
    "B",
    "b@test.com",
  );
  await expectWalletPass404(passPath(first, second));
};

/** Insist the pass response lets a shared cache hold it for the hour. */
export const expectWalletCacheControl = (response: Response): void => {
  const cacheControl = requireValue(
    response.headers.get("Cache-Control"),
    "The wallet pass has no Cache-Control header.",
  );
  assertStringIncludes(cacheControl, "public");
  assertStringIncludes(cacheControl, "s-maxage=3600");
};

/** Insist a pass route answers GET only, leaving every other method to the
 *  next handler. */
export const expectPassRouteIgnoresNonGet = async (
  route: (request: Request, path: string, method: string) => Promise<unknown>,
  passPath: string,
): Promise<void> => {
  const request = new Request(`http://localhost${passPath}`, {
    method: "POST",
  });
  expect(await route(request, passPath, "POST")).toBeNull();
};
