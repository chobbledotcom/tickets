import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { jsx } from "#jsx/jsx-runtime.ts";
import { ICONS_PATH } from "#shared/asset-paths.ts";
import type { AdminLevel } from "#shared/types.ts";
import {
  ActionButton,
  BackButton,
  GuideFooter,
  GuideLink,
  Icon,
  SubmitButton,
} from "#templates/components/actions.tsx";

describe("Icon", () => {
  test("renders a sprite reference sized via the icon class", () => {
    const html = String(Icon({ name: "plus" }));
    expect(html).toContain('class="icon"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`href="${ICONS_PATH}#plus"`);
  });
});

describe("ActionButton", () => {
  test("renders a primary button-styled link with an icon and label", () => {
    const html = String(
      ActionButton({
        children: "Add Holiday",
        href: "/admin/holidays/new",
        icon: "plus",
      }),
    );
    expect(html).toContain('class="btn"');
    expect(html).toContain('href="/admin/holidays/new"');
    expect(html).toContain(`href="${ICONS_PATH}#plus"`);
    expect(html).toContain("<span>Add Holiday</span>");
  });

  test("omits the icon when none is given", () => {
    const html = String(ActionButton({ children: "Continue", href: "/next" }));
    expect(html).toContain('class="btn"');
    expect(html).not.toContain("<svg");
    expect(html).toContain("<span>Continue</span>");
  });

  test("applies the secondary variant class", () => {
    const html = String(
      ActionButton({
        children: "Build New Site",
        href: "/admin/builder",
        variant: "secondary",
      }),
    );
    expect(html).toContain('class="btn secondary"');
  });

  test("applies the outline variant class", () => {
    const html = String(
      ActionButton({ children: "Try again", href: "/x", variant: "outline" }),
    );
    expect(html).toContain('class="btn outline"');
  });
});

describe("SubmitButton", () => {
  test("renders a submit button with a leading icon and label", () => {
    const html = String(SubmitButton({ children: "Save Theme", icon: "save" }));
    expect(html).toContain('type="submit"');
    expect(html).toContain(`href="${ICONS_PATH}#save"`);
    expect(html).toContain("<span>Save Theme</span>");
  });

  test("passes through a class for button modifiers", () => {
    const html = String(
      SubmitButton({
        children: "Reset Database",
        class: "danger",
        icon: "trash-2",
      }),
    );
    expect(html).toContain('class="danger"');
    expect(html).toContain(`href="${ICONS_PATH}#trash-2"`);
  });

  test("passes through an id for script-targeted buttons", () => {
    const html = String(
      SubmitButton({
        children: "Save Changes",
        icon: "save",
        id: "listing-edit-submit",
      }),
    );
    expect(html).toContain('id="listing-edit-submit"');
  });
});

describe("BackButton", () => {
  test("renders a compact button-styled link with a back-arrow icon", () => {
    const html = String(
      BackButton({ children: "Back to attendee", href: "/admin/attendees/7" }),
    );
    expect(html).toContain('class="btn small"');
    expect(html).toContain('href="/admin/attendees/7"');
    expect(html).toContain(`href="${ICONS_PATH}#arrow-left"`);
    expect(html).toContain("<span>Back to attendee</span>");
  });
});

describe("GuideLink", () => {
  test("renders a muted help link with a book icon", () => {
    const html = String(
      GuideLink({ children: "Holidays guide", href: "/admin/guide#holidays" }),
    );
    expect(html).toContain('class="guide-link"');
    expect(html).toContain('href="/admin/guide#holidays"');
    expect(html).toContain(`href="${ICONS_PATH}#book-open"`);
    expect(html).toContain("<span>Holidays guide</span>");
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
    expect(html).toContain('class="guide-footer"');
    expect(html).toContain('href="/admin/guide#listings"');
    expect(html).toContain("<span>Listings guide</span>");
  });

  test("renders for staff roles (owner/manager) when a role is given", () => {
    for (const adminLevel of ["owner", "manager"] as const) {
      const html = String(GuideFooter(guideFooterProps(adminLevel)));
      expect(html).toContain('class="guide-footer"');
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
});
