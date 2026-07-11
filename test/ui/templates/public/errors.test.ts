import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  migrationInProgressPage,
  notFoundPage,
  siteNotActivatedPage,
  temporaryErrorPage,
} from "#templates/public/errors.tsx";
import { registerPublicTemplateHooks } from "#test/templates/public/helpers.ts";

registerPublicTemplateHooks();

describe("notFoundPage", () => {
  test("renders not found message", () => {
    const html = notFoundPage();
    expect(html).toContain("<h1>Not Found</h1>");
  });
});

describe("temporaryErrorPage", () => {
  test("renders error message with auto-refresh", () => {
    const html = temporaryErrorPage();
    expect(html).toContain("<h1>Temporary Error</h1>");
    expect(html).toContain("Retrying automatically");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="2"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });
});

describe("migrationInProgressPage", () => {
  test("renders update message with auto-refresh", () => {
    const html = migrationInProgressPage();
    expect(html).toContain("<h1>Update In Progress</h1>");
    expect(html).toContain("backing up and updating the database");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="5"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });

  test("does not present itself as an error", () => {
    const html = migrationInProgressPage();
    expect(html).not.toContain("Error");
  });
});

describe("siteNotActivatedPage", () => {
  test("renders not-activated message in the error dialog style", () => {
    const html = siteNotActivatedPage();
    expect(html).toContain(
      '<div class="prose"><h1>Not Activated</h1><p>This site has not been activated yet.</p></div>',
    );
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
  });

  test("does not auto-refresh", () => {
    const html = siteNotActivatedPage();
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
