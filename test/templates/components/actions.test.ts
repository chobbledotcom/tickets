import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ICONS_PATH } from "#shared/asset-paths.ts";
import {
  ActionButton,
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
