import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { renewalErrorPage } from "#templates/public/renewal.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("renewal error template", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("names the site without rendering stored markup", () => {
    const html = renewalErrorPage({ siteName: "Example <Tickets>" });

    expect(html).toContain("<title>Renewal Unavailable</title>");
    expect(html).toContain("<h1>Renewal Unavailable</h1>");
    expect(html).toContain("Example &lt;Tickets&gt;");
    expect(html).toContain("Please contact support.");
  });
});
