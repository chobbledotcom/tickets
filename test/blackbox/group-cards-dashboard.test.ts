/**
 * The group cards dashboard: an owner chooses it as the dashboard type, and
 * `/admin/` then shows each group with its listings on sale. The listings
 * table stays one link away, and other roles keep their own landing page.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { addGroup, addListing, openApi } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
} from "#test-utils/session.ts";

const SETTINGS = "/admin/settings";
const DASHBOARD_TYPE = "/admin/settings/dashboard-type";
const SHOW_TABLE = "Show listings table";
const SHOW_CARDS = "Show group cards";

/** The headings of the page's blocks, in order, with their links. */
const blockHeadings = (html: string): string[] =>
  [...html.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((match) =>
    (match[1] ?? "").replace(/\s+/g, " ").trim(),
  );

/** The block that a heading opens: from the heading to the next one. */
const blockAfter = (html: string, heading: string): string => {
  const start = html.indexOf(heading);
  if (start === -1) throw new Error(`The page has no "${heading}" block.`);
  const next = html.indexOf("<h2>", start + heading.length);
  return html.slice(start, next === -1 ? undefined : next);
};

/** Every address the page links to with an outline button. */
const buttonLinks = (html: string): string[] =>
  [...html.matchAll(/<a class="btn outline" href="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );

/* jscpd:ignore-start -- static data, not code */
const GROUP_NAMES = [
  "Friday Club",
  "Saturday Club",
  "Sunday Club",
  "Last Week",
  "Next Month",
];
/* jscpd:ignore-end */

/** The owner saves a dashboard type on the settings page. */
const chooseDashboard = async (app: App, type: string): Promise<void> => {
  const saved = await app.submit(
    SETTINGS,
    { dashboardType: type },
    DASHBOARD_TYPE,
  );
  expect(saved.status).toBe(302);
};

/** An owner whose site sells three events, one past event, one empty group,
 * and one listing in no group. "Early bird" sits in two live groups. Sunday
 * has one listing on sale. */
const openClub = async () => {
  const app = createApp(inProcess);
  await app.logIn();
  const api = await openApi(app);
  const ids: number[] = [];
  for (const name of GROUP_NAMES) ids.push(await addGroup(api, name));
  const [friday = 0, saturday = 0, sunday = 0, past = 0, empty = 0] = ids;
  const add = (name: string, groupIds: number[], active = true) =>
    addListing(api, {
      active,
      group_ids: groupIds,
      max_attendees: 50,
      name,
    });
  await add("Friday entry", [friday]);
  await add("Saturday entry", [saturday]);
  await add("Early bird", [friday, saturday]);
  await add("Friday guest list", [friday], false);
  await add("Sunday entry", [sunday]);
  await add("Sunday guest list", [sunday], false);
  await add("Last week entry", [past], false);
  await add("Gift voucher", []);
  return { app, groups: { empty, friday, past, saturday, sunday } };
};

/** The club with group cards chosen, and the page `path` shows the owner. */
const clubShowing = async (path: string) => {
  const club = await openClub();
  await chooseDashboard(club.app, "groups");
  return { ...club, html: (await club.app.get(path)).html };
};

/** The links a card offers, by the end of each address. */
const cardLinks = (id: number, ends: readonly string[]): string[] =>
  ends.map((end) => `/admin/groups/${id}/${end}`);

const EVERY_CARD_LINK = ["scanner", "attendees", "duplicate"];

describeWithEnv("group cards dashboard", { db: true }, () => {
  test("a site that has not chosen group cards keeps the listings table", async () => {
    const { app } = await openClub();

    const { html, status } = await app.get("/admin/");

    expect(status).toBe(200);
    expect(html).toContain("Friday entry");
    expect(html).not.toContain(SHOW_CARDS);
    expect(html).not.toContain(SHOW_TABLE);
    expect(blockHeadings(html)).not.toContain("Other listings");
  });

  test("shows each live group with its listings on sale, then the rest", async () => {
    const { groups, html } = await clubShowing("/admin/");

    expect(blockHeadings(html)).toEqual([
      `<a href="/admin/groups/${groups.friday}">Friday Club</a>`,
      `<a href="/admin/groups/${groups.saturday}">Saturday Club</a>`,
      `<a href="/admin/groups/${groups.sunday}">Sunday Club</a>`,
      `<a href="/admin/groups/${groups.empty}">Next Month</a>`,
      "Other listings",
    ]);
    const friday = blockAfter(html, "Friday Club</a>");
    expect(friday).toContain("Friday entry");
    expect(friday).toContain("Early bird");
    expect(friday).not.toContain("Friday guest list");
    expect(blockAfter(html, "Saturday Club</a>")).toContain("Early bird");
    expect(blockAfter(html, "Next Month</a>")).toContain(
      "No listings on sale in this group",
    );
    const others = blockAfter(html, "Other listings");
    expect(others).toContain("Gift voucher");
    expect(others).not.toContain("Friday entry");
    expect(html).not.toContain("Last Week");
    expect(html).toContain(`href="/admin/?view=listings">${SHOW_TABLE}`);
  });

  test("gives each card its scanner, attendees, and duplicate links", async () => {
    const { groups, html } = await clubShowing("/admin/");

    expect(buttonLinks(blockAfter(html, "Friday Club</a>"))).toEqual(
      cardLinks(groups.friday, EVERY_CARD_LINK),
    );
  });

  test("every link on the group cards dashboard opens a page", async () => {
    const { app, html } = await clubShowing("/admin/");
    const links = [...html.matchAll(/<main[\s\S]*<\/main>/g)]
      .flatMap((main) => [...main[0].matchAll(/href="(\/admin[^"#]*)"/g)])
      .map((match) => (match[1] ?? "").replaceAll("&amp;", "&"));

    const statuses = await Promise.all(
      [...new Set(links)].map(async (link) => [
        link,
        (await app.get(link)).status,
      ]),
    );

    expect(links.length).toBeGreaterThan(10);
    expect(statuses.filter(([, status]) => status !== 200)).toEqual([]);
  });

  test("the listings table is one link away, and links back", async () => {
    const { html } = await clubShowing("/admin/?view=listings");

    expect(blockHeadings(html)).not.toContain("Other listings");
    expect(html).toContain("Active Listing Statistics");
    expect(html).toContain(`<a href="/admin/">${SHOW_CARDS}</a>`);
    expect(html).not.toContain(SHOW_TABLE);
  });

  test("any other view value shows the group cards", async () => {
    const { html } = await clubShowing("/admin/?view=nonsense");

    expect(blockHeadings(html)).toContain("Other listings");
  });

  test("choosing the listings table again brings it back", async () => {
    const { app } = await openClub();
    await chooseDashboard(app, "groups");

    await chooseDashboard(app, "listings");
    const { html } = await app.get("/admin/");

    expect(blockHeadings(html)).not.toContain("Other listings");
    expect(html).not.toContain(SHOW_CARDS);
  });

  test("a read-only site hides the links that change things", async () => {
    const { app, groups } = await openClub();
    await chooseDashboard(app, "groups");
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });

    const { html } = await app.get("/admin/");

    expect(buttonLinks(blockAfter(html, "Friday Club</a>"))).toEqual(
      cardLinks(groups.friday, ["scanner", "attendees"]),
    );
    expect(html).not.toContain('href="/admin/listing/new"');
  });

  test("a manager sees the group cards with every link", async () => {
    const { app, groups } = await openClub();
    await chooseDashboard(app, "groups");
    const manager = createApp(inProcess, await createTestManagerSession());

    const { html, status } = await manager.get("/admin/");

    expect(status).toBe(200);
    expect(buttonLinks(blockAfter(html, "Friday Club</a>"))).toEqual(
      cardLinks(groups.friday, EVERY_CARD_LINK),
    );
  });
  test("other roles keep the landing page they had", async () => {
    const { app } = await openClub();
    const cookies = [
      (await createTestEditorSession()).cookie,
      (await createTestAgentSession()).cookie,
      (await createTestScannerSession()).cookie,
    ];
    const landings = async () =>
      await Promise.all(
        cookies.map(
          async (cookie) =>
            (await createApp(inProcess, cookie).get("/admin/")).location,
        ),
      );
    const before = await landings();

    await chooseDashboard(app, "groups");

    expect(before).toEqual([
      "/admin/listings",
      "/admin/deliveries",
      "/admin/scanner",
    ]);
    expect(await landings()).toEqual(before);
  });
});
