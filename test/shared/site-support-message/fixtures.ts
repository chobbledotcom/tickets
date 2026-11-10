/**
 * Shared fixtures for the Support message module's tests: a readable site
 * record, a Bunny variables body, and the two assertions the Bunny and Deno
 * suites share.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  type SupportMessageResult,
  supportMessageApi,
} from "#shared/site-support-message.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** A readable bunny site record for the module-level paths. */
export const bunnySite = (overrides: Partial<BuiltSite> = {}): BuiltSite =>
  testBuiltSite({
    dbToken: "tok",
    dbUrl: "libsql://db",
    hostingId: "501",
    name: "Bunny Site",
    siteDataRevision: 1,
    siteUrl: "https://site.b-cdn.net",
    ...overrides,
  });

/** A GET /compute/script/{id} body holding a variable list. */
export const scriptWithVariables = (
  variables: { DefaultValue?: string | null; Name: string | null }[],
): string => JSON.stringify({ EdgeScriptVariables: variables });

/** Assert what `readSupportMessage` returns while fetch answers with `reply`. */
export const expectReadWith = (
  reply: FetchReply,
  expected: SupportMessageResult,
): Promise<void> =>
  withMocks(
    () => stubFetch(reply),
    async () => {
      expect(
        await supportMessageApi.readSupportMessage("bunny", "501"),
      ).toEqual(expected);
    },
  );

/** Assert a failed result whose error contains `contains`. */
export const expectErrorResult = (
  result: SupportMessageResult,
  contains: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) assertStringIncludes(result.error, contains);
};
