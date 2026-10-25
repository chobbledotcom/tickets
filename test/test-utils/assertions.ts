/**
 * Shared response and result assertions. The redirect/flash helpers live in
 * `assertions/redirect.ts` and the page-body helpers in `assertions/html.ts`;
 * both re-exported here so tests keep one import path.
 *
 * `session.ts` and the DB query modules are imported on first call, never
 * statically: session.ts pulls the whole app (`#routes`) in, and this module
 * sits in the module graph of every test file.
 */

import { assertExists, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { expectAdminRedirect } from "./assertions/redirect.ts";

export * from "./assertions/html.ts";
export * from "./assertions/redirect.ts";

export const expectStatus =
  (status: number) =>
  (response: Response): Response => {
    expect(response.status).toBe(status);
    return response;
  };

export const expectActivityLogShows = async (
  name: string,
  verb: string,
): Promise<void> => {
  const { adminGet } = await import("#test-utils/session.ts");
  const response = await adminGet("/admin/log");
  const body = await response.text();
  assertStringIncludes(body, name);
  assertStringIncludes(body, verb);
};

const listingActivityLogHasMessage = async (
  listingId: number,
  substring: string,
): Promise<boolean> => {
  const { getListingActivityLog } = await import("#test-utils/activity-log.ts");
  const entries = await getListingActivityLog(listingId);
  return entries.some((entry) => entry.message.includes(substring));
};

type ListingActivityLogCheck = (
  listingId: number,
  substring: string,
) => Promise<void>;

/** Assert whether the listing's activity log holds an entry whose message
 * includes `substring` — one check, specialised below into the "has it" and
 * "has not" forms the tests read with. */
const expectListingActivityLog =
  (present: boolean) =>
  async (listingId: number, substring: string): Promise<void> => {
    expect(await listingActivityLogHasMessage(listingId, substring)).toBe(
      present,
    );
  };

/** Assert the listing's activity log has an entry whose message includes `substring`. */
export const expectListingActivityLogContains: ListingActivityLogCheck =
  expectListingActivityLog(true);

/** Assert the listing's activity log has no entry whose message includes `substring`. */
export const expectListingActivityLogLacks: ListingActivityLogCheck =
  expectListingActivityLog(false);

export const expectTestAttendeeCsvColumns = (
  row: string | undefined,
  quantity = 1,
): void => {
  assertExists(row);
  assertStringIncludes(row, "John Doe");
  assertStringIncludes(row, "john@example.com");
  assertStringIncludes(row, `,${quantity},`);
};

/** Asserts a response is a 200 CSV download with the standard
 *  Content-Disposition: attachment header, whose filename contains
 *  `filenameFragment` — the shared header contract behind every CSV export
 *  route (listing exports, calendar exports, etc). */
export const expectCsvDownloadHeaders = (
  response: Response,
  filenameFragment: string,
): void => {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  const disposition = response.headers.get("content-disposition");
  assertExists(disposition);
  assertStringIncludes(disposition, "attachment");
  assertStringIncludes(disposition, filenameFragment);
};

/** Fetch a listing's CSV export as the given admin, assert 200, return the body. */
export const fetchListingExportCsv = async (
  listingId: number,
  cookie: string,
  query = "",
): Promise<string> => {
  const response = await awaitTestRequest(
    `/admin/listing/${listingId}/export${query}`,
    { cookie },
  );
  expect(response.status).toBe(200);
  return await response.text();
};

export const expectJsonResponse =
  <T = any>(status: number, assertions?: (body: T) => void) =>
  async (response: Response): Promise<T> => {
    expect(response.status).toBe(status);
    const body = (await response.json()) as T;
    assertions?.(body);
    return body;
  };

export const assertJson = async <T = any>(
  request: Promise<Response>,
  status: number,
  assertions?: (body: T) => void,
): Promise<T> => {
  const response = await request;
  return expectJsonResponse<T>(status, assertions)(response);
};

/** PUT `{ name: "" }` to a JSON API entity endpoint and assert the standard
 *  400 "name cannot be empty" rejection. The PUT-name-empty validation is
 *  shared by every writable-named admin entity (holidays, groups, listings),
 *  so hoisting the assertion here keeps each api test focused on the
 *  behaviour specific to that resource. */
export const expectRejectsEmptyName = async (path: string): Promise<void> => {
  const { apiRequest } = await import("#test-utils/session.ts");
  await assertJson(
    apiRequest(path, { body: { name: "" }, method: "PUT" }),
    400,
    (body) => {
      expect(body.error).toBe("name cannot be empty");
    },
  );
};

/** DELETE a named resource via the admin JSON API with a confirmation and
 *  assert the standard `{ status: "ok" }` 200 response. */
export const assertApiDeleteOk = async (
  url: string,
  confirmationName: string,
): Promise<void> => {
  const { apiRequest } = await import("#test-utils/session.ts");
  await assertJson(
    apiRequest(url, {
      body: { confirm_identifier: confirmationName },
      method: "DELETE",
    }),
    200,
    (body) => {
      expect(body.status).toBe("ok");
    },
  );
};

/** Asserts each listing in `expectations` ended up with exactly `count` raw
 *  attendee rows, and (when given) that the single resulting attendee's
 *  `quantity` matches. This is the "who got booked, and for how many" check
 *  repeated after almost every multi-listing booking POST. */
export const expectAttendeeCounts = async (
  expectations: { count: number; listingId: number; quantity?: number }[],
): Promise<void> => {
  const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
  for (const { count, listingId, quantity } of expectations) {
    const attendees = await getAttendeesRaw(listingId);
    expect(attendees.length).toBe(count);
    if (quantity !== undefined) expect(attendees[0]?.quantity).toBe(quantity);
  }
};

export const expectResultError =
  (expectedError: string) =>
  <T extends { ok: boolean; error?: string }>(result: T): T => {
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toBe(expectedError);
    }
    return result;
  };

