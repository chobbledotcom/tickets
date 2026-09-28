/** The default registration emails: the admin notification names the listing
 * beside each answer; the buyer's confirmation prints the answers bare. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildTemplateData,
  renderEmailContent,
  type TemplateData,
} from "#shared/email-renderer.ts";
import type { OrderAnswerLines } from "#shared/email/answers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { TICKET_URL } from "#test/shared/email-renderer/test-helpers.ts";

const data = async (): Promise<TemplateData> => {
  const entries = [makeEntry()];
  const answerLines: OrderAnswerLines = new Map([
    [
      entries[0]!.attendee.id,
      new Map([
        [
          entries[0]!.listing.id,
          [{ question: "Any allergies?", text: "Peanuts <b>and</b> nuts" }],
        ],
      ]),
    ],
  ]);
  return buildTemplateData(entries, "GBP", TICKET_URL, { answerLines });
};

describeWithEnv("the default registration emails", { db: true }, () => {
  test("the admin notification prints each answer with its listing", async () => {
    const sent = await renderEmailContent("admin", await data());

    expect(sent.text).toContain(
      "Any allergies? (Test Listing): Peanuts <b>and</b> nuts",
    );
    expect(sent.html).toContain(
      "Any allergies? (Test Listing): Peanuts &lt;b&gt;and&lt;/b&gt; nuts",
    );
  });

  test("the buyer's confirmation prints each answer bare", async () => {
    const sent = await renderEmailContent("confirmation", await data());

    expect(sent.text).toContain("Any allergies?: Peanuts <b>and</b> nuts");
    expect(sent.html).toContain(
      "Any allergies?: Peanuts &lt;b&gt;and&lt;/b&gt; nuts",
    );
  });
});
