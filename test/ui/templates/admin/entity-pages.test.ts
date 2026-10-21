import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { Raw } from "#jsx/jsx-runtime.ts";
import { setFlashContext, setFlashFormId } from "#shared/flash-context.ts";
import {
  entityPageView,
  renderSection,
  type SummaryRow,
} from "#templates/admin/entity-pages.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("summary section", () => {
  const rows: SummaryRow[] = [
    { labelKey: "common.name", value: "Jane" },
    {
      href: "mailto:jane@example.com",
      labelKey: "common.email",
      value: "jane@example.com",
    },
    {
      external: true,
      href: "https://dashboard.stripe.com/payments/pi_1",
      labelKey: "admin.attendees.payment_id",
      value: "pi_1",
    },
  ];

  test("renders one key/value row per entry with translated labels", () => {
    const html = String(renderSection({ kind: "summary", rows }));
    assertStringIncludes(html, '<th scope="row">Name</th>');
    assertStringIncludes(html, "Jane");
  });

  test("a row with an href renders its value as a link", () => {
    const html = String(renderSection({ kind: "summary", rows }));
    assertStringIncludes(html, '<a href="mailto:jane@example.com">');
  });

  test("an external row opens in a new tab with rel=noopener", () => {
    const html = String(renderSection({ kind: "summary", rows }));
    assertStringIncludes(
      html,
      '<a href="https://dashboard.stripe.com/payments/pi_1" rel="noopener" target="_blank">',
    );
  });

  test("a plain row renders no link at all", () => {
    const html = String(
      renderSection({
        kind: "summary",
        rows: [{ labelKey: "common.name", value: "Jane" }],
      }),
    );
    assert(!html.includes("<a "));
  });
});

describe("activity section", () => {
  test("renders a 'view all' link when viewAllHref is set", () => {
    const html = String(
      renderSection({
        entries: [],
        kind: "activity",
        viewAllHref: "/admin/listing/7/log",
      }),
    );
    assertStringIncludes(html, '<a href="/admin/listing/7/log">');
  });

  test("omits the 'view all' link when viewAllHref is null", () => {
    const html = String(
      renderSection({ entries: [], kind: "activity", viewAllHref: null }),
    );
    assert(!html.includes("<a "));
  });
});

describe("actions section", () => {
  const plain = [
    {
      danger: false,
      descriptionKey: undefined,
      href: "/admin/x/refund",
      icon: "credit-card" as const,
      labelKey: "attendee_form.action_refund",
    },
  ];
  const danger = [
    {
      danger: true,
      descriptionKey: undefined,
      href: "/admin/x/delete",
      icon: "trash-2" as const,
      labelKey: "attendee_form.action_delete",
    },
  ];

  test("renders plain actions as buttons and danger actions inside the danger zone", () => {
    const html = String(
      renderSection({
        danger,
        kind: "actions",
        plain,
        titleKey: "entity.tab.actions",
      }),
    );
    assertStringIncludes(html, "<h3>Actions</h3>");
    assertStringIncludes(html, 'href="/admin/x/refund"');
    const zoneStart = html.indexOf('class="entity-danger-zone"');
    expect(zoneStart).toBeGreaterThan(-1);
    assertStringIncludes(html, "Danger zone");
    // The delete button renders inside the zone, the refund one before it.
    expect(html.indexOf('href="/admin/x/delete"')).toBeGreaterThan(zoneStart);
    expect(html.indexOf('href="/admin/x/refund"')).toBeLessThan(zoneStart);
  });

  test("renders an action's description under its button", () => {
    const html = String(
      renderSection({
        danger: [],
        kind: "actions",
        plain: [
          {
            danger: false,
            descriptionKey: "attendee_form.outstanding_balance_hint",
            href: "/admin/x/merge",
            icon: undefined,
            labelKey: "attendee_form.action_resend",
          },
        ],
        titleKey: "entity.tab.actions",
      }),
    );
    assertStringIncludes(
      html,
      '<span class="muted small">What the attendee still owes',
    );
    // Each action sits in its own entity-action row.
    assertStringIncludes(html, '<div class="entity-action">');
  });

  test("omits the danger zone when no action is dangerous", () => {
    const html = String(
      renderSection({
        danger: [],
        kind: "actions",
        plain,
        titleKey: "entity.tab.actions",
      }),
    );
    assert(!html.includes("entity-danger-zone"));
  });

  test("renders nothing at all when both halves are empty", () => {
    expect(
      renderSection({
        danger: [],
        kind: "actions",
        plain: [],
        titleKey: "entity.tab.actions",
      }),
    ).toBeNull();
  });
});

describe("custom section", () => {
  test("renders the provided markup verbatim", () => {
    const html = String(
      renderSection({
        html: Raw({ html: "<article>bespoke</article>" }),
        kind: "custom",
      }),
    );
    expect(html).toBe("<article>bespoke</article>");
  });
});

