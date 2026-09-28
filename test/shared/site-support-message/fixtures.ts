/**
 * Shared fixtures for the Support message module's tests: a readable site
 * record, a Bunny variables body, and the two assertions the Bunny and Deno
 * suites share.
 */

import { expect } from "@std/expect";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  type SupportMessageResult,
  supportMessageApi,
} from "#shared/site-support-message.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** A readable bunny site record for the module-level paths. */
export const bunnySite = (overrides: Partial<BuiltSite> = {}): BuiltSite => ({
  assignable: false,
  assignedAttendeeId: null,
  assignedListingId: null,
  created: "2026-01-01T00:00:00Z",
  dbProvider: "bunny",
  dbToken: "tok",
  dbUrl: "libsql://db",
  hostingId: "501",
  hostingProvider: "bunny",
  id: 1,
  name: "Bunny Site",
  readOnlyFrom: "",
  renewalToken: null,
  renewalTokenIndex: null,
  scheduledTaskKey: null,
  siteDataRevision: 1,
  siteUrl: "https://site.b-cdn.net",
  updates: "release",
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
  if (!result.ok) expect(result.error).toContain(contains);
};
