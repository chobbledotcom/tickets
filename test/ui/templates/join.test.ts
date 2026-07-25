import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { joinCompletePage, joinErrorPage, joinPage } from "#templates/join.tsx";
import { registerPublicTemplateHooks } from "#test/templates/public/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("join templates", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the password form for the invited user", () => {
    const html = joinPage("invite-code", "New <User>", "Try again");

    expect(html).toContain("<title>Set Your Password</title>");
    expect(html).toContain("Welcome, New &lt;User&gt;");
    expect(html).toContain('action="/join/invite-code"');
    expect(html).toContain("Set your password to complete your account setup.");
    expect(html).toContain("Try again");
    expect(html).toContain(">Set Password</button>");
  });

  test("renders every account-created message", () => {
    const html = joinCompletePage();

    expect(html).toContain("<title>Account Created</title>");
    expect(html).toContain("<h1>Password Set</h1>");
    expect(html).toContain("Your password has been set successfully.");
    expect(html).toContain("Your account is ready");
    expect(html).toContain('href="/admin/login"');
    expect(html).toContain("<span>Log In</span>");
  });

  test("renders an invalid invite without trusting the message", () => {
    const html = joinErrorPage("Expired <invite>");

    expect(html).toContain("<title>Invalid Invite</title>");
    expect(html).toContain("<h1>Invalid Invite</h1>");
    expect(html).toContain("Expired &lt;invite&gt;");
  });
});
