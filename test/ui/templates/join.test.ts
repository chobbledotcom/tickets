import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { joinCompletePage, joinErrorPage, joinPage } from "#templates/join.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

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

    says(html, "<title>Set your password</title>");
    says(html, "Welcome, New &lt;User&gt;");
    says(html, 'action="/join/invite-code"');
    says(html, "Set your password to complete your account setup.");
    says(html, "<password-fields/>");
    says(html, "Try again");
    says(html, ">Set password</button>");
  });

  test("renders every account-created message", () => {
    const html = joinCompletePage();

    says(html, "<title>Account created</title>");
    says(html, "<h1>Password set</h1>");
    says(html, "Your password has been set successfully.");
    says(html, "Your account is ready");
    says(html, 'href="/admin/login"');
    says(html, "<span>Log in</span>");
  });

  test("renders an invalid invite without trusting the message", () => {
    const html = joinErrorPage("Expired <invite>");

    says(html, "<title>Invalid invite</title>");
    says(html, "<h1>Invalid invite</h1>");
    says(html, "Expired &lt;invite&gt;");
  });
});
