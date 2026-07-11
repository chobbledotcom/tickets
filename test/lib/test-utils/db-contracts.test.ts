import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getSessionCookieName } from "#shared/cookies.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { getListingWithActivityLog } from "#test-utils/activity-log.ts";
import { attendeeLineIndex } from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { getTestDataKey, getTestPrivateKey } from "#test-utils/crypto.ts";
import {
  createTestDb,
  createTestDbWithSetup,
  resetDb,
} from "#test-utils/db.ts";
import {
  buildAttendeeEditForm,
  createTestAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import {
  createTestBuiltSite,
  updateTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  lineIndexOnPage,
  openAttendeeEditor,
  setupAndLogin,
  ticketTokenOnPage,
} from "#test-utils/e2e.ts";
import {
  setTestSession,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import { wait } from "#test-utils/mocks.ts";
import {
  createTestAgentSession,
  createTestManagerSession,
  loginAsAdmin,
  withTestSession,
} from "#test-utils/session.ts";
import {
  testWithSetting,
  useSetting,
  withSetting,
} from "#test-utils/settings.ts";
import { lastLogMessage } from "#test-utils/settings-handlers.ts";

describe("test-utils — db-backed & settings contracts", () => {
  afterEach(() => {
    resetDb();
  });

  describe("strict DB-backed utility contracts", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("getListingWithActivityLog reads through the test admin session", async () => {
      const listing = await createTestListing({ name: "Logged Listing" });
      const result = await getListingWithActivityLog(listing.id);

      expect(result).not.toBeNull();
      expect(result!.listing.id).toBe(listing.id);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]!.message).toBe(
        "Listing 'Logged Listing' created",
      );
    });

    test("createReservedAttendee applies listing names and fails closed on setup failure", async () => {
      const { listingId } = await createReservedAttendee(1500, {
        listingName: "Reserved Helper Listing",
      });
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const listing = await getListingWithCount(listingId);

      expect(listing!.name).toBe("Reserved Helper Listing");
      await expect(
        createReservedAttendee(1500, { quantity: 11 }),
      ).rejects.toThrow("setup failed");
    });

    test("test crypto helpers expose real data keys and fail on missing setup material", async () => {
      const dataKey = await getTestDataKey();
      const privateKey = await getTestPrivateKey();

      expect(dataKey.type).toBe("secret");
      expect(privateKey.type).toBe("private");

      resetDb();
      await createTestDb();
      await expect(getTestPrivateKey()).rejects.toThrow(
        "Test setup failed: no wrapped data key",
      );

      resetDb();
      await createTestDbWithSetup();
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute("DELETE FROM settings WHERE key = ?", [
        CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
      ]);
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.WRAPPED_PRIVATE_KEY]);

      await expect(getTestPrivateKey()).rejects.toThrow(
        "Test setup failed: no wrapped private key",
      );
    });

    test("login and session helpers report missing cookies and sessions", async () => {
      await expect(
        loginAsAdmin(TEST_ADMIN_USERNAME, `${TEST_ADMIN_PASSWORD}-wrong`),
      ).rejects.toThrow("No session cookie in login response");

      setTestSession({
        cookie: `${getSessionCookieName()}=missing-session-token`,
        csrfToken: "csrf",
      });
      await expect(withTestSession(async () => undefined)).rejects.toThrow(
        "Test admin session row not found",
      );
    });

    test("manager and agent helpers require the setup admin key", async () => {
      resetDb();
      await createTestDb();

      await expect(createTestManagerSession()).rejects.toThrow(
        "Admin user has no wrapped data key",
      );
      await expect(createTestAgentSession()).rejects.toThrow(
        "Admin user not set up",
      );
    });

    test("createTestAttendee surfaces flashed validation errors", async () => {
      await settings.update.terms("Read these terms first.");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.TERMS_AND_CONDITIONS]);
      const listing = await createTestListing();

      await expect(
        createTestAttendee(listing.id, listing.slug, "Invalid", "not-email"),
      ).rejects.toThrow(
        "Failed to create attendee: You must agree to the terms and conditions",
      );
    });

    test("lastLogMessage returns an empty string when no activity exists", async () => {
      expect(await lastLogMessage()).toBe("");
    });

    test("buildAttendeeEditForm preserves existing booking lines by default", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Default Form",
        "default-form@example.com",
        2,
      );

      const form = await buildAttendeeEditForm(attendee.id);

      expect(form.name).toBe("");
      // One indexed line per existing booking row.
      expect(form.line_listing_0).toBe(String(listing.id));
      expect(form.qty_0).toBe("2");
      expect(form.line_key_0).not.toBe("");
    });

    test("buildAttendeeEditForm defaults new override lines to one ticket with no key", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Override Form",
        "override-form@example.com",
        2,
      );

      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [{ eventId: listing.id }],
      });

      expect(form.line_listing_0).toBe(String(listing.id));
      expect(form.qty_0).toBe("1");
      expect(form.line_key_0).toBe("");
    });

    test("attendeeLineIndex distinguishes package paths and misses cleanly", () => {
      const html = [
        '<input name="line_listing_0" value="7">',
        '<input name="line_package_0" value="3">',
        '<input name="line_listing_1" value="7">',
      ].join("");
      expect(attendeeLineIndex(html, 7, 3)).toBe("0");
      expect(attendeeLineIndex(html, 7, 0)).toBe("1");
      expect(attendeeLineIndex(html, 7, 9)).toBeNull();
      expect(attendeeLineIndex(html, 8)).toBeNull();
    });

    test("lineIndexOnPage throws when the page has no line for the listing", () => {
      const browser = {
        currentHtml: "<p>no editor here</p>",
      } as unknown as import("#test-utils/test-browser.ts").TestBrowser;
      expect(() => lineIndexOnPage(browser, 42)).toThrow(
        "no editor line for listing 42",
      );
    });

    test("updateTestBuiltSite handles assignable and validation failure paths", async () => {
      const site = await createTestBuiltSite({
        name: "Assignable Site",
      });
      const assignable = await updateTestBuiltSite(site.id, {
        assignable: true,
      });
      const updated = await updateTestBuiltSite(site.id, { assignable: false });

      expect(assignable.assignable).toBe(true);
      expect(updated.assignable).toBe(false);

      const { cookie } = await loginAsAdmin();
      setTestSession({ cookie, csrfToken: "not-a-signed-csrf-token" });
      await expect(
        createTestBuiltSite({ name: "Forbidden Site" }),
      ).rejects.toThrow("Failed to create built site: 403");
    });
  });

  describe("e2e helper contracts", () => {
    test("setupAndLogin follows the migration-complete interstitial", async () => {
      const actions: string[] = [];
      const browser = {
        clickLink: (text: string) => {
          actions.push(`click:${text}`);
          return Promise.resolve();
        },
        containsText: (text: string) => text === "Migration complete",
        submitForm: (_data: Record<string, string>, buttonText: string) => {
          actions.push(`submit:${buttonText}`);
          return Promise.resolve();
        },
        visit: (path: string) => {
          actions.push(`visit:${path}`);
          return Promise.resolve();
        },
      } as unknown as import("#test-utils/test-browser.ts").TestBrowser;

      await setupAndLogin(browser);

      expect(actions).toEqual([
        "visit:/setup/",
        "submit:Complete Setup",
        "click:Log In",
        "submit:Login",
        "click:Back to dashboard",
      ]);
    });

    test("attendee navigation helpers fail clearly when required links are absent", async () => {
      const browser = {
        currentHtml: "<main>No attendees yet</main>",
        links: [],
        visit: (_path: string) => Promise.resolve(),
      } as unknown as import("#test-utils/test-browser.ts").TestBrowser;

      await expect(openAttendeeEditor(browser)).rejects.toThrow(
        "no attendee edit link on the current page",
      );
      expect(() => ticketTokenOnPage(browser)).toThrow(
        "no customer /t ticket link on the current page",
      );
    });
  });

  describe("withSetting", () => {
    afterEach(() => {
      settings.clearTestOverrides();
    });

    test("applies the override while fn is running", async () => {
      let currencyDuringFn: string | undefined;
      await withSetting({ currency: "JPY" }, () => {
        currencyDuringFn = settings.currency;
      });
      expect(currencyDuringFn).toBe("JPY");
    });

    test("clears the override after fn returns", async () => {
      await withSetting({ currency: "JPY" }, () => {});
      expect("currency" in settings).toBe(true);
      expect(settings.currency).not.toBe("JPY");
    });

    test("clears the override even when fn throws", async () => {
      await expect(
        withSetting({ currency: "JPY" }, () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(settings.currency).not.toBe("JPY");
    });

    test("returns the value produced by fn", async () => {
      const result = await withSetting({ currency: "GBP" }, () => 42);
      expect(result).toBe(42);
    });

    test("awaits async callbacks before clearing", async () => {
      let currencyMidFlight: string | undefined;
      await withSetting({ currency: "EUR" }, async () => {
        await wait(1);
        currencyMidFlight = settings.currency;
      });
      expect(currencyMidFlight).toBe("EUR");
      expect(settings.currency).not.toBe("EUR");
    });

    test("applies multiple overrides at once", async () => {
      const seen: Record<string, unknown> = {};
      await withSetting({ currency: "USD", show_public_site: true }, () => {
        seen.currency = settings.currency;
        seen.showPublicSite = settings.showPublicSite;
      });
      expect(seen.currency).toBe("USD");
      expect(seen.showPublicSite).toBe(true);
      expect(settings.currency).not.toBe("USD");
      expect(settings.showPublicSite).not.toBe(true);
    });
  });

  describe("useSetting", () => {
    describe("inside a scoped describe", () => {
      useSetting({ currency: "JPY" });

      test("override is active in tests", () => {
        expect(settings.currency).toBe("JPY");
      });

      test("override persists across tests in the same scope", () => {
        expect(settings.currency).toBe("JPY");
      });
    });

    test("override does not leak outside the scoped describe", () => {
      expect(settings.currency).not.toBe("JPY");
    });
  });

  describe("testWithSetting", () => {
    testWithSetting(
      "override is active inside the declared test",
      { currency: "EUR" },
      () => {
        expect(settings.currency).toBe("EUR");
      },
    );

    testWithSetting(
      "supports async test bodies",
      { currency: "JPY" },
      async () => {
        await wait(1);
        expect(settings.currency).toBe("JPY");
      },
    );

    test("override does not leak to sibling tests", () => {
      expect(settings.currency).not.toBe("EUR");
      expect(settings.currency).not.toBe("JPY");
    });
  });
});
