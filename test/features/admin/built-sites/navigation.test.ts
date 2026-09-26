import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSites } from "#db/built-sites.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { adminGet } from "#test-utils/session.ts";

/** Arrow assertions shared by every test below. The three attributes must
 * sit on one anchor, so the test finds the anchor by its label and reads
 * that same tag's destination and title. */
const expectArrow = (
  html: string,
  label: string,
  href: string,
  title: string,
): void => {
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
  const arrow = anchors.find((anchor) =>
    anchor.includes(`aria-label="${label}"`),
  );
  if (arrow === undefined) {
    throw new Error(`No anchor carries the aria-label "${label}"`);
  }
  expect(arrow).toContain(`href="${href}"`);
  expect(arrow).toContain(`title="${title}"`);
};

describeWithEnv(
  "admin built-site page pager",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    /** Read the true record for a site by name. The create helper returns
     * the name-sorted list's last entry, so a same-test second create
     * aliases to the wrong site — always read back instead. */
    const readSite = async (name: string): Promise<BuiltSite> => {
      const site = (await builtSites.getAll()).find(
        (listed: BuiltSite) => listed.name === name,
      );
      if (site === undefined) throw new Error(`No built site named ${name}`);
      return site;
    };

    test("flanks the title with the previous and next site", async () => {
      await createTestBuiltSite({ name: "Zulu" });
      await createTestBuiltSite({ name: "Middle" });
      await createTestBuiltSite({ name: "Alpha" });
      const middle = await readSite("Middle");
      const alpha = await readSite("Alpha");
      const zulu = await readSite("Zulu");
      const response = await adminGet(`/admin/built-sites/${middle.id}`);
      const html = await expectHtmlResponse(response, 200, "Middle");
      expectArrow(
        html,
        "Previous built site",
        `/admin/built-sites/${alpha.id}/edit`,
        "Alpha",
      );
      expectArrow(
        html,
        "Next built site",
        `/admin/built-sites/${zulu.id}/edit`,
        "Zulu",
      );
    });

    test("keeps the requested tab on the arrows", async () => {
      await createTestBuiltSite({ name: "Zulu" });
      await createTestBuiltSite({ name: "Middle" });
      const middle = await readSite("Middle");
      const zulu = await readSite("Zulu");
      const response = await adminGet(
        `/admin/built-sites/${middle.id}/secrets`,
      );
      const html = await expectHtmlResponse(response, 200);
      expectArrow(
        html,
        "Next built site",
        `/admin/built-sites/${zulu.id}/secrets`,
        "Zulu",
      );
    });

    test("wraps around at both ends of the list", async () => {
      await createTestBuiltSite({ name: "Zulu" });
      await createTestBuiltSite({ name: "Middle" });
      await createTestBuiltSite({ name: "Alpha" });
      const alpha = await readSite("Alpha");
      const zulu = await readSite("Zulu");
      const first = await adminGet(`/admin/built-sites/${alpha.id}`);
      const html = await expectHtmlResponse(first, 200, "Alpha");
      expectArrow(
        html,
        "Previous built site",
        `/admin/built-sites/${zulu.id}/edit`,
        "Zulu",
      );
      const last = await adminGet(`/admin/built-sites/${zulu.id}`);
      const lastHtml = await expectHtmlResponse(last, 200, "Zulu");
      expectArrow(
        lastHtml,
        "Next built site",
        `/admin/built-sites/${alpha.id}/edit`,
        "Alpha",
      );
    });

    test("renders no arrows when only one site exists", async () => {
      const site = await createTestBuiltSite({ name: "Only Site" });
      const response = await adminGet(`/admin/built-sites/${site.id}`);
      const html = await expectHtmlResponse(response, 200, "Only Site");
      expect(html).not.toContain("Previous built site");
      expect(html).not.toContain("Next built site");
    });

    test("lands the pager's support-message cycle on a Deno site", async () => {
      await createTestBuiltSite({ name: "Zulu" });
      await createTestBuiltSite({ name: "Middle" });
      await createTestBuiltSite({
        hostingProvider: "deno",
        name: "Alpha Deno",
      });
      // The tab exists on every provider, so the cycle's arrows stay live.
      const deno = await readSite("Alpha Deno");
      const response = await adminGet(
        `/admin/built-sites/${deno.id}/support-message`,
      );
      const html = await expectHtmlResponse(response, 200, "Support message");
      expectArrow(
        html,
        "Previous built site",
        `/admin/built-sites/${(await readSite("Zulu")).id}/support-message`,
        "Zulu",
      );
      expectArrow(
        html,
        "Next built site",
        `/admin/built-sites/${(await readSite("Middle")).id}/support-message`,
        "Middle",
      );
    });

    test("keeps the pager links outside the heading", async () => {
      await createTestBuiltSite({ name: "Zulu" });
      await createTestBuiltSite({ name: "Middle" });
      // Always read back by name: the create helper returns the list's last
      // entry, so a same-test second create aliases to the wrong site.
      const site = await readSite("Middle");
      const response = await adminGet(`/admin/built-sites/${site.id}`);
      const html = await expectHtmlResponse(response, 200, "Middle");
      // A screen-reader walking the page by headings hears the site's name
      // alone: the arrows are the heading's siblings, not its children.
      const heading = html.slice(
        html.indexOf("<h1>"),
        html.indexOf("</h1>") + 5,
      );
      expect(heading).toBe("<h1>Middle</h1>");
      expect(html).toContain('class="title-nav"');
    });
  },
);
