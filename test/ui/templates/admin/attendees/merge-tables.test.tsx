import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { formatCurrency } from "#shared/currency.ts";
import type {
  AttendeeMergeDiff,
  AttendeeMergeDiffBookingItem,
} from "#shared/merge/attendee-merge-types.ts";
import { MergeDecisionTables } from "#templates/admin/attendees/merge-tables.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { bookingRow as storedBookingRow } from "#test-utils/factories.ts";

const bookingRow = (
  overrides: Partial<ListingAttendeeRow> = {},
): ListingAttendeeRow => storedBookingRow({ listing_id: 7, ...overrides });

const bookingItem = (
  overrides: Partial<AttendeeMergeDiffBookingItem> = {},
): AttendeeMergeDiffBookingItem => ({
  conflictClass: "duplicate",
  listingId: 7,
  packageGroupId: 0,
  parentListingId: 0,
  sourceBooking: bookingRow(),
  sourceSaleAmount: 0,
  startAt: null,
  targetBooking: bookingRow(),
  targetSaleAmount: 0,
  ...overrides,
});

const diffWith = (
  overrides: Partial<AttendeeMergeDiff> = {},
): AttendeeMergeDiff => ({
  answerItems: [],
  bookingItems: [],
  piiFields: [],
  sourceId: 2,
  targetId: 1,
  version: "merge-v1",
  ...overrides,
});

const render = (diff: AttendeeMergeDiff): string =>
  String(
    <MergeDecisionTables
      diff={diff}
      sourceName="Source Person"
      targetName="Target Person"
    />,
  );

