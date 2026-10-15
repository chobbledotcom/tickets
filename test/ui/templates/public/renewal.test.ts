import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { renewalErrorPage } from "#templates/public/renewal.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("renewal error template", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("names the site without rendering stored markup", () => {
    const html = renewalErrorPage({ siteName: "Example <Tickets>" });

    says(html, "<title>Renewal Unavailable</title>");
    says(html, "<h1>Renewal Unavailable</h1>");
    says(html, "Example &lt;Tickets&gt;");
    says(html, "Please contact support.");
  });
});
