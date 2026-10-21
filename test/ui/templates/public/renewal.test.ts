import { assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { renewalErrorPage } from "#templates/public/renewal.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("renewal error template", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("names the site without rendering stored markup", () => {
    const html = renewalErrorPage({ siteName: "Example <Tickets>" });

    assertStringIncludes(html, "<title>Renewal Unavailable</title>");
    assertStringIncludes(html, "<h1>Renewal Unavailable</h1>");
    assertStringIncludes(html, "Example &lt;Tickets&gt;");
    assertStringIncludes(html, "Please contact support.");
  });
});