describe("entityPageView", () => {
  beforeAll(setupAdminPageTest);

  const view = {
    banner: Raw({ html: '<output class="warning">note</output>' }),
    navActive: "/admin/attendees",
    sections: [
      {
        kind: "summary" as const,
        rows: [{ labelKey: "common.name", value: "Jane" }],
      },
    ],
    session: OWNER_SESSION,
    tabs: [
      {
        active: true,
        href: "/admin/attendees/5",
        labelKey: "entity.tab.overview",
      },
      {
        active: false,
        href: "/admin/attendees/5/edit",
        labelKey: "entity.tab.edit",
      },
    ],
    title: "Attendee: Jane",
  };

  test("renders title, banner, tab strip, and the sections in order", () => {
    const html = entityPageView(view);
    assertStringIncludes(html, "<h1>Attendee: Jane</h1>");
    assertStringIncludes(html, '<output class="warning">note</output>');
    assertStringIncludes(html, 'class="entity-tabs"');
    assertStringIncludes(html, "Jane");
    // Banner renders ABOVE the tab strip: alerts must not hide behind a tab.
    expect(html.indexOf("note")).toBeLessThan(html.indexOf("entity-tabs"));
  });

  test("renders proseExtra inside the prose block, right after the h1", () => {
    const html = entityPageView({
      ...view,
      proseExtra: Raw({ html: '<p><a href="/add-note">Add a note</a></p>' }),
    });
    // The extra content sits inside the same prose <div> as the heading.
    const proseStart = html.indexOf('<div class="prose entity-header">');
    const proseEnd = html.indexOf("</div>", proseStart);
    const prose = html.slice(proseStart, proseEnd);
    assertStringIncludes(prose, "<h1>Attendee: Jane</h1>");
    assertStringIncludes(prose, '<a href="/add-note">Add a note</a>');
  });

  test("pins the header block across view transitions via .entity-header", () => {
    const html = entityPageView(view);
    // The header carries the view-transition-name hook so the entity title
    // holds still while only the panel beneath the tabs transitions.
    assertStringIncludes(html, '<div class="prose entity-header">');
  });

  test("renders flanking nav beside the h1, never inside it", () => {
    // The pager links' aria-labels must not reach the heading: a
    // screen-reader walking by headings hears the record's name alone.
    const html = entityPageView({
      ...view,
      titleNav: {
        after: Raw({ html: '<a href="/next" aria-label="Next">→</a>' }),
        before: Raw({ html: '<a href="/prev" aria-label="Previous">←</a>' }),
      },
    });
    const row = html.slice(
      html.indexOf('<div class="title-nav">'),
      html.indexOf("</div>", html.indexOf('<div class="title-nav">')),
    );
    assertStringIncludes(row, '<a href="/prev" aria-label="Previous">←</a>');
    assertStringIncludes(row, "<h1>Attendee: Jane</h1>");
    assertStringIncludes(row, '<a href="/next" aria-label="Next">→</a>');
  });

  test("marks only the active tab with aria-current=page", () => {
    const html = entityPageView(view);
    assertStringIncludes(
      html,
      '<a aria-current="page" class="active" href="/admin/attendees/5">Overview</a>',
    );
    assertStringIncludes(html, '<a href="/admin/attendees/5/edit">Edit</a>');
  });

  test("uses link semantics, never ARIA tablist", () => {
    const html = entityPageView(view);
    assert(!html.includes("tablist"));
    assert(!html.includes('role="tab"'));
  });

  test("groups the page and each tab section with the shared spacing components", () => {
    const html = entityPageView({
      ...view,
      sections: [
        ...view.sections,
        { html: Raw({ html: "<p>Second section</p>" }), kind: "custom" },
      ],
    });
    assertStringIncludes(html, '<div class="page-regions entity-page">');
    assertStringIncludes(html, '<div class="page-regions entity-tab-panel">');
    assertStringIncludes(html, '<div class="page-block">');
    expect((html.match(/class="page-block"/g) ?? []).length).toBe(2);
    assertStringIncludes(html, "Second section");
    assert(!html.includes('class="table-controls"'));
  });

  test("a section that renders nothing is dropped, not left as an empty group", () => {
    const html = entityPageView({
      ...view,
      sections: [
        // An actions section with no actions renders null…
        { danger: [], kind: "actions" as const, plain: [], titleKey: "x" },
        // …and a real summary follows it.
        {
          kind: "summary" as const,
          rows: [{ labelKey: "common.name", value: "Jane" }],
        },
      ],
    });
    // Only the summary yields a block — the null section leaves no empty one.
    expect((html.match(/class="page-block"/g) ?? []).length).toBe(1);
  });

  test("a form-scoped flash waits outside the page, not inside its regions", async () => {
    const scoped = await withRequestContext(() => {
      // A redirect targeted a form, so the flash belongs to that form — the
      // page must leave it for the layout's backstop above the page regions.
      setFlashContext({ success: "Saved." });
      setFlashFormId("entity-edit");
      return entityPageView(view);
    });
    assertStringIncludes(scoped, "Saved.");
    // The backstop renders before the admin nav; a page-level render would
    // sit inside the page regions, below it.
    expect(scoped.indexOf('role="alert">Saved.')).toBeLessThan(
      scoped.indexOf('class="admin-nav-group"'),
    );
  });
});