describe("MergeDecisionTables", () => {
  test("renders escaped PII choices with semantic row headers", () => {
    const html = render(
      diffWith({
        piiFields: [
          {
            field: "name",
            label: "Name",
            multiline: false,
            same: false,
            sourceValue: "Source <strong>name</strong>",
            targetValue: "Target <script>name</script>",
          },
          {
            field: "address",
            label: "Address",
            multiline: true,
            same: true,
            sourceValue: "",
            targetValue: "",
          },
        ],
      }),
    );

    expectIncludesAll(html, [
      "<th>Field</th><th>Keep current: Target Person</th><th>Use source: Source Person</th>",
      '<th scope="row">Name</th>',
      '<input checked name="pii_name" type="radio" value="target"> Target &lt;script&gt;name&lt;/script&gt;',
      '<input name="pii_name" type="radio" value="source"> Source &lt;strong&gt;name&lt;/strong&gt;',
    ]);
    assert(!html.includes("<script>name</script>"));
    assert(!html.includes("<strong>name</strong>"));
    expectIncludesAll(html, [
      '<th scope="row">Address</th>',
      '<span style="white-space:pre-wrap">—</span>',
      '<span class="muted">(same)</span>',
    ]);
    assert(!html.includes('name="pii_address" type="radio" value="source"'));
  });

  test("renders every required choice for a conflicting answer", () => {
    const html = render(
      diffWith({
        answerItems: [
          {
            conflict: true,
            questionId: 10,
            questionText: "Favourite colour?",
            sourceAnswerId: 2,
            sourceAnswerText: "Blue",
            targetAnswerId: 1,
            targetAnswerText: "Red",
          },
        ],
      }),
    );

    expectIncludesAll(html, [
      '<fieldset class="listing-section"><legend>Custom Question Answers</legend>',
      '<th scope="row">Favourite colour?</th>',
      '<input checked name="answer_10" type="radio" value="target"> Red',
      '<input name="answer_10" type="radio" value="source"> Blue',
      '<input name="answer_10" type="radio" value="clear"> None',
    ]);
  });

  test("labels non-conflicting answers without rendering controls", () => {
    const html = render(
      diffWith({
        answerItems: [
          {
            conflict: false,
            questionId: 11,
            questionText: "Target answer?",
            sourceAnswerId: null,
            sourceAnswerText: null,
            targetAnswerId: 3,
            targetAnswerText: "Target kept",
          },
          {
            conflict: false,
            questionId: 12,
            questionText: "Source answer?",
            sourceAnswerId: 4,
            sourceAnswerText: "Source kept",
            targetAnswerId: null,
            targetAnswerText: null,
          },
        ],
      }),
    );

    expectIncludesAll(html, [
      '<span class="muted">Target kept (target, kept automatically)</span>',
      '<span class="muted">Source kept (source, kept automatically)</span>',
      "<thead><tr><th>Question</th><th>Status</th></tr></thead>",
      '<tr><th scope="row">Source answer?</th><td><span class="muted">Source kept (source, kept automatically)</span></td></tr>',
    ]);
    assert(!html.includes('name="answer_11"'));
    assert(!html.includes('name="answer_12"'));
  });

  test("renders booking conflicts and paid money controls", () => {
    const paidStart = "2027-02-02T00:00:00.000Z";
    const paidKey = `7:${paidStart}:3:4`;
    const html = render(
      diffWith({
        bookingItems: [
          bookingItem({
            packageGroupId: 4,
            parentListingId: 3,
            sourceBooking: bookingRow({
              end_at: "2027-02-04T00:00:00.000Z",
              quantity: 2,
              start_at: paidStart,
            }),
            sourceSaleAmount: 1234,
            startAt: paidStart,
            targetBooking: bookingRow({ quantity: 5 }),
            targetSaleAmount: 567,
          }),
          bookingItem({
            conflictClass: "conflicting_metadata",
            listingId: 8,
            sourceBooking: bookingRow({ listing_id: 8, quantity: 3 }),
            targetBooking: bookingRow({ listing_id: 8 }),
          }),
          bookingItem({
            conflictClass: "moveable",
            listingId: 9,
            sourceBooking: bookingRow({ listing_id: 9 }),
            targetBooking: null,
          }),
        ],
      }),
    );

    expectIncludesAll(html, [
      "<th>Listing</th><th>Date</th><th>Source (qty)</th><th>Status</th><th>Decision</th>",
      "2–3 February 2027",
      "<strong>Duplicate</strong> Current quantity: 5. Source quantity: 2.",
      '<input checked name="booking_' +
        paidKey +
        '" type="radio" value="keep_target"> Keep current booking',
      '<input name="booking_' +
        paidKey +
        '" type="radio" value="take_source"> Use source booking',
      '<input name="booking_' +
        paidKey +
        '" type="radio" value="skip_source"> Skip source booking',
      `Source payment: ${formatCurrency(1234)}. Current payment: ${formatCurrency(567)}.`,
      `<input name="money_${paidKey}" type="radio" value="credit"> Keep it as credit for this person`,
      `<input name="money_${paidKey}" type="radio" value="writeoff"> Write it off`,
      "<strong>Conflicting metadata</strong> Current quantity: 1. Source quantity: 3.",
    ]);
    assert(!html.includes('name="money_8:null:0:0"'));
    assertStringIncludes(
      html,
      '<tr><td>Listing #9</td><td>—</td><td>1</td><td><span class="muted">Will be moved</span></td><td></td></tr>',
    );
    assert(!html.includes('name="booking_9:null:0:0"'));
  });

  test("omits decision columns when every booking can move", () => {
    const html = render(
      diffWith({
        bookingItems: [
          bookingItem({
            conflictClass: "moveable",
            listingId: 15,
            sourceBooking: bookingRow({ listing_id: 15, quantity: 4 }),
            targetBooking: null,
          }),
        ],
      }),
    );

    expectIncludesAll(html, [
      "Listing #15",
      '<span class="muted">Will be moved</span>',
    ]);
    assert(!html.includes("<th>Decision</th>"));
    assert(!html.includes('name="booking_15:null:0:0"'));
    assert(!html.includes("Custom Question Answers"));
  });

  test("fails clearly when a conflict has no target booking", () => {
    expect(() =>
      render(
        diffWith({
          bookingItems: [
            bookingItem({
              conflictClass: "conflicting_metadata",
              targetBooking: null,
            }),
          ],
        }),
      ),
    ).toThrow(
      "Missing target booking for conflicting_metadata merge conflict on listing 7",
    );
  });
});
