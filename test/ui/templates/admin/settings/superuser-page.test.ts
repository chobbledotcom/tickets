import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminSettingsPage,
  type SettingsPageState,
} from "#templates/admin/settings.tsx";
import { defaultSettingsState } from "#test/ui/templates/admin/settings-state.ts";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";
import { validEmail } from "#test-utils/email.ts";
import { says } from "#test-utils/says.ts";

type AvailableSuperuser = Extract<
  SettingsPageState["superuser"],
  { available: true }
>;

const availableSuperuser = (
  overrides: Partial<AvailableSuperuser> = {},
): AvailableSuperuser => ({
  activated: false,
  available: true,
  choice: "",
  email: validEmail("admin@example.com"),
  userExists: false,
  username: "admin",
  ...overrides,
});

const renderSuperuser = (superuser: SettingsPageState["superuser"]): string =>
  adminSettingsPage(OWNER_SESSION, { ...defaultSettingsState(), superuser });

const superuserFormHtml = (html: string): string => {
  const start = html.indexOf('id="settings-superuser"');
  const end = html.indexOf("</form>", start);
  if (start < 0 || end < 0) {
    throw new Error("Expected settings superuser form");
  }
  return html.slice(start, end + "</form>".length);
};

describe("adminSettingsPage > SuperuserForm", () => {
  beforeAll(setupAdminPageTest);

  describe("availability", () => {
    test("renders the heading when superuser recovery is available", () => {
      const html = renderSuperuser(availableSuperuser());
      says(html, "Superuser Recovery");
    });

    test("does not render when recovery is unavailable", () => {
      const reasons = [
        "missing-env",
        "invalid-env",
        "invalid-username",
      ] as const;
      for (const reason of reasons) {
        const html = renderSuperuser({ available: false, reason });
        assert(!html.includes("Superuser Recovery"));
        assert(!html.includes("superuser_choice"));
      }
    });
  });

  describe("radio labels", () => {
    test("renders the self-managed choice with the correct wording", () => {
      const html = renderSuperuser(availableSuperuser());
      says(
        html,
        "I understand that my attendee information cannot be decrypted without my password, and that I am responsible for storing my password securely. If I forget it, I will be locked out of my attendee records.",
      );
      says(html, "responsible");
      assert(!html.includes("responsiblity"));
    });

    test("renders the admin email in the enable-superuser choice", () => {
      const html = renderSuperuser(
        availableSuperuser({
          email: validEmail("myadmin@example.com"),
          username: "myadmin",
        }),
      );
      says(
        html,
        "I wish to enable a &quot;super user&quot; account on this platform for my admin, myadmin@example.com.",
      );
      says(
        html,
        "This user will be able to log in, decrypt attendee data, and invite a replacement owner account if I lose access.",
      );
    });
  });

  describe("form structure", () => {
    const baseSuperuser = availableSuperuser();

    test("radio inputs use the superuser choice field", () => {
      const html = renderSuperuser(baseSuperuser);
      expect(html.match(/name="superuser_choice"/g)?.length).toBe(2);
    });

    test("the self-managed radio has its stored value", () => {
      says(renderSuperuser(baseSuperuser), 'value="self-managed"');
    });

    test("the enable-superuser radio has its stored value", () => {
      says(renderSuperuser(baseSuperuser), 'value="enable-superuser"');
    });

    test("posts to the superuser settings route", () => {
      says(
        renderSuperuser(baseSuperuser),
        'action="/admin/settings/superuser"',
      );
    });

    test("has the anchor id", () => {
      says(renderSuperuser(baseSuperuser), 'id="settings-superuser"');
    });

    test("includes a CSRF token field", () => {
      const html = renderSuperuser(baseSuperuser);
      says(html, 'type="hidden"');
      says(html, 'name="csrf_token"');
    });
  });

  describe("radio checked state", () => {
    test("checks only self-managed for that choice", () => {
      const html = renderSuperuser(
        availableSuperuser({ choice: "self-managed" }),
      );
      expect(hasCheckedInput(html, "superuser_choice", "self-managed")).toBe(
        true,
      );
      expect(
        hasCheckedInput(html, "superuser_choice", "enable-superuser"),
      ).toBe(false);
    });

    test("checks only enable-superuser for an enabled choice", () => {
      const html = renderSuperuser(availableSuperuser({ choice: "enabled" }));
      expect(hasCheckedInput(html, "superuser_choice", "self-managed")).toBe(
        false,
      );
      expect(
        hasCheckedInput(html, "superuser_choice", "enable-superuser"),
      ).toBe(true);
    });
  });

  describe("existing-superuser state", () => {
    const existingSuperuserHtml = (): string =>
      renderSuperuser(
        availableSuperuser({
          activated: true,
          userExists: true,
          username: "myadmin",
        }),
      );

    test("shows the activated username", () => {
      says(existingSuperuserHtml(), "Superuser myadmin is already activated.");
    });

    test("links to the users page and ends the message with a period", () => {
      const html = existingSuperuserHtml();
      says(html, '<a href="/admin/users">users page</a>');
      says(html, "users page</a>.");
    });

    test("does not render radio inputs", () => {
      assert(
        !superuserFormHtml(existingSuperuserHtml()).includes('type="radio"'),
      );
    });

    test("does not render a submit button", () => {
      const html = superuserFormHtml(existingSuperuserHtml());
      assert(!html.includes('type="submit"'));
      assert(!html.includes("<button"));
    });

    test("renders a submit button before activation", () => {
      const html = superuserFormHtml(renderSuperuser(availableSuperuser()));
      says(html, 'type="submit"');
    });
  });

  test("appears before the change-password form", () => {
    const html = renderSuperuser(availableSuperuser());
    const superuserIndex = html.indexOf("Superuser Recovery");
    const changePasswordIndex = html.indexOf("Change Password");
    expect(superuserIndex).toBeGreaterThan(-1);
    expect(changePasswordIndex).toBeGreaterThan(-1);
    expect(superuserIndex).toBeLessThan(changePasswordIndex);
  });
});
