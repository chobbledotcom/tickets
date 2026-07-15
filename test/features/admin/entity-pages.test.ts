import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type ActionDef,
  defineEntityPage,
  type EntityPageDef,
} from "#routes/admin/entity-pages.ts";
import type { AuthSession } from "#routes/auth.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";

beforeAll(() => {
  setupTestEncryptionKey();
});

type Fixture = { id: number; name: string; paid: boolean };

const SESSION: AuthSession = {
  adminLevel: "owner",
  token: "t",
  userId: 1,
  wrappedDataKey: null,
};

/** A guard that always admits the fixture session (renderTab plumbing). */
const passGuard = (
  _request: Request,
  handler: ResponseHandler<[session: AuthSession]>,
): Promise<Response> => Promise.resolve(handler(SESSION));

const ACTIONS: readonly ActionDef<Fixture>[] = [
  {
    href: (entity, ctx) =>
      `/admin/widgets/${entity.id}/refund?return_url=${encodeURIComponent(ctx.returnUrl)}`,
    labelKey: "attendee_form.action_refund",
    visible: (entity) => entity.paid,
  },
  {
    danger: true,
    href: (entity) => `/admin/widgets/${entity.id}/delete`,
    intent: "write-form",
    labelKey: "attendee_form.action_delete",
  },
];

/** A minimal def with no banner, exercising every non-DB section kind. */
const def: EntityPageDef<Fixture> = {
  basePath: (id) => `/admin/widgets/${id}`,
  guard: passGuard,
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
              Raw({ html: `<p>${entity.name} @ ${ctx.returnUrl}</p>` }),
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
  test("path mints the base and tab URLs", () => {
    expect(page.path(7)).toBe("/admin/widgets/7");
    expect(page.path(7, "actions")).toBe("/admin/widgets/7/actions");
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
    expect(html).toContain('href="/admin/widgets/7/activity"');
    // The hidden tab is absent from the strip; the actions tab's content is
    // not rendered on this tab (per-tab loading).
    expect(html).not.toContain("/admin/widgets/7/hidden");
    expect(html).not.toContain("/admin/widgets/7/refund");
  });

  test("the full activity tab renders without a view-all link", async () => {
    const html = await (await page.renderPage(SESSION, 7, "activity")).text();
    expect(html).toContain("No activity recorded yet");
    expect(html).not.toContain("View all activity");
  });

  test("actions filter on their visible predicate and custom sections get ctx", async () => {
    const html = await (await page.renderPage(SESSION, 7, "actions")).text();
    // paid=false hides the refund action but keeps the danger delete.
    expect(html).not.toContain("/admin/widgets/7/refund");
    expect(html).toContain('href="/admin/widgets/7/delete"');
    expect(html).toContain("entity-danger-zone");
    // The custom section received the tab's canonical URL as returnUrl.
    expect(html).toContain("<p>Widget @ /admin/widgets/7/actions</p>");
  });

  test("read-only mode hides write-form tabs and actions", async () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const actions = await page.renderPage(SESSION, 7, "actions");
    expect(await actions.text()).not.toContain("/admin/widgets/7/delete");
    expect((await page.renderPage(SESSION, 7, "edit")).status).toBe(404);
  });

  test("a sections override replaces the tab's content at the given status", async () => {
    const response = await page.renderPage(SESSION, 7, "actions", {
      sections: () =>
        Promise.resolve([
          { html: Raw({ html: "<p>override</p>" }), kind: "custom" as const },
        ]),
      status: 400,
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("<p>override</p>");
    expect(html).not.toContain("/admin/widgets/7/delete");
    // The shell (title + strip) still renders around the override.
    expect(html).toContain("<h1>Widget: Widget</h1>");
  });

  test("renderTab authenticates, then renders the requested tab with the request's query", async () => {
    const response = await page.renderTab(
      new Request("http://localhost/admin/widgets/7"),
      7,
      "",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Widget: Widget</h1>");
  });

  test("tab labels render translated, never as raw locale keys", async () => {
    const html = await (await page.renderPage(SESSION, 7, "")).text();
    expect(html).toContain(">Overview</a>");
    expect(html).toContain(">Activity</a>");
    expect(html).toContain(">Actions</a>");
    expect(html).not.toContain("entity.tab.");
  });
});
