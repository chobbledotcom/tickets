import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  entityPageView,
  renderSection,
  type SummaryRow,
} from "#templates/admin/entity-pages.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

beforeAll(() => {
  setupTestEncryptionKey();
});

const SESSION = { adminLevel: "owner" as const };

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
    expect(html).toContain('<th scope="row">Name</th>');
    expect(html).toContain("Jane");
  });

  test("a row with an href renders its value as a link", () => {
    const html = String(renderSection({ kind: "summary", rows }));
    expect(html).toContain('<a href="mailto:jane@example.com">');
  });

  test("an external row opens in a new tab with rel=noopener", () => {
    const html = String(renderSection({ kind: "summary", rows }));
    expect(html).toContain(
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
    expect(html).not.toContain("<a ");
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
    expect(html).toContain('<a href="/admin/listing/7/log">');
  });

  test("omits the 'view all' link when viewAllHref is null", () => {
    const html = String(
      renderSection({ entries: [], kind: "activity", viewAllHref: null }),
    );
    expect(html).not.toContain("<a ");
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
    expect(html).toContain("<h3>Actions</h3>");
    expect(html).toContain('href="/admin/x/refund"');
    const zoneStart = html.indexOf('class="entity-danger-zone"');
    expect(zoneStart).toBeGreaterThan(-1);
    expect(html).toContain("Danger zone");
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
    expect(html).toContain(
      '<span class="muted small">What the attendee still owes',
    );
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
    expect(html).not.toContain("entity-danger-zone");
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
  const view = {
    banner: Raw({ html: '<output class="warning">note</output>' }),
    navActive: "/admin/attendees",
    sections: [
      {
        kind: "summary" as const,
        rows: [{ labelKey: "common.name", value: "Jane" }],
      },
    ],
    session: SESSION,
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
    expect(html).toContain("<h1>Attendee: Jane</h1>");
    expect(html).toContain('<output class="warning">note</output>');
    expect(html).toContain('class="entity-tabs"');
    expect(html).toContain("Jane");
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
    expect(prose).toContain("<h1>Attendee: Jane</h1>");
    expect(prose).toContain('<a href="/add-note">Add a note</a>');
  });

  test("pins the header block across view transitions via .entity-header", () => {
    const html = entityPageView(view);
    // The header carries the view-transition-name hook so the entity title
    // holds still while only the panel beneath the tabs transitions.
    expect(html).toContain('<div class="prose entity-header">');
  });

  test("marks only the active tab with aria-current=page", () => {
    const html = entityPageView(view);
    expect(html).toContain(
      '<a aria-current="page" class="active" href="/admin/attendees/5">Overview</a>',
    );
    expect(html).toContain('<a href="/admin/attendees/5/edit">Edit</a>');
  });

  test("uses link semantics, never ARIA tablist", () => {
    const html = entityPageView(view);
    expect(html).not.toContain("tablist");
    expect(html).not.toContain('role="tab"');
  });

  test("groups the page and each tab section with the shared spacing components", () => {
    const html = entityPageView({
      ...view,
      sections: [
        ...view.sections,
        { html: Raw({ html: "<p>Second section</p>" }), kind: "custom" },
      ],
    });
    expect(html).toContain('<div class="page-regions entity-page">');
    expect(html).toContain('<div class="page-regions entity-tab-panel">');
    expect(html).toContain('<div class="page-block">');
    expect((html.match(/class="page-block"/g) ?? []).length).toBe(2);
    expect(html).toContain("Second section");
    expect(html).not.toContain('class="table-controls"');
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
});
