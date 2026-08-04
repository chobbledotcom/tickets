/**
 * Finishing a booking must cost the same handful of database calls whether the
 * order holds one line or twenty. Bunny stops an edge request after 50
 * subrequests, and a booking that logs a row per line — or prices a package per
 * package — would run out on a big order.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import type { EmailEntry } from "#shared/email.ts";
import {
  logAndNotifyRegistration,
  sendRegistrationWebhooks,
} from "#shared/webhook.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** Enough for the fixed reads, far below one read per line or per package. */
const REGISTRATION_CALL_LIMIT = 10;

describeWithEnv("registration notification budget", { db: true }, () => {
  stubFetchEachTest(() => new Response());

  /** One booking line per listing, all sharing one webhook URL. */
  const orderEntries = async (
    label: string,
    lineCount: number,
  ): Promise<EmailEntry[]> => {
    const entries: EmailEntry[] = [];
    for (let index = 0; index < lineCount; index++) {
      const listing = await createTestListing({
        name: `${label} listing ${index}`,
        webhookUrl: "https://example.com/hook",
      });
      entries.push(
        makeEntry(
          {
            id: listing.id,
            name: listing.name,
            slug: listing.slug,
            webhook_url: "https://example.com/hook",
          },
          { id: listing.id },
        ),
      );
    }
    return entries;
  };

  /** One booking line per package, each line stamped with its own package. */
  const packagedEntries = async (
    label: string,
    packageCount: number,
  ): Promise<EmailEntry[]> => {
    const entries: EmailEntry[] = [];
    for (let index = 0; index < packageCount; index++) {
      const group = await createTestGroup({
        isPackage: true,
        name: `${label} package ${index}`,
      });
      const member = await createTestListing({
        groupId: group.id,
        name: `${label} member ${index}`,
        unitPrice: 0,
        webhookUrl: "https://example.com/hook",
      });
      await setGroupPackageMembers(group.id, [
        { listingId: member.id, price: 500 },
      ]);
      entries.push(
        makeEntry(
          {
            id: member.id,
            name: member.name,
            slug: member.slug,
            webhook_url: "https://example.com/hook",
          },
          { id: member.id, package_group_id: group.id },
        ),
      );
    }
    return entries;
  };

  test("logs eight booking lines in the same reads as one", async () => {
    const one = await orderEntries("Single", 1);
    const eight = await orderEntries("Many", 8);
    const calls = (entries: EmailEntry[]): Promise<number> =>
      countDatabaseCalls(REGISTRATION_CALL_LIMIT, () =>
        logAndNotifyRegistration(entries),
      );

    expect(await calls(eight)).toBe(await calls(one));
  });

  test("prices six booked packages in the same reads as one", async () => {
    const one = await packagedEntries("Single", 1);
    const six = await packagedEntries("Many", 6);
    const calls = (entries: EmailEntry[]): Promise<number> =>
      countDatabaseCalls(REGISTRATION_CALL_LIMIT, () =>
        sendRegistrationWebhooks(entries, "GBP"),
      );

    expect(await calls(six)).toBe(await calls(one));
  });
});
