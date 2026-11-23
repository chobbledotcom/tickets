import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { App, Page } from "#test/blackbox/driver.ts";
import { addListing, openApi } from "#test/blackbox/seed.ts";
import {
  boxText,
  followed,
  loggedIn,
  pageAfter,
  redirectOf,
  type SettingsForm,
  send,
  testFormGuards,
} from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const EMBED_HOSTS: SettingsForm = {
  action: "/admin/settings/embed-hosts",
  field: "embedHosts",
  page: "/admin/settings",
};

const UPDATED = t("success.embed_hosts_updated");
const REMOVED = t("success.embed_hosts_removed");

const hostsNow = async (app: App): Promise<string> =>
  boxText((await app.get(EMBED_HOSTS.page)).html, EMBED_HOSTS.field);

/** The owner saves `hosts` and reads the message on the next page. */
const save = (app: App, hosts: string | null): Promise<string> =>
  pageAfter(app, EMBED_HOSTS, { embedHosts: hosts });

/** The booking page of a new listing, as a visitor with no cookies gets it. */
const bookingPage = async (app: App): Promise<Page> => {
  const listing = await addListing(await openApi(app), {
    max_attendees: 50,
    name: "Embedded",
    thank_you_url: "https://example.com",
  });
  return await app.get(`/ticket/${listing.slug}`);
};

const policyOf = (page: Page): string => {
  const policy = page.headers.get("content-security-policy");
  if (policy === null) throw new Error("The page sends no policy.");
  return policy;
};

describeWithEnv("the setting /admin/settings/embed-hosts", { db: true }, () => {
  test("the page shows the setting with an empty box", async () => {
    const page = await (await loggedIn()).get(EMBED_HOSTS.page);
    expect(page.status).toBe(200);
    expect(page.html).toContain(
      "External sites allowed to use embeds and order buttons",
    );
    expect(boxText(page.html, EMBED_HOSTS.field)).toBe("");
  });

  test("a save says so beside its form, and stays in the box in lower case", async () => {
    const app = await loggedIn();
    const sent = await send(app, EMBED_HOSTS, {
      embedHosts: "Example.COM, *.MySite.ORG",
    });
    expect(redirectOf(sent).replace(/flash=[^&]*&/, "")).toBe(
      "/admin/settings?form=settings-embed-hosts#settings-embed-hosts",
    );
    expect((await followed(app, sent)).html).toContain(UPDATED);
    expect(await hostsNow(app)).toBe("example.com, *.mysite.org");
  });

  for (const cleared of ["", "   ", null]) {
    test(`a box with ${JSON.stringify(cleared)} clears the saved hosts`, async () => {
      const app = await loggedIn();
      await save(app, "example.com");
      expect(await save(app, cleared)).toContain(REMOVED);
      expect(await hostsNow(app)).toBe("");
    });
  }

  /** The hosts that the form refuses, with the reason that the page gives. */
  const REFUSED: [hosts: string, reason: string][] = [
    ["example.com, *", "Bare wildcard"],
    ["*", "Bare wildcard"],
    ["https://example.com", "Invalid host pattern"],
  ];

  for (const [hosts, reason] of REFUSED) {
    test(`refuses "${hosts}" beside its form and keeps the saved hosts`, async () => {
      const app = await loggedIn();
      await save(app, "example.com");
      const sent = await send(app, EMBED_HOSTS, { embedHosts: hosts });
      expect(redirectOf(sent).replace(/flash=[^&]*&/, "")).toBe(
        "/admin/settings?form=settings-embed-hosts#settings-embed-hosts",
      );
      expect((await followed(app, sent)).html).toContain(reason);
      expect(await hostsNow(app)).toBe("example.com");
    });
  }

  testFormGuards(EMBED_HOSTS, "example.com", hostsNow, "");

  describe("the pages that another site can frame", () => {
    test("with no hosts saved, the booking page names no framing sites", async () => {
      const page = await bookingPage(await loggedIn());
      expect(page.status).toBe(200);
      expect(policyOf(page)).not.toContain("frame-ancestors");
    });

    test("with hosts saved, the booking page lets those sites frame it", async () => {
      const app = await loggedIn();
      await save(app, "example.com, *.mysite.org");
      const page = await bookingPage(app);
      expect(policyOf(page)).toContain(
        "frame-ancestors 'self' example.com *.mysite.org",
      );
      expect(page.headers.get("x-frame-options")).toBeNull();
    });

    test("with hosts saved, a page that is not a booking page still refuses every frame", async () => {
      const app = await loggedIn();
      await save(app, "example.com");
      const policy = policyOf(await app.get("/"));
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toContain("example.com");
    });
  });
});
