import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { settingsPage } from "#templates/admin/settings/page-shell.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("settingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the title, the body, and the settings guide footer", () => {
    const html = settingsPage("Site settings")(OWNER_SESSION, "light")(
      <p>Page body line</p>,
    );
    expectIncludesAll(html, [
      "<title>Site settings</title>",
      "Page body line",
      'href="/admin/guide#settings"',
      "Settings guide",
    ]);
  });

  test("marks the settings nav link active when the page names no path", () => {
    const html = settingsPage("Site settings")(OWNER_SESSION, "light")(
      <p>Page body line</p>,
    );
    expectIncludesAll(html, ['<a class="active" href="/admin/settings">']);
  });

  test("marks the page's own nav link active when it names one", () => {
    const html = settingsPage("Debug", "/admin/debug")(OWNER_SESSION, "light")(
      <p>Page body line</p>,
    );
    expectIncludesAll(html, ['<a class="active" href="/admin/debug">']);
  });
});
