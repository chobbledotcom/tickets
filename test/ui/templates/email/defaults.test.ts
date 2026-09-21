/**
 * The complete email that the site's default templates send — the mirror of
 * `src/ui/templates/email/defaults.ts`.
 *
 * Every other check here reads for a fragment, so a render that kept the
 * opening and lost the ticket link, a row, or a whole conditional block would
 * still pass. These read the whole email, so nothing can go missing quietly.
 *
 * One booking of one ticket on a free listing, with nothing owed, which is the
 * shape that leaves every conditional block out. The blocks themselves have
 * their own checks in `render-content.test.ts`.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  buildTemplateData,
  renderEmailContent,
  resetEngine,
} from "#shared/email-renderer.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { useSetting } from "#test-utils/settings.ts";
import type { EmailTemplateType } from "#types";

const TICKET_URL = "https://example.com/t/ABC";

const buildTestData = (
  entries: Parameters<typeof buildTemplateData>[0],
): Promise<Parameters<typeof renderEmailContent>[1]> =>
  buildTemplateData(entries, "GBP", TICKET_URL);

const WHOLE_EMAIL = {
  admin: {
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>New registration</h2>
<ul style="list-style:none;padding:0">
<li>Name: Jane Doe</li>
<li>Email: jane@example.com</li>
<li>Phone: 555-1234</li>


</ul>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Listing</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
<tr><td>Test Listing</td><td style="text-align:center">1</td><td style="text-align:center"></td></tr>
</table>
</div>`,
    subject: "New registration: Jane Doe for Test Listing",
    text: `New registration

Name: Jane Doe
Email: jane@example.com
Phone: 555-1234

Test Listing: 1 ticket`,
  },
  confirmation: {
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>Thanks for registering!</h2>
<p>You're confirmed for <strong>Test Listing</strong>.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Listing</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
<tr><td>Test Listing</td><td style="text-align:center">1</td><td style="text-align:center"></td></tr>
</table>
<p><a href="https://example.com/t/ABC" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px">View your tickets</a></p>
<p style="color:#666;font-size:14px">Or copy this link: https://example.com/t/ABC</p>
</div>`,
    subject: "Your tickets for Test Listing",
    text: `Thanks for registering!

You're confirmed for Test Listing.

Test Listing: 1 ticket

View your tickets: https://example.com/t/ABC`,
  },
} as const satisfies Record<EmailTemplateType, EmailContent>;

const EVERY_PART = ["subject", "html", "text"] as const;

describeWithEnv("the site's default email templates", { db: true }, () => {
  useSetting({ currency: "GBP" });
  beforeEach(resetEngine);
  afterEach(resetEngine);
  describe("the whole email the site's own wording sends", () => {
    for (const [which, whole] of Object.entries(WHOLE_EMAIL)) {
      for (const part of EVERY_PART) {
        test(`the ${which} email's ${part}, whole`, async () => {
          const data = await buildTestData([makeEntry()]);
          const sent = await renderEmailContent(
            which as EmailTemplateType,
            data,
          );

          expect(sent[part]).toBe(whole[part]);
        });
      }
    }
  });

  describe("the whole email a site-plan booking sends", () => {
    // Three units of a three-month plan buy one site with nine months. The
    // email keeps the ticket-shaped skeleton the sibling describe pins and
    // swaps only what the plan row's words change: the order's listing name
    // and the row's months, not tickets.
    const planData = (): Promise<Parameters<typeof renderEmailContent>[1]> =>
      buildTestData([
        makeEntry(
          {
            assign_built_site: true,
            initial_site_months: 3,
            name: "Site Plan",
          },
          { quantity: 3 },
        ),
      ]);

    const expected = (whole: EmailContent): EmailContent => ({
      html: whole.html
        .replaceAll("Test Listing", "Site Plan")
        .replace(
          '<td style="text-align:center">1</td>',
          '<td style="text-align:center">9 months of service</td>',
        ),
      subject: whole.subject.replaceAll("Test Listing", "Site Plan"),
      text: whole.text
        .replaceAll("Test Listing", "Site Plan")
        .replace("Site Plan: 1 ticket", "Site Plan: 9 months of service"),
    });

    for (const [which, whole] of Object.entries(WHOLE_EMAIL)) {
      const planned = expected(whole);
      for (const part of EVERY_PART) {
        test(`the ${which} email's ${part}, whole`, async () => {
          const sent = await renderEmailContent(
            which as EmailTemplateType,
            await planData(),
          );

          expect(sent[part]).toBe(planned[part]);
        });
      }
    }
  });
});
