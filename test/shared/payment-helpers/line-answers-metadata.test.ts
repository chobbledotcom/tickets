import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildMetadata } from "#shared/payment-helpers.ts";

describe("buildMetadata > answers that ask once for each listing", () => {
  test("carries each listing's own free-text answers as line_text_answer_ids", () => {
    const metadata = buildMetadata({
      address: "",
      date: null,
      email: "pta@example.com",
      items: [
        { e: 7, p: 0, q: 2 },
        { e: 8, p: 0, q: 2 },
      ],
      lineTextAnswerIds: {
        "7": [{ q: 3, s: 99 }],
        "8": [{ q: 3, s: 100 }],
      },
      name: "Parent",
      special_instructions: "",
    });

    expect(JSON.parse(metadata.line_text_answer_ids!)).toEqual({
      "7": [{ q: 3, s: 99 }],
      "8": [{ q: 3, s: 100 }],
    });
    expect("text_answer_ids" in metadata).toBe(false);
  });

  test("omits line_text_answer_ids when no listing has its own answer", () => {
    const metadata = buildMetadata({
      address: "",
      date: null,
      email: "free@example.com",
      items: [{ e: 7, p: 0, q: 1 }],
      lineTextAnswerIds: {},
      name: "Freya",
      special_instructions: "",
    });

    expect("line_text_answer_ids" in metadata).toBe(false);
  });
});
