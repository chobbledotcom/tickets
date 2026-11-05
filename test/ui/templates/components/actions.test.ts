import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { jsx } from "#jsx/jsx-runtime.ts";
import { ICONS_PATH } from "#shared/asset-paths.ts";
import {
  ActionButton,
  BackButton,
  GuideFooter,
  GuideLink,
  guideFooterFor,
  Icon,
  MaybeButtonLink,
  SaveActions,
  SaveButton,
  SaveChangesButton,
  SpanOrLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import type { AdminLevel } from "#types";

describe("Icon", () => {
  test("renders a sprite reference sized via the icon class", () => {
    const html = String(Icon({ name: "plus" }));
    expectIncludesAll(html, [
      'class="icon"',
      'aria-hidden="true"',
      'focusable="false"',
      `href="${ICONS_PATH}#plus"`,
    ]);
  });
});

describe("ActionButton", () => {
  test("renders a primary button-styled link with an icon and label", () => {
    const html = String(
      ActionButton({
        children: "Add holiday",
        href: "/admin/holidays/new",
        icon: "plus",
      }),
    );
    expectIncludesAll(html, [
      'class="btn"',
      'href="/admin/holidays/new"',
      `href="${ICONS_PATH}#plus"`,
      "<span>Add holiday</span>",
    ]);
  });

  test("omits the icon when none is given", () => {
    const html = String(ActionButton({ children: "Continue", href: "/next" }));
    assertStringIncludes(html, 'class="btn"');
    assert(!html.includes("<svg"));
    assertStringIncludes(html, "<span>Continue</span>");
  });

  test("applies the secondary variant class", () => {
    const html = String(
      ActionButton({
        children: "Build New Site",
        href: "/admin/builder",
        variant: "secondary",
      }),
    );
    assertStringIncludes(html, 'class="btn secondary"');
  });

  test("applies the outline variant class", () => {
    const html = String(
      ActionButton({ children: "Try again", href: "/x", variant: "outline" }),
    );
    assertStringIncludes(html, 'class="btn outline"');
  });
});

describe("SubmitButton", () => {
  test("renders a submit button with a leading icon and label", () => {
    const html = String(SubmitButton({ children: "Save Theme", icon: "save" }));
    expectIncludesAll(html, [
      'type="submit"',
      `href="${ICONS_PATH}#save"`,
      "<span>Save Theme</span>",
    ]);
  });

  test("passes through a class for button modifiers", () => {
    const html = String(
      SubmitButton({
        children: "Reset Database",
        class: "danger",
        icon: "trash-2",
      }),
    );
    expectIncludesAll(html, ['class="danger"', `href="${ICONS_PATH}#trash-2"`]);
  });

  test("passes through an id for script-targeted buttons", () => {
    const html = String(
      SubmitButton({
        children: "Save Changes",
        icon: "save",
        id: "listing-edit-submit",
      }),
    );
    assertStringIncludes(html, 'id="listing-edit-submit"');
  });

  test("renders disabled only when requested", () => {
    assertStringIncludes(
      String(SubmitButton({ children: "Save", disabled: true, icon: "save" })),
      " disabled",
    );
    assert(
      !String(SubmitButton({ children: "Save", icon: "save" })).includes(
        " disabled",
      ),
    );
  });
});

describe("save buttons", () => {
  test("renders the form action wrapper and primary save button", () => {
    const html = String(SaveActions({ children: "Store changes" }));
    expectIncludesAll(html, [
      '<p class="form-actions">',
      '<button class="primary"',
      "<span>Store changes</span>",
    ]);
  });

  test("renders each standard translated label", () => {
    assertStringIncludes(
      String(SaveChangesButton()),
      "<span>Save Changes</span>",
    );
    assertStringIncludes(String(SaveButton()), "<span>Save</span>");
  });
});

describe("conditional links", () => {
  test("renders SpanOrLink as the requested element", () => {
    const span = String(
      SpanOrLink({
        asSpan: true,
        children: "Unavailable",
        href: "/ignored",
        spanClass: "muted",
      }),
    );
    expect(span).toBe('<span class="muted">Unavailable</span>');

    const link = String(
      SpanOrLink({
        asSpan: false,
        children: "Continue",
        class: "btn",
        href: "/next",
      }),
    );
    expect(link).toBe('<a class="btn" href="/next">Continue</a>');
  });

  test("keeps enabled button links clickable by default", () => {
    expect(
      String(
        MaybeButtonLink({
          children: "Continue",
          class: "btn",
          href: "/next",
        }),
      ),
    ).toBe('<a class="btn" href="/next">Continue</a>');
  });

  test("renders disabled button links as inert spans", () => {
    expect(
      String(
        MaybeButtonLink({
          children: "Continue",
          class: "btn",
          disabled: true,
          href: "/next",
          title: "Not ready",
        }),
      ),
    ).toBe('<span class="btn btn--disabled" title="Not ready">Continue</span>');
  });
});

describe("BackButton", () => {
  test("renders a compact button-styled link with a back-arrow icon", () => {
    const html = String(
      BackButton({ children: "Back to attendee", href: "/admin/attendees/7" }),
    );
    expectIncludesAll(html, [
      'class="btn small"',
      'href="/admin/attendees/7"',
      `href="${ICONS_PATH}#arrow-left"`,
      "<span>Back to attendee</span>",
    ]);
  });
});

describe("GuideLink", () => {
  test("renders a muted help link with a book icon", () => {
    const html = String(
      GuideLink({ children: "Holidays guide", href: "/admin/guide#holidays" }),
    );
    expectIncludesAll(html, [
      'class="guide-link"',
      'href="/admin/guide#holidays"',
      `href="${ICONS_PATH}#book-open"`,
      "<span>Holidays guide</span>",
    ]);
  });
});

describe("GuideFooter", () => {
  const guideFooterProps = (adminLevel?: AdminLevel) => ({
    children: "Listings guide",
    href: "/admin/guide#listings",
    ...(adminLevel === undefined ? {} : { adminLevel }),
  });

  test("renders the bottom-of-page guide link when no role is given", () => {
    const html = String(GuideFooter(guideFooterProps()));
    expectIncludesAll(html, [
      'class="guide-footer"',
      'href="/admin/guide#listings"',
      "<span>Listings guide</span>",
    ]);
  });

  test("renders for staff roles (owner/manager) when a role is given", () => {
    for (const adminLevel of ["owner", "manager"] as const) {
      const html = String(GuideFooter(guideFooterProps(adminLevel)));
      assertStringIncludes(html, 'class="guide-footer"');
    }
  });

  test("renders nothing for non-staff roles (the guide is staff-only, 403s them)", () => {
    for (const adminLevel of ["editor", "agent"] as const) {
      expect(String(GuideFooter(guideFooterProps(adminLevel)))).toBe("");
    }
  });

  test("renders empty HTML for hidden footers used as JSX components", () => {
    const html = String(
      jsx("div", {
        children: jsx(() => GuideFooter(guideFooterProps("editor")), null),
      }),
    );
    expect(html).toBe("<div></div>");
  });

  test("guideFooterFor links one section with the catalog label", () => {
    const html = String(
      guideFooterFor("/admin/guide#settings", "settings.guide_link"),
    );
    expectIncludesAll(html, [
      'href="/admin/guide#settings"',
      'class="guide-footer"',
      "Settings guide",
    ]);
  });
});
