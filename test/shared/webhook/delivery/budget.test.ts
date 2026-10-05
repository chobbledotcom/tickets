/**
 * Finishing a booking must cost the same handful of database calls whether the
 * order holds one line or twenty. Bunny stops an edge request after 50
 * subrequests, and a booking that logs a row per line — or prices a package per
 * package — would run out on a big order.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import type { EmailEntry } from "#shared/email.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import {
  logAndNotifyRegistration,
  sendRegistrationWebhooks,
} from "#shared/webhook/delivery.ts";
import { stubWebhookFetch } from "#test/shared/webhook/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** Enough for the fixed reads, far below one read per line or per package. */
const REGISTRATION_CALL_LIMIT = 10;

describeWithEnv("registration notification budget", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

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
    webhookUrl = "https://example.com/hook",
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
        webhookUrl,
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
            webhook_url: webhookUrl,
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
        runWithPendingWork(() => logAndNotifyRegistration(entries)),
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

  test("does not read package facts when email and webhooks are off", async () => {
    const entries = await packagedEntries("Disabled", 1, "");

    // A generous limit keeps the counter honest: a call past a tight limit
    // throws without being counted, and pending work swallows the throw.
    expect(
      await countDatabaseCalls(REGISTRATION_CALL_LIMIT, () =>
        runWithPendingWork(() => logAndNotifyRegistration(entries)),
      ),
    ).toBe(1);
  });

  test("loads free package facts once when a webhook is enabled", async () => {
    const entries = await packagedEntries("Enabled", 1);

    expect(
      await countDatabaseCalls(REGISTRATION_CALL_LIMIT, () =>
        runWithPendingWork(() => logAndNotifyRegistration(entries)),
      ),
    ).toBe(4);
  });

  test("shares one package fact load between webhook and email", async () => {
    const entries = await packagedEntries("Shared", 1);
    await configureTestEmail();

    // The one load serves both senders: the count stays at the email-off
    // flow's calls plus the email send's own two, not two fact loads.
    expect(
      await countDatabaseCalls(REGISTRATION_CALL_LIMIT, () =>
        runWithPendingWork(() => logAndNotifyRegistration(entries)),
      ),
    ).toBe(6);
  });

  test("reads package facts before an oversized webhook list refuses the send", async () => {
    // Seventeen distinct webhook URLs pass MAX_REGISTRATION_WEBHOOK_URLS, so
    // the send refuses before its own facts read; the queue has already
    // priced the notification once. The || → && mutant skips that read and
    // reports a failed load through the weaker incident path.
    const groups: EmailEntry[][] = [];
    for (let index = 0; index < 17; index += 1) {
      groups.push(
        await packagedEntries(
          `Oversized${index}`,
          1,
          `https://hook-${index}.example.com/hook`,
        ),
      );
    }

    expect(
      await countDatabaseCalls(REGISTRATION_CALL_LIMIT, () =>
        runWithPendingWork(() => logAndNotifyRegistration(groups.flat())),
      ),
    ).toBe(5);
  });

  test("uses supplied package facts without reading the database", async () => {
    const [storedEntry] = await packagedEntries("Supplied", 1);
    const entry = {
      ...storedEntry!,
      listing: { ...storedEntry!.listing, name: "Supplied package" },
    };
    const groupId = entry.attendee.package_group_id;
    const facts: RegistrationPackageFacts = {
      displays: new Map([
        [groupId, { hideListings: false, name: "Supplied package" }],
      ]),
      pricingByGroup: new Map([
        [
          groupId,
          {
            dayPriceMap: new Map(),
            memberIds: new Set([entry.listing.id]),
            priceMap: new Map([[entry.listing.id, 500]]),
            quantityMap: new Map([[entry.listing.id, 1]]),
          },
        ],
      ]),
    };
    expect(
      await countDatabaseCalls(0, () =>
        sendRegistrationWebhooks([entry], "GBP", facts),
      ),
    ).toBe(0);
    const payload = fetchSpy.firstBody();
    expect(payload.tickets[0]!.listing_name).toBe("Supplied package");
    expect(payload.tickets[0]!.unit_price).toBe(500);
  });
});
