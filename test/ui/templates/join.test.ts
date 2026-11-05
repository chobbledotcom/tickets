import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { joinCompletePage, joinErrorPage, joinPage } from "#templates/join.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("join templates", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the password form for the invited user", () => {
    const html = joinPage(
      "invite-code",
      "New <User>",
      "<password-fields/>",
      "Try again",
    );

    expectIncludesAll(html, [
      "<title>Set your password</title>",
      "Welcome, New &lt;User&gt;",
      'action="/join/invite-code"',
      "Set your password to complete your account setup.",
      "<password-fields/>",
      "Try again",
      ">Set password</button>",
    ]);
  });

  test("renders every account-created message", () => {
    const html = joinCompletePage();

    expectIncludesAll(html, [
      "<title>Account created</title>",
      "<h1>Password set</h1>",
      "Your password has been set successfully.",
      "Your account is ready",
      'href="/admin/login"',
      "<span>Log in</span>",
    ]);
  });

  test("renders an invalid invite without trusting the message", () => {
    const html = joinErrorPage("Expired <invite>");

    expectIncludesAll(html, [
      "<title>Invalid invite</title>",
      "<h1>Invalid invite</h1>",
      "Expired &lt;invite&gt;",
    ]);
  });
});
