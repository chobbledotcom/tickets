import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildCreateListingResource } from "#routes/admin/listings-form.ts";
import { listingRecord } from "#shared/records/listings.ts";
import {
  activityMessages,
  getListingActivityLog,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { storedListingNames } from "#test-utils/db-helpers/listings.ts";
import { testFormParams } from "#test-utils/form-values.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";

/** Whether one batch statement writes an activity line. */
const writesActivityLog = (statement: Parameters<typeof statementSql>[0]) =>
  statementSql(statement).includes("activity_log");

/** Create one listing through the record, as the create page submits it. */
const createListing = (name: string) => {
  const form = testFormParams({
    max_attendees: "50",
    max_quantity: "5",
    name,
  });
  return buildCreateListingResource(form).create(form);
};

describe("the listing record's declaration", () => {
  test("names a listing on its pages", () => {
    expect(listingRecord.activityName).toBe("Listing");
  });
});

describeWithEnv("the listing record's commands", { db: true }, () => {
  test("logs a new listing on that listing's own activity log", async () => {
    const created = await createListing("Pottery day");
    if (!created.ok) throw new Error(created.error);

    expect(
      (await getListingActivityLog(created.row.id)).map(
        (entry) => entry.message,
      ),
    ).toEqual(["Listing 'Pottery day' created"]);
  });

  test("keeps the listing when its log line fails after the commit", async () => {
    const restore = wrapDbClient({
      batch: (statements) => {
        if (statements.some(writesActivityLog)) throw new Error("log down");
      },
      execute: () => null,
    });
    try {
      await expect(createListing("Kept listing")).rejects.toThrow("log down");
    } finally {
      restore();
    }
    expect(await storedListingNames()).toEqual(["Kept listing"]);
    expect(await activityMessages()).toEqual([]);
  });
});
