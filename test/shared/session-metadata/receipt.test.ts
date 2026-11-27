/** The receipt of a settled order keeps only the fields that a replay or the
 * buyer's return page reads. Every other order field goes, whatever it
 * holds. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isReceiptRecord, receiptRecord } from "#shared/session-metadata.ts";
import { blankMetadata } from "#test-utils/session-metadata.ts";

/** Every order field, each holding a value that names it. */
const EVERY_FIELD = Object.fromEntries(
  Object.keys(blankMetadata).map((field) => [field, `value of ${field}`]),
);

describe("the receipt of a settled order", () => {
  test("keeps the origin, the lines, the package picks, the balance target and the thank-you link, drops every other field, and marks itself", () => {
    expect(receiptRecord(EVERY_FIELD)).toEqual({
      _origin: "value of _origin",
      _receipt: "1",
      allocations: "value of allocations",
      balance_attendee_id: "value of balance_attendee_id",
      items: "value of items",
      thank_you_url: "value of thank_you_url",
    });
  });

  test("drops a field that no order field names", () => {
    expect(receiptRecord({ items: "[]", unknown: "Pat" })).toEqual({
      _receipt: "1",
      items: "[]",
    });
  });

  test("is told from an order by its mark, whatever the order holds", () => {
    expect([
      isReceiptRecord(receiptRecord(EVERY_FIELD)),
      isReceiptRecord(EVERY_FIELD),
      isReceiptRecord({}),
    ]).toEqual([true, false, false]);
  });
});