export const expectResultNotFound = <
  T extends { ok: boolean; notFound?: boolean },
>(
  result: T,
): T => {
  expect(result.ok).toBe(false);
  expect("notFound" in result && result.notFound).toBe(true);
  return result;
};

/** Assert `fn` throws an error of `errorClass` and (optionally) whose message
 *  matches `pattern`. Runs `fn` twice — once per assertion — so only use for
 *  idempotent predicates (validators, pure checks), not stateful operations. */
export const expectThrows = (
  fn: () => unknown,
  errorClass: any,
  pattern?: RegExp,
): void => {
  expect(fn).toThrow(errorClass);
  if (pattern !== undefined) expect(fn).toThrow(pattern);
};

/** Await `promise` expecting it to reject, and return the thrown error's
 *  message string. Useful when you need to assert on a substring of the
 *  message (Deno's `rejects.toThrow` doesn't return the message). */
export const rejectionMessage = async (
  promise: Promise<unknown>,
): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};

export const matchGroup = (text: string, pattern: RegExp, group = 1): string =>
  text.match(pattern)![group]!;

interface TestRequiresAuthOptions {
  body?: Record<string, string>;
  method?: "GET" | "POST";
  multipart?: boolean;
  /** Optional per-test preparation. Return a cleanup function to undo any
   * state the setup switched (e.g. the restore from `withEnv`) — module
   * state left switched leaks into every test that runs after this one. */
  setup?: () => Promise<(() => void) | undefined> | Promise<void>;
}

export const testRequiresAuth = (
  path: string,
  options: TestRequiresAuthOptions = {},
): void => {
  it("redirects to login when not authenticated", async () => {
    const cleanup = await options.setup?.();
    try {
      const request = options.multipart
        ? mockMultipartRequest(path, options.body!)
        : options.method === "POST"
          ? mockFormRequest(path, options.body!)
          : mockRequest(path);
      const response = await handleRequest(request);
      expectAdminRedirect(response);
    } finally {
      cleanup?.();
    }
  });
};

/** Assert each stored column value is an `enc:` ciphertext envelope (encrypted
 * at rest, never plaintext). */
export const expectEncryptedAtRest = (
  ...values: Array<string | undefined>
): void => {
  for (const value of values) {
    expect(value?.startsWith("enc:")).toBe(true);
  }
};
