import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { settings } from "#shared/db/settings.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import {
  adminGet,
  assertAdminHtml,
  describeWithEnv,
  expectHtmlResponse,
  setTestEnv,
  testRequiresAuth,
  validEmail,
} from "#test-utils";

describeWithEnv("server (admin guide)", { db: true }, () => {
  describe("GET /admin/guide", () => {
    testRequiresAuth("/admin/guide");

    test("renders guide page when authenticated", async () => {
      const { response } = await adminGet("/admin/guide");
      await expectHtmlResponse(response, 200, "Guide");
    });

    test("contains FAQ sections", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Getting Started",
        "Listings",
        "Payments",
        "Check-in",
      );
    });

    test("renders ampersands in guide section titles once", async () => {
      const html = await assertAdminHtml(
        "/admin/guide",
        "Data &amp; Privacy",
        "Daily Listings &amp; Holidays",
        "Check-in &amp; QR Scanner",
      );

      expect(html).not.toContain("Data &amp;amp; Privacy");
    });

    test("contains booking questions section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Booking Questions",
        "multiple-choice",
        "must select one",
        "shared across multiple listings",
        "attendee table on listing and group pages",
      );
    });

    test("contains public links section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Public Links",
        "Facebook Sharing Debugger",
      );
    });

    test("contains payment provider recommendation", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Which payment provider do you recommend?",
        "setup is a fair bit easier",
      );
    });

    test("explains why places aren't held during checkout", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Why don't we hold places during checkout?",
        "scalpers",
        "automatically refunded",
      );
    });

    test("contains add attendee info", async () => {
      await assertAdminHtml("/admin/guide", "Add Attendee");
    });

    test("contains payment setup section with Stripe instructions", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Payment Setup",
        'id="payment-setup"',
        "Stripe secret key",
        "sk_test_",
        "dashboard.stripe.com",
      );
    });

    test("contains payment setup section with Square instructions", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "create a Square application",
        "Square access token",
        "Square location ID",
        "developer.squareup.com",
        "payment.updated",
      );
    });

    test("contains test vs live credentials guidance", async () => {
      await assertAdminHtml("/admin/guide", "test or live credentials");
    });

    test("contains SumUp setup with the API keys link and 401 guidance", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "How do I set up SumUp?",
        "me.sumup.com/en-gb/settings/api-keys",
        "same SumUp account",
        "401 Unauthorized",
      );
    });

    test("warns the SumUp public API key is not the one to use", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Public API key",
        "that is not the one you need",
        "Create API key",
      );
    });

    test("contains public site section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Public Site",
        "homepage and contact page",
      );
    });

    test("contains login security section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Login &amp; Security",
        "5 failed login attempts",
        "15 minutes",
        "no password recovery",
        "HttpOnly",
      );
    });

    test("explains the privacy-first CRM stance", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Why is this privacy-first instead of a CRM?",
        "stops short of being a CRM",
        "GDPR and UK GDPR obligations",
        "legal obligations",
        "listing webhooks are a good place to start",
      );
    });

    test("contains calendar and activity log sections", async () => {
      await assertAdminHtml("/admin/guide", "Calendar", "Activity Log");
    });

    test("contains login lockout documentation", async () => {
      const { MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MS } = await import(
        "#shared/limits.ts"
      );
      await assertAdminHtml(
        "/admin/guide",
        'id="login"',
        "too many failed login attempts",
        `${MAX_LOGIN_ATTEMPTS} failed attempts`,
        `${LOGIN_LOCKOUT_MS / 60_000} minutes`,
        "no password recovery",
      );
    });

    test("contains settings overview section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Settings Overview",
        "Country",
        "Site theme",
      );
    });

    test("contains listing image, duplicate, and deactivate info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "image to a listing",
        "Duplicate",
        "Deactivate",
      );
    });

    test("contains allow pay more info with max price", async () => {
      await assertAdminHtml("/admin/guide", "Allow Pay More", "maximum", "£1");
    });

    test("contains purchase only info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "No Check-In",
        "raffles, fundraisers, donations, merchandise",
        "Buy now",
        "QR codes",
        "excluded from the ICS and RSS feeds",
      );
    });

    test("contains merge attendees info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "merge duplicate attendees",
        "ticket token",
        "source attendee is deleted",
      );
    });

    test("contains resend notification info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "resend a confirmation email",
        "Re-send Notification",
      );
    });

    test("contains non-transferable tickets info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "non-transferable",
        "ID required at entry",
        "ticket touting",
      );
    });

    test("contains attendee editing info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "edit an attendee",
        "Listing Registrations",
        "Add to Listing",
      );
    });

    test("contains text formatting section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Text Formatting",
        'id="text-formatting"',
        "Markdown",
        "markdownguide.org/cheat-sheet",
      );
    });

    test("contains hidden listings info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "hide a listing",
        "Hidden Listing",
        "noindex, nofollow",
      );
    });

    test("contains testing your system section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Testing Your System",
        "test the full booking process",
        "early in development",
        "hello@chobble.com",
      );
    });

    test("contains admin navigation", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "/admin/guide",
        "Listings",
        "Log out",
      );
    });

    test("shows default email setup instructions when no host email configured", async () => {
      const html = await assertAdminHtml(
        "/admin/guide",
        "Choose your email provider from the dropdown",
      );
      expect(html).not.toContain(
        "already configured by your server administrator",
      );
    });

    test("shows host email config and setup instructions when configured", async () => {
      setHostEmailConfigForTest({
        apiKey: "re_test_key",
        fromAddress: validEmail("tickets@example.com"),
        provider: "resend",
      });
      try {
        await assertAdminHtml(
          "/admin/guide",
          "already configured by your server administrator",
          "Resend",
          "tickets@example.com",
          "Choose your email provider from the dropdown",
        );
      } finally {
        resetHostEmailConfig();
      }
    });

    test("contains Google Wallet section", async () => {
      const { response } = await adminGet("/admin/guide");
      const html = await response.text();
      expect(html).toContain("Google Wallet");
      expect(html).toContain("Add to Google Wallet");
      expect(html).toContain("Issuer ID");
      expect(html).toContain("Service Account Email");
      expect(html).toContain("Service Account Private Key");
    });

    test("shows default Google Wallet setup when no host config", async () => {
      const { response } = await adminGet("/admin/guide");
      const html = await response.text();
      expect(html).toContain("You need three values from");
      expect(html).not.toContain(
        "already configured by your server administrator\nusing issuer ID",
      );
    });

    test("shows host Google Wallet config when env vars set", async () => {
      settings.googleWallet.setHostConfigForTest({
        issuerId: "3388000000012345678",
        serviceAccountEmail: "wallet@project.iam.gserviceaccount.com",
        serviceAccountKey: "pem-key-data",
      });
      try {
        const { response } = await adminGet("/admin/guide");
        const html = await response.text();
        expect(html).toContain(
          "already configured by your server administrator",
        );
        expect(html).toContain("3388000000012345678");
        expect(html).toContain("You need three values from");
      } finally {
        settings.googleWallet.resetHostConfig();
      }
    });

    test("hides built sites section when builder is disabled", async () => {
      const { response } = await adminGet("/admin/guide");
      const html = await response.text();
      expect(html).not.toContain('id="built-sites"');
    });

    test("shows built sites section when builder is enabled", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        await assertAdminHtml(
          "/admin/guide",
          'id="built-sites"',
          "Add Built Site",
        );
      } finally {
        restore();
      }
    });

    test("shows default wallet setup instructions when no host wallet configured", async () => {
      const html = await assertAdminHtml(
        "/admin/guide",
        "You need five values from",
      );
      expect(html).not.toContain(
        "already configured by your server administrator using pass type",
      );
    });

    test("shows host wallet config and setup instructions when configured", async () => {
      settings.appleWallet.setHostConfigForTest({
        passTypeId: "pass.com.host.tickets",
        signingCert: "cert-data",
        signingKey: "key-data",
        teamId: "HOSTTEAM01",
        wwdrCert: "wwdr-data",
      });
      try {
        await assertAdminHtml(
          "/admin/guide",
          "already configured by your server administrator using pass type",
          "pass.com.host.tickets",
          "You need five values from",
        );
      } finally {
        settings.appleWallet.resetHostConfig();
      }
    });

    test("documents the debug page including tunable limits", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "/admin/debug",
        "tunable system limit",
        "environment variable",
        "Database pruning",
      );
    });

    test("contains admin API section with auth and endpoint info", async () => {
      await assertAdminHtml(
        "/admin/guide",
        'id="admin-api"',
        "Admin API",
        "Authorization: Bearer YOUR_API_KEY",
        "owners only",
        "shown only once",
        "/api/admin/listings",
        "/api/admin/groups",
        "/api/admin/holidays",
        "confirm_identifier",
        "Last used",
      );
    });

    test("contains host subdomain section", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Host Subdomain",
        "permanent and cannot be changed",
        "host subdomain and custom domain",
      );
    });

    test("explains the canonical-domain priority order for generated links", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Which domain is used for ticket links and emails?",
        "CNAME has been validated",
        "host subdomain",
      );
    });

    test("contains host subdomain in advanced settings list", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Host subdomain",
        "register a pretty",
      );
    });

    test("shows subdomain suffix when Bunny DNS is configured", async () => {
      const restore = setTestEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets.example.com",
        BUNNY_DNS_ZONE_ID: "test-zone",
      });
      try {
        await assertAdminHtml("/admin/guide", ".tickets.example.com");
      } finally {
        restore();
      }
    });

    test("documents the release tag format shared with the update checker", async () => {
      await assertAdminHtml(
        "/admin/guide",
        "Software Updates",
        "vYYYY-MM-DD-HHMMSS",
        "UTC date and time",
      );
    });

    test("contains read-only mode explanation aimed at end users", async () => {
      await assertAdminHtml(
        "/admin/guide",
        'id="read-only-mode"',
        "Read-only Mode",
        "switched on by the host",
        "behind on billing",
        "undergoing maintenance",
      );
    });
  });

  describe("guide section structure", () => {
    const guideHtml = async (): Promise<string> => {
      const { response } = await adminGet("/admin/guide");
      return response.text();
    };

    // Modifiers renders as its own <h3> section immediately before Booking
    // Questions, so the slice between those two headings is exactly the
    // Modifiers section's body — every <summary> in it is a Modifiers FAQ.
    test("Modifiers section contains exactly its own two FAQs", async () => {
      const html = await guideHtml();
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
      ]);
    });

    // The original bug nested the Modifiers <Section> in the middle of the
    // Listings FAQ list, so its <h3> rendered before later listing FAQs and
    // pulled them under its heading. Pinning the Modifiers heading after the
    // last listing FAQ and before the next section catches any such regression.
    test("Modifiers heading sits after the listing FAQs, not in the middle", async () => {
      const html = await guideHtml();
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
