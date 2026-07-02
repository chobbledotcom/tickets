import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  resolveTabSlug,
  splitActions,
  tabLinks,
  tabPath,
  type TabState,
} from "#shared/entity-pages/core.ts";

const tab = (slug: string, visible = true): TabState => ({
  labelKey: `entity.tab.${slug || "overview"}`,
  slug,
  visible,
});

describe("tabPath", () => {
  test("the default tab is the bare base path, not a trailing slash", () => {
    expect(tabPath("/admin/attendees/5", "")).toBe("/admin/attendees/5");
  });

  test("a named tab appends its slug as a path segment", () => {
    expect(tabPath("/admin/attendees/5", "ledger")).toBe(
      "/admin/attendees/5/ledger",
    );
  });
});

describe("resolveTabSlug", () => {
  const tabs = [tab(""), tab("edit"), tab("ledger", false), tab("activity")];

  test("a bare request lands on the first VISIBLE tab", () => {
    expect(resolveTabSlug(tabs, "")).toBe("");
    // Role-aware default: when the first tab is hidden, the bare URL lands
    // on the next visible one instead of 404ing or leaking the hidden tab.
    expect(resolveTabSlug([tab("", false), tab("edit")], "")).toBe("edit");
  });

  test("a named visible tab resolves to itself", () => {
    expect(resolveTabSlug(tabs, "edit")).toBe("edit");
    expect(resolveTabSlug(tabs, "activity")).toBe("activity");
  });

  test("a hidden tab 404s even when named directly — visibility IS authorization", () => {
    expect(resolveTabSlug(tabs, "ledger")).toBeNull();
  });

  test("an unknown slug resolves to null (404)", () => {
    expect(resolveTabSlug(tabs, "nonsense")).toBeNull();
  });

  test("no visible tabs at all resolves to null", () => {
    expect(resolveTabSlug([tab("", false)], "")).toBeNull();
  });
});

describe("tabLinks", () => {
  test("hidden tabs are absent from the strip entirely, and only the active tab is marked", () => {
    const links = tabLinks(
      [tab(""), tab("edit"), tab("ledger", false)],
      "/admin/attendees/5",
      "edit",
    );
    expect(links).toEqual([
      {
        active: false,
        href: "/admin/attendees/5",
        labelKey: "entity.tab.overview",
      },
      {
        active: true,
        href: "/admin/attendees/5/edit",
        labelKey: "entity.tab.edit",
      },
    ]);
  });
});

describe("splitActions", () => {
  test("splits danger actions from plain ones, preserving order within each", () => {
    const actions = [
      { danger: false, name: "refund" },
      { name: "resend" },
      { danger: true, name: "delete" },
      { name: "text" },
    ];
    expect(splitActions(actions)).toEqual({
      danger: [{ danger: true, name: "delete" }],
      plain: [
        { danger: false, name: "refund" },
        { name: "resend" },
        { name: "text" },
      ],
    });
  });

  test("an empty list yields two empty halves", () => {
    expect(splitActions([])).toEqual({ danger: [], plain: [] });
  });
});
