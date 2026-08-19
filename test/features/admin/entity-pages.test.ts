import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type ActionDef,
  defineEntityPage,
  deleteActionTab,
  type EntityPageDef,
  type PageCtx,
  prepareOwnerFields,
} from "#routes/admin/entity-pages.ts";
import { defineEditEntityPage } from "#routes/admin/entity-write-tab.ts";
import type { AuthSession } from "#routes/auth.ts";
import { FormParams } from "#shared/form-data.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import {
  createTestManagerSession,
  withTestSession,
} from "#test-utils/session.ts";

type Fixture = { id: number; name: string; paid: boolean };

const SESSION: AuthSession = {
  adminLevel: "owner",
  token: "t",
  userId: 1,
  wrappedDataKey: null,
};

/** The parts of a page context the owner-fields loader reads. */
const ctxFor = (adminLevel: AuthSession["adminLevel"]): PageCtx =>
  ({ session: { ...SESSION, adminLevel } }) as PageCtx;

describe("prepareOwnerFields", () => {
  const withPaid = prepareOwnerFields<Fixture>((entity) =>
    Promise.resolve({ paid: !entity.paid }),
  );
  const UNPAID: Fixture = { id: 1, name: "Fixture", paid: false };

  test("loads the extra fields for an owner", async () => {
    expect(await withPaid(UNPAID, ctxFor("owner"))).toEqual({
      id: 1,
      name: "Fixture",
      paid: true,
    });
  });

  test("leaves the record alone for every other role", async () => {
    expect(await withPaid(UNPAID, ctxFor("manager"))).toEqual(UNPAID);
  });
});

const ACTIONS: readonly ActionDef<Fixture>[] = [
  {
    href: (entity, ctx) =>
      `/admin/holidays/${entity.id}/refund?return_url=${encodeURIComponent(ctx.returnUrl)}`,
    labelKey: "attendee_form.action_refund",
    visible: (entity) => entity.paid,
  },
  {
    danger: true,
    href: (entity) => `/admin/holidays/${entity.id}/delete`,
    intent: "write-form",
    labelKey: "attendee_form.action_delete",
  },
];

/** A minimal def with no banner, exercising every non-DB section kind. It
 * names a real owner-only record page, because a page takes both its URLs and
 * its auth floor from the route it declares. */
const def: EntityPageDef<Fixture> = {
  destination: "holiday",
  load: (id) =>
    Promise.resolve(id === 404 ? null : { id, name: "Widget", paid: false }),
  navActive: "/admin/attendees",
  tabs: [
    {
      labelKey: "entity.tab.overview",
      sections: [
        {
          kind: "summary",
          rows: (entity) =>
            Promise.resolve([{ labelKey: "common.name", value: entity.name }]),
        },
        {
          kind: "activity",
          load: () =>
            Promise.resolve([
              {
                attendee_id: null,
                created: "2026-01-01T00:00:00Z",
                id: 1,
                listing_id: null,
                message: "made",
              },
            ]),
          viewAllTab: "activity",
        },
      ],
      slug: "",
    },
    {
      labelKey: "entity.tab.activity",
      sections: [{ kind: "activity", load: () => Promise.resolve([]) }],
      slug: "activity",
    },
    {
      labelKey: "entity.tab.actions",
      sections: [
        { actions: ACTIONS, kind: "actions", titleKey: "entity.tab.actions" },
        {
          kind: "custom",
          load: (entity, ctx) =>
            Promise.resolve(
              Raw({
                html: `<p data-from="${ctx.query.get("from") ?? ""}">${entity.name} @ ${ctx.returnUrl} from ${ctx.baseUrl}</p>`,
              }),
            ),
        },
      ],
      slug: "actions",
    },
    {
      intent: "write-form",
      labelKey: "entity.tab.edit",
      sections: [],
      slug: "edit",
    },
    {
      labelKey: "entity.tab.ledger",
      sections: [],
      slug: "hidden",
      visible: () => false,
    },
  ],
  titleOf: (entity) => `Widget: ${entity.name}`,
};

