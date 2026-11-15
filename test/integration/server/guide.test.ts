import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { expectOmitsAll } from "#test-utils/assertions/omissions.ts";
import { testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectGuidePage } from "#test-utils/guide.ts";

/** One guide check: the test name, then the text the page must show. */
type GuideCheck = readonly [name: string, ...needles: string[]];

const guideChecks: readonly GuideCheck[] = [
  ["renders guide page when authenticated", "Guide"],
  [
    "contains FAQ sections",
    "Getting started",
    "Listings",
    "Payments",
    "Check-in",
  ],
  [
    "contains booking questions section",
    "Booking questions",
    "question with set answers",
  ],
  [
    "contains public links section",
    "Public links",
    "Facebook Sharing Debugger",
  ],
  [
    "contains payment provider recommendation",
    "Which payment company do you recommend?",
    "quickest to set up",
  ],
  [
    "explains why places aren't held during checkout",
    "Why don't we hold places during checkout?",
    "scalpers",
    "money back automatically",
  ],
  ["contains add attendee info", "Add Attendee"],
  [
    "contains payment setup section with Stripe instructions",
    "Payment setup",
    'id="payment-setup"',
    "Stripe Secret Key",
    "sk_test_",
    "dashboard.stripe.com",
  ],
  [
    "contains payment setup section with Square instructions",
    "create a Square application",
    "Square Access Token",
    "Square location ID",
    "developer.squareup.com",
    "payment.updated",
  ],
  [
    "contains test vs live credentials guidance",
    "Should I use test or live details?",
    "sandbox merchant account",
  ],
  [
    "contains SumUp setup with the API keys link and 401 guidance",
    "How do I set up SumUp?",
    "me.sumup.com/en-gb/settings/api-keys",
    "same SumUp account",
    "a sandbox key with a live merchant code",
    "401 Unauthorized",
  ],
  [
    "warns the SumUp public API key is not the one to use",
    "Public API key",
    "that is not the one you need",
    "Create API key",
  ],
  ["contains public site section", "Public site", "homepage and contact page"],
  [
    "contains login security section",
    "Login &amp; security",
    "5 wrong tries",
    "15 minutes",
    "no password recovery",
    "blocked from logging in",
  ],
  [
    "explains the privacy-first CRM stance",
    "Why is this privacy-first instead of a CRM?",
    "stops short of that",
    "makes GDPR easier to follow",
    "legal duties",
    "listing webhooks are a good place to start",
  ],
  [
    "names the laws behind marketing emails",
    "What's the difference between a marketing and a service email?",
    "PECR covers marketing emails",
    "UK GDPR",
  ],
  [
    "states that email sending waits inside the booking reply",
    "What are email notifications?",
    "Emails are sent after the booking is saved",
    "The site waits for sending to finish before it replies",
  ],
  [
    "contains logistics guidance with the delivery area recipe",
    "How do I charge delivery by area?",
    "Which delivery area?",
    "Question answer",
    "not from their postcode",
    "Max times per order",
    "How do customers fill in their delivery address?",
    "Address lookup",
    "The customer does not set the map pin",
  ],
  [
    "says attendee deletion keeps the Money records",
    "How do I delete an attendee?",
    "removes the attendee and their payment record for good",
    "checkout and refund records cannot be changed or deleted",
  ],
  ["contains calendar and activity log sections", "Calendar", "Activity log"],
  [
    "contains login lockout documentation",
    'id="login"',
    "too many wrong password tries",
    `${MAX_LOGIN_ATTEMPTS} wrong tries`,
    `${LOGIN_LOCKOUT_MS / 60_000} minutes`,
    "no password recovery",
  ],
  [
    "contains settings overview section",
    "Settings overview",
    "Business email",
    "Site theme",
  ],
  [
    "contains listing image, duplicate, and deactivate info",
    "image to a listing",
    "Duplicate",
    "Deactivate",
  ],
  [
    "contains allow pay more info with max price",
    "Allow pay more",
    "maximum",
    // formatCurrency strips the trailing zeros from whole amounts: £1.
    "at least £1 more than the ticket price",
  ],
  [
    "states the separate percentage caps for discounts and charges",
    "How do modifier values work?",
    "A discount can be at most 100",
    "A charge can be at most 10,000",
  ],
  [
    "anchors each linkable section",
    'id="text-formatting"',
    'id="packages"',
    'id="modifiers"',
    'id="questions"',
  ],
  [
    "contains purchase only info",
    "No check-in",
    "raffles, fundraisers, donations, merchandise",
    "Buy now",
    "QR codes",
    "left out of the calendar and news feeds",
  ],
  [
    "contains merge attendees info",
    "merge duplicate attendees",
    "ticket token",
    "the second attendee is deleted",
  ],
  [
    "contains resend notification info",
    "resend a confirmation email",
    "Re-send Notification",
  ],
  [
    "contains non-transferable tickets info",
    "non-transferable",
    "ID required at entry",
    "ticket touts",
  ],
  [
    "contains attendee editing info",
    "edit an attendee",
    "Listing Registrations",
    "Add to Listing",
  ],
  [
    "contains text formatting section",
    "Text formatting",
    'id="text-formatting"',
    "Markdown",
    "markdownguide.org/cheat-sheet",
  ],
  [
    "explains the visual markdown editor",
    "How does the visual editor work?",
    "Edit markdown",
    "Edit visually",
    "stored as plain Markdown",
  ],
  [
    "contains hidden listings info",
    "hide a listing",
    "Hidden Listing",
    "search engines are told to leave their ticket pages alone",
  ],
  [
    "contains testing your system section",
    "Testing your system",
    "make a test booking from start to finish",
    "This project is new",
    "hello@chobble.com",
  ],
  ["contains admin navigation", "/admin/guide", "Listings", "Log out"],
  [
    "contains Google Wallet section",
    "Google Wallet",
    "Add to Google Wallet",
    "Issuer ID",
    "Service Account Email",
    "Service Account Private Key",
    "<code>private_key</code> value from the service account",
    "Google Cloud project where the Google Wallet API is switched on",
  ],
  [
    "documents the debug page including system limits",
    "/admin/debug",
    "every system limit",
    "environment variable",
    "old data was last cleaned up",
  ],
  [
    "contains admin API section with auth and endpoint info",
    'id="admin-api"',
    "Admin API",
    "Authorization: Bearer YOUR_API_KEY",
    "only owners can use it",
    "shown only once",
    "/api/admin/listings",
    "/api/admin/groups",
    "/api/admin/holidays",
    "confirm_identifier",
    "Last used",
  ],
  [
    "contains host subdomain section",
    "Host subdomain",
    "you do not need to change anything at a domain seller",
    "Can I use both a subdomain and a custom domain?",
  ],
  [
    "explains the address priority order for generated links",
    "Which address is used for ticket links and emails?",
    "once it has passed validation",
    "host subdomain",
  ],
  [
    "sends the CNAME record to the company that manages the domain's DNS",
    "How do I set up a custom domain?",
    "DNS settings for your domain name",
    "some domain names use a separate DNS company",
  ],
  [
    "contains host subdomain in advanced settings list",
    "Host subdomain",
    "a free address for your site",
  ],
  [
    "documents the release tag format shared with the update checker",
    "Software updates",
    "v2026-03-01-142500",
    "date and time it was built",
  ],
  [
    "contains read-only mode explanation aimed at end users",
    'id="read-only-mode"',
    "Read-only mode",
    "switched on by the company that runs your site",
    "behind on bills",
    "being fixed",
  ],
  [
    "contains the translated table column guide",
    t("guide.sections.column_order"),
    t("guide.a.customise_table_columns"),
    t("guide.table_columns.default_order"),
    t("guide.table_columns.attendee_hidden"),
    t("guide.a.column_format_filters"),
    t("guide.table_reference.tag"),
    t("guide.table_reference.label"),
    t("guide.table_reference.description"),
  ],
];

