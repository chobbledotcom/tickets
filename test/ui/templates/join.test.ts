import { assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { joinCompletePage, joinErrorPage, joinPage } from "#templates/join.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

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

    assertStringIncludes(html, "<title>Set your password</title>");
    assertStringIncludes(html, "Welcome, New &lt;User&gt;");
    assertStringIncludes(html, 'action="/join/invite-code"');
    assertStringIncludes(
      html,
      "Set your password to complete your account setup.",
    );
    assertStringIncludes(html, "<password-fields/>");
    assertStringIncludes(html, "Try again");
    assertStringIncludes(html, ">Set password</button>");
  });

  test("renders every account-created message", () => {
    const html = joinCompletePage();

    assertStringIncludes(html, "<title>Account created</title>");
    assertStringIncludes(html, "<h1>Password set</h1>");
    assertStringIncludes(html, "Your password has been set successfully.");
    assertStringIncludes(html, "Your account is ready");
    assertStringIncludes(html, 'href="/admin/login"');
    assertStringIncludes(html, "<span>Log in</span>");
  });

  test("renders an invalid invite without trusting the message", () => {
    const html = joinErrorPage("Expired <invite>");

    assertStringIncludes(html, "<title>Invalid invite</title>");
    assertStringIncludes(html, "<h1>Invalid invite</h1>");
    assertStringIncludes(html, "Expired &lt;invite&gt;");
  });
});