const page = defineEntityPage(def);

describe("defineEntityPage", () => {
  beforeAll(() => {
    setupTestEncryptionKey();
  });

  test("path mints the base and tab URLs", () => {
    expect(page.path(7)).toBe("/admin/holidays/7");
    expect(page.path(7, "actions")).toBe("/admin/holidays/7/actions");
  });

  test("renderPage 404s for an unknown id", async () => {
    const response = await page.renderPage(SESSION, 404, "");
    expect(response.status).toBe(404);
  });

  test("renderPage 404s for an unknown tab slug", async () => {
    const response = await page.renderPage(SESSION, 7, "nonsense");
    expect(response.status).toBe(404);
  });

  test("renderPage 404s for a hidden tab named directly", async () => {
    const response = await page.renderPage(SESSION, 7, "hidden");
    expect(response.status).toBe(404);
  });

  test("the default tab renders title, strip, and only its own sections", async () => {
    const response = await page.renderPage(SESSION, 7, "");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Widget: Widget</h1>");
    // Summary row + activity preview with a view-all link into the full tab.
    expect(html).toContain('<th scope="row">Name</th>');
    expect(html).toContain("made");
    expect(html).toContain('href="/admin/holidays/7/activity"');
    // The hidden tab is absent from the strip; the actions tab's content is
    // not rendered on this tab (per-tab loading).
    expect(html).not.toContain("/admin/holidays/7/hidden");
    expect(html).not.toContain("/admin/holidays/7/refund");
  });

  test("the full activity tab renders without a view-all link", async () => {
    const html = await (await page.renderPage(SESSION, 7, "activity")).text();
    expect(html).toContain("No activity recorded yet");
    expect(html).not.toContain("View all activity");
  });

  test("active sections load concurrently without changing their declared order", async () => {
    const first = Promise.withResolvers<ReturnType<typeof Raw>>();
    const second = Promise.withResolvers<ReturnType<typeof Raw>>();
    const firstStarted = Promise.withResolvers<void>();
    const started: string[] = [];
    const concurrentPage = defineEntityPage({
      ...def,
      tabs: [
        {
          labelKey: "entity.tab.overview",
          sections: [
            {
              kind: "custom",
              load: () => {
                started.push("first");
                firstStarted.resolve();
                return first.promise;
              },
            },
            {
              kind: "custom",
              load: () => {
                started.push("second");
                return second.promise;
              },
            },
          ],
          slug: "",
        },
      ],
    });

    const rendering = concurrentPage.renderPage(SESSION, 7, "");
    await firstStarted.promise;
    const startedBeforeAnyResolve = [...started];
    second.resolve(Raw({ html: "<p>section-beta-marker</p>" }));
    first.resolve(Raw({ html: "<p>section-alpha-marker</p>" }));
    const html = await (await rendering).text();

    expect(startedBeforeAnyResolve).toEqual(["first", "second"]);
    expect(html.indexOf("section-alpha-marker")).toBeLessThan(
      html.indexOf("section-beta-marker"),
    );
  });

  test("actions filter on their visible predicate and custom sections get ctx", async () => {
    const html = await (await page.renderPage(SESSION, 7, "actions")).text();
    // paid=false hides the refund action but keeps the danger delete.
    expect(html).not.toContain("/admin/holidays/7/refund");
    expect(html).toContain('href="/admin/holidays/7/delete"');
    expect(html).toContain("entity-danger-zone");
    // The custom section received the tab's canonical URL as returnUrl.
    expect(html).toContain(
      '<p data-from="">Widget @ /admin/holidays/7/actions from </p>',
    );
  });

  test("read-only mode hides write-form tabs and actions", async () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const actions = await page.renderPage(SESSION, 7, "actions");
    expect(await actions.text()).not.toContain("/admin/holidays/7/delete");
    expect((await page.renderPage(SESSION, 7, "edit")).status).toBe(404);
  });

  test("a panel override replaces the tab's content at the given status", async () => {
    const loaded: string[] = [];
    const panelPage = defineEntityPage({
      ...def,
      tabs: [
        {
          labelKey: "entity.tab.actions",
          sections: [
            {
              kind: "custom",
              load: () => {
                loaded.push("section");
                return Promise.resolve(Raw({ html: "<p>section</p>" }));
              },
            },
          ],
          slug: "actions",
        },
      ],
    });
    const response = await panelPage.renderPage(SESSION, 7, "actions", {
      panel: () => {
        loaded.push("panel");
        return Promise.resolve(Raw({ html: "<p>override</p>" }));
      },
      status: 400,
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("<p>override</p>");
    expect(html).not.toContain("<p>section</p>");
    expect(loaded).toEqual(["panel"]);
    // The shell (title + strip) still renders around the override.
    expect(html).toContain("<h1>Widget: Widget</h1>");
  });

  test("an invalid response status fails instead of becoming a success", async () => {
    await expect(
      page.renderPage(SESSION, 7, "actions", { status: 0 }),
    ).rejects.toThrow();
  });

  test("tab labels render translated, never as raw locale keys", async () => {
    const html = await (await page.renderPage(SESSION, 7, "")).text();
    expect(html).toContain(">Overview</a>");
    expect(html).toContain(">Activity</a>");
    expect(html).toContain(">Actions</a>");
    expect(html).not.toContain("entity.tab.");
  });

  test("deleteActionTab renders one write-only danger action", async () => {
    const deletePage = defineEntityPage({
      ...def,
      tabs: [
        deleteActionTab<Fixture>(
          "common.delete",
          (entity) => `/admin/holidays/${entity.id}/delete`,
        ),
      ],
    });
    const html = await (await deletePage.renderPage(SESSION, 7, "")).text();
    expect(html).toContain('href="/admin/holidays/7/delete"');
    expect(html).toContain("Delete");
    expect(html).toContain("entity-danger-zone");
    expect((await deletePage.renderPage(SESSION, 7, "actions")).status).toBe(
      200,
    );

    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    expect((await deletePage.renderPage(SESSION, 7, "")).status).toBe(404);
  });

  test("an edit page preserves the submitted form at status 400", async () => {
    const editPage = defineEditEntityPage({
      deleteLabelKey: "common.delete",
      destination: def.destination,
      edit: (entity, ctx, rejected) =>
        Promise.resolve(
          Raw({
            html: `<p>${entity.name}|${ctx.returnUrl}|${rejected?.form.get("name")}|${rejected?.error}</p>`,
          }),
        ),
      editSlug: "",
      load: def.load,
      navActive: def.navActive,
    });
    const response = await editPage.renderEditError(
      7,
      SESSION,
      new FormParams({ name: "Submitted" }),
      "Invalid",
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "<p>Widget|/admin/holidays/7|Submitted|Invalid</p>",
    );
  });
});

describeWithEnv("an entity page serving a request", { db: true }, () => {
  test("passes the request origin and query to the active section", async () => {
    // renderTab is the route-facing entry: it runs the page's auth floor, then
    // hands the section the origin and query string off the real request.
    const response = await withTestSession(() =>
      page.renderTab(
        new Request(
          "https://tickets.example/admin/holidays/7/actions?from=queue",
        ),
        7,
        "actions",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      '<p data-from="queue">Widget @ /admin/holidays/7/actions from https://tickets.example</p>',
    );
  });

  test("refuses a role the page does not admit", async () => {
    // The floor comes from the declaration, so a role outside it never gets
    // as far as loading the record.
    const cookie = await createTestManagerSession("entity-page-manager");
    const response = await page.renderTab(
      new Request("https://tickets.example/admin/holidays/7", {
        headers: { cookie },
      }),
      7,
      "",
    );
    expect(response.status).toBe(403);
  });
});