describeWithEnv("server (admin guide)", { db: true }, () => {
  describe("GET /admin/guide", () => {
    testRequiresAuth("/admin/guide");

    for (const [name, ...needles] of guideChecks) {
      test(name, async () => {
        await expectGuidePage(...needles);
      });
    }

    test("renders ampersands in guide section titles once", async () => {
      const html = await expectGuidePage(
        "Data &amp; privacy",
        "Daily listings &amp; holidays",
        "Check-in &amp; QR scanner",
      );

      expectOmitsAll(html, ["Data &amp;amp; privacy"]);
    });
  });

  describe("guide section structure", () => {
    // Modifiers renders as its own <h3> section immediately before Booking
    // Questions, so the slice between those two headings is exactly the
    // Modifiers section's body — every <summary> in it is a Modifiers FAQ.
    test("Modifiers section contains exactly its own three FAQs", async () => {
      const html = await expectGuidePage();
      const start = html.indexOf(`>${t("guide.sections.modifiers")}</h3>`);
      const end = html.indexOf(
        `>${t("guide.sections.booking_questions")}</h3>`,
      );
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);

      const summaries = [
        ...html.slice(start, end).matchAll(/<summary>(.*?)<\/summary>/gs),
      ].map((match) => match[1] ?? "");

      expect(summaries).toEqual([
        t("guide.q.what_are_modifiers"),
        t("guide.q.how_modifier_values_work"),
        t("guide.q.modifier_value_precision"),
      ]);
    });

    // The original bug nested the Modifiers <Section> in the middle of the
    // Listings FAQ list, so its <h3> rendered before later listing FAQs and
    // pulled them under its heading. Pinning the Modifiers heading after the
    // last listing FAQ and before the next section catches any such regression.
    test("Modifiers heading sits after the listing FAQs, not in the middle", async () => {
      const html = await expectGuidePage();
      const indexOf = (needle: string): number => {
        const i = html.indexOf(needle);
        expect(i).toBeGreaterThanOrEqual(0);
        return i;
      };

      const lastListingFaq = indexOf(
        `<summary>${t("guide.q.add_terms_and_conditions")}</summary>`,
      );
      const modifiersHeading = indexOf(
        `>${t("guide.sections.modifiers")}</h3>`,
      );
      const nextSection = indexOf(
        `>${t("guide.sections.booking_questions")}</h3>`,
      );

      expect(modifiersHeading).toBeGreaterThan(lastListingFaq);
      expect(modifiersHeading).toBeLessThan(nextSection);
    });
  });
});
