import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { guide } from "#test-utils/guide.ts";

describeWithEnv("server (admin guide)", { db: true }, () => {
  describe("GET /admin/guide", () => {
    testRequiresAuth("/admin/guide");

    test("renders guide page when authenticated", async () => {
      await guide("Guide");
    });

    test("contains FAQ sections", async () => {
      await guide("Getting started", "Listings", "Payments", "Check-in");
    });

    test("renders ampersands in guide section titles once", async () => {
      const html = await guide(
        "Data &amp; privacy",
        "Daily listings &amp; holidays",
        "Check-in &amp; QR scanner",
      );

      expect(html).not.toContain("Data &amp;amp; privacy");
    });

    test("contains booking questions section", async () => {
      await guide(
        "Booking questions",
        "question with set answers",
        "shared by many listings",
        "Answers appear in the attendee table",
      );
    });

    test("contains public links section", async () => {
      await guide("Public links", "Facebook Sharing Debugger");
    });

    test("contains payment provider recommendation", async () => {
      await guide(
        "Which payment company do you recommend?",
        "quickest to set up",
      );
    });

    test("explains why places aren't held during checkout", async () => {
      await guide(
        "Why don't we hold places during checkout?",
        "scalpers",
        "money back automatically",
      );
    });

    test("contains add attendee info", async () => {
      await guide("Add Attendee");
    });

    test("contains payment setup section with Stripe instructions", async () => {
      await guide(
        "Payment setup",
        'id="payment-setup"',
        "Stripe Secret Key",
        "sk_test_",
        "dashboard.stripe.com",
      );
    });

    test("contains payment setup section with Square instructions", async () => {
      await guide(
        "create a Square application",
        "Square Access Token",
        "Square location ID",
        "developer.squareup.com",
        "payment.updated",
      );
    });

    test("contains test vs live credentials guidance", async () => {
      await guide(
        "Should I use test or live details?",
        "sandbox merchant account",
      );
    });

    test("contains SumUp setup with the API keys link and 401 guidance", async () => {
      await guide(
        "How do I set up SumUp?",
        "me.sumup.com/en-gb/settings/api-keys",
        "same SumUp account",
        "a sandbox key with a live merchant code",
        "401 Unauthorized",
      );
    });

    test("warns the SumUp public API key is not the one to use", async () => {
      await guide(
        "Public API key",
        "that is not the one you need",
        "Create API key",
      );
    });

    test("contains public site section", async () => {
      await guide("Public site", "homepage and contact page");
    });

    test("contains login security section", async () => {
      await guide(
        "Login &amp; security",
        "5 wrong tries",
        "15 minutes",
        "no password recovery",
        "blocked from logging in",
      );
    });

    test("explains the privacy-first CRM stance", async () => {
      await guide(
        "Why is this privacy-first instead of a CRM?",
        "stops short of that",
        "makes GDPR easier to follow",
        "legal duties",
        "listing webhooks are a good place to start",
      );
    });

    test("names the laws behind marketing emails", async () => {
      await guide(
        "What's the difference between a marketing and a service email?",
        "PECR covers marketing emails",
        "UK GDPR",
      );
    });

    test("states that email sending waits inside the booking reply", async () => {
      await guide(
        "What are email notifications?",
        "Emails are sent after the booking is saved",
        "The site waits for sending to finish before it replies",
      );
    });

    test("contains logistics guidance with the delivery area recipe", async () => {
      await guide(
        "How do I charge delivery by area?",
        "Which delivery area?",
        "Question answer",
        "not from their postcode",
        "Max times per order",
        "How do customers fill in their delivery address?",
        "Address lookup",
        "The customer does not set the map pin",
      );
    });

    test("says attendee deletion keeps the Money records", async () => {
      await guide(
        "How do I delete an attendee?",
        "removes the attendee and their payment record for good",
        "checkout and refund records cannot be changed or deleted",
      );
    });

    test("contains calendar and activity log sections", async () => {
      await guide("Calendar", "Activity log");
    });

    test("contains login lockout documentation", async () => {
      await guide(
        'id="login"',
        "too many wrong password tries",
        `${MAX_LOGIN_ATTEMPTS} wrong tries`,
        `${LOGIN_LOCKOUT_MS / 60_000} minutes`,
        "no password recovery",
      );
    });

    test("contains settings overview section", async () => {
      await guide("Settings overview", "Business email", "Site theme");
    });

    test("contains listing image, duplicate, and deactivate info", async () => {
      await guide("image to a listing", "Duplicate", "Deactivate");
    });

    test("contains allow pay more info with max price", async () => {
      await guide(
        "Allow pay more",
        "maximum",
        // formatCurrency strips the trailing zeros from whole amounts: £1.
        "at least £1 more than the ticket price",
      );
    });

    test("states the separate percentage caps for discounts and charges", async () => {
      await guide(
        "How do modifier values work?",
        "A discount can be at most 100",
        "A charge can be at most 10,000",
      );
    });

    test("anchors each linkable section", async () => {
      await guide(
        'id="text-formatting"',
        'id="packages"',
        'id="modifiers"',
        'id="questions"',
      );
    });

    test("contains purchase only info", async () => {
      await guide(
        "No check-in",
        "raffles, fundraisers, donations, merchandise",
        "Buy now",
        "QR codes",
        "left out of the calendar and news feeds",
      );
    });

    test("contains merge attendees info", async () => {
      await guide(
        "merge duplicate attendees",
        "ticket token",
        "the second attendee is deleted",
      );
    });

    test("contains resend notification info", async () => {
      await guide("resend a confirmation email", "Re-send Notification");
    });

    test("contains non-transferable tickets info", async () => {
      await guide("non-transferable", "ID required at entry", "ticket touts");
    });

    test("contains attendee editing info", async () => {
      await guide(
        "edit an attendee",
        "Listing Registrations",
        "Add to Listing",
      );
    });

    test("contains text formatting section", async () => {
      await guide(
        "Text formatting",
        'id="text-formatting"',
        "Markdown",
        "markdownguide.org/cheat-sheet",
      );
    });

    test("explains the visual markdown editor", async () => {
      await guide(
        "How does the visual editor work?",
        "Edit markdown",
        "Edit visually",
        "stored as plain Markdown",
      );
    });

    test("contains hidden listings info", async () => {
      await guide(
        "hide a listing",
        "Hidden Listing",
        "search engines are told to leave their ticket pages alone",
      );
    });

    test("contains testing your system section", async () => {
      await guide(
        "Testing your system",
        "make a test booking from start to finish",
        "This project is new",
        "hello@chobble.com",
      );
    });

    test("contains admin navigation", async () => {
      await guide("/admin/guide", "Listings", "Log out");
    });

    test("contains Google Wallet section", async () => {
      await guide(
        "Google Wallet",
        "Add to Google Wallet",
        "Issuer ID",
        "Service Account Email",
        "Service Account Private Key",
        "<code>private_key</code> value from the service account",
        "Google Cloud project where the Google Wallet API is switched on",
      );
    });

    test("documents the debug page including system limits", async () => {
      await guide(
        "/admin/debug",
        "every system limit",
        "environment variable",
        "old data was last cleaned up",
      );
    });

    test("contains admin API section with auth and endpoint info", async () => {
      await guide(
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
      );
    });

    test("contains host subdomain section", async () => {
      await guide(
        "Host subdomain",
        "you do not need to change anything at a domain seller",
        "Can I use both a subdomain and a custom domain?",
      );
    });

    test("explains the address priority order for generated links", async () => {
      await guide(
        "Which address is used for ticket links and emails?",
        "once it has passed validation",
        "host subdomain",
      );
    });

    test("sends the CNAME record to the company that manages the domain's DNS", async () => {
      await guide(
        "How do I set up a custom domain?",
        "DNS settings for your domain name",
        "some domain names use a separate DNS company",
      );
    });

    test("contains host subdomain in advanced settings list", async () => {
      await guide("Host subdomain", "a free address for your site");
    });

    test("documents the release tag format shared with the update checker", async () => {
      await guide(
        "Software updates",
        "v2026-03-01-142500",
        "date and time it was built",
      );
    });

    test("contains read-only mode explanation aimed at end users", async () => {
      await guide(
        'id="read-only-mode"',
        "Read-only mode",
        "switched on by the company that runs your site",
        "behind on bills",
        "being fixed",
      );
    });

    test("contains the translated table column guide", async () => {
      await guide(
        t("guide.sections.column_order"),
        t("guide.a.customise_table_columns"),
        t("guide.table_columns.default_order"),
        t("guide.table_columns.attendee_hidden"),
        t("guide.a.column_format_filters"),
        t("guide.table_reference.tag"),
        t("guide.table_reference.label"),
        t("guide.table_reference.description"),
      );
    });
  });

  describe("guide section structure", () => {
    // Modifiers renders as its own <h3> section immediately before Booking
    // Questions, so the slice between those two headings is exactly the
    // Modifiers section's body — every <summary> in it is a Modifiers FAQ.
    test("Modifiers section contains exactly its own three FAQs", async () => {
      const html = await guide();
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
      const html = await guide();
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
