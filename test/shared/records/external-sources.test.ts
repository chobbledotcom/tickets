import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { externalSourceRecord } from "#shared/records/external-sources.ts";
import {
  expectCreateThenDelete,
  expectWrittenAndLogged,
} from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";
import { withTestSession } from "#test-utils/session.ts";

const PATTERN = "https://dashboard.stripe.com/invoices/{external_id}";
const LIMIT_NAME = "n".repeat(250);
const LIMIT_PATTERN = `https://${"u".repeat(242)}`;

/** One rule case: what it checks, the name and pattern, and the answer. */
const RULE_CASES: readonly [
  string,
  string,
  string,
  { error: string } | { name: string; urlPattern: string },
][] = [
  [
    "trims the name and the URL pattern it stores",
    "  Stripe  ",
    `  ${PATTERN}  `,
    { name: "Stripe", urlPattern: PATTERN },
  ],
  [
    "refuses an empty name before it reads the pattern",
    "   ",
    "",
    { error: "name cannot be empty" },
  ],
  [
    "refuses an empty URL pattern",
    "Stripe",
    "  ",
    { error: "url_pattern cannot be empty" },
  ],
  [
    "refuses a name past the text box limit",
    "n".repeat(251),
    PATTERN,
    { error: "name must be 250 characters or fewer" },
  ],
  [
    "refuses a URL pattern past the text box limit",
    "Stripe",
    `https://${"u".repeat(243)}`,
    { error: "url_pattern must be 250 characters or fewer" },
  ],
  [
    "accepts a name and a URL pattern at the limit",
    LIMIT_NAME,
    LIMIT_PATTERN,
    { name: LIMIT_NAME, urlPattern: LIMIT_PATTERN },
  ],
  [
    "refuses a URL pattern that is not a web address",
    "Stripe",
    "ftp://files",
    { error: "url_pattern must start with http:// or https://" },
  ],
];

describe("the external source rule", () => {
  for (const [title, name, urlPattern, answer] of RULE_CASES) {
    test(title, async () => {
      expect(
        await externalSourceRecord.rule({ name, urlPattern }, null),
      ).toEqual(
        "error" in answer
          ? { error: answer.error, ok: false }
          : { ok: true, value: answer },
      );
    });
  }
});

describeRecord(externalSourceRecord, "Source", null, () => {
  test("creates a source, reads it back, and logs it", async () => {
    await expectWrittenAndLogged(
      withTestSession(() =>
        externalSourceRecord.create({ name: "Stripe", urlPattern: PATTERN }),
      ),
      { id: 1, name: "Stripe", url_pattern: PATTERN },
      ["Source 'Stripe' created"],
    );
  });

  test("deletes a source and logs it", async () => {
    await withTestSession(async () => {
      await expectCreateThenDelete(
        externalSourceRecord,
        { name: "Old", urlPattern: PATTERN },
        ["Source 'Old' deleted", "Source 'Old' created"],
      );
      expect(await externalSourceRecord.getAll()).toEqual([]);
    });
  });
});
