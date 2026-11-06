import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { renewalErrorPage } from "#templates/public/renewal.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("renewal error template", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("names the site without rendering stored markup", () => {
    const html = renewalErrorPage({ siteName: "Example <Tickets>" });

    expectIncludesAll(html, [
      "<title>Renewal Unavailable</title>",
      "<h1>Renewal Unavailable</h1>",
      "Example &lt;Tickets&gt;",
      "Please contact support.",
    ]);
  });
});
