import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { buildMetadata } from "#shared/payment-helpers.ts";

/** The metadata of a one-line order that holds these listing answers. */
const metadataWith = (lineTextAnswerIds: BookingIntent["lineTextAnswerIds"]) =>
  buildMetadata({
    address: "",
    date: null,
    email: "pta@example.com",
    items: [{ e: 7, p: 0, q: 2 }],
    lineTextAnswerIds,
    name: "Parent",
    special_instructions: "",
  });

test("carries each listing's own free-text answers as line_text_answer_ids, and nothing when there are none", () => {
  const answers = { "7": [{ q: 3, s: 99 }], "8": [{ q: 3, s: 100 }] };
  const [carried, empty] = [metadataWith(answers), metadataWith({})];

  expect(JSON.parse(carried.line_text_answer_ids!)).toEqual(answers);
  expect("text_answer_ids" in carried).toBe(false);
  expect("line_text_answer_ids" in empty).toBe(false);
});
