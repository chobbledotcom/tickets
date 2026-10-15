import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { prosePage, simplePublicPage } from "#templates/public/prose-page.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("public prose pages", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders content after the prose block", () => {
    const html = prosePage("Page title", "Main heading")(
      <p>Introduction</p>,
      <form>Action</form>,
    );

    says(
      html,
      '<div class="prose"><h1>Main heading</h1><p>Introduction</p></div><form>Action</form>',
    );
  });

  test("keeps a simple page body inside the prose block", () => {
    const html = simplePublicPage(
      "Page title",
      "Main heading",
    )(<p>Whole body</p>);

    says(
      html,
      '<div class="prose"><h1>Main heading</h1><p>Whole body</p></div>',
    );
  });
});
