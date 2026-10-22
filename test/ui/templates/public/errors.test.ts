import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  databaseBusyPage,
  migrationInProgressPage,
  notFoundPage,
  qrBookCheckoutErrorPage,
  qrBookErrorPage,
  rateLimitedPage,
  readOnlyPage,
  siteNotActivatedPage,
  temporaryErrorPage,
} from "#templates/public/errors.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";

describe("notFoundPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders not found message", () => {
    const html = notFoundPage();
    assertStringIncludes(html, "<h1>Not Found</h1>");
  });
});

describe("temporaryErrorPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders error message with auto-refresh", () => {
    const html = temporaryErrorPage(true);
    assertStringIncludes(html, "<h1>Temporary error</h1>");
    assertStringIncludes(html, "Retrying automatically");
    assertStringIncludes(html, 'http-equiv="refresh"');
    assertStringIncludes(html, 'content="2"');
    assertStringIncludes(html, "<style>");
    assertStringIncludes(html, "font-family:system-ui");
    // Points at Bunny's status page, with the space before the link kept.
    assertStringIncludes(
      html,
      'Check <strong><a href="https://status.bunny.net/">status.bunny.net</a>',
    );
  });
  test("preserves uncertainty about the submission", () => {
    const html = temporaryErrorPage(false);
    assert(!html.includes('http-equiv="refresh"'));
    assert(!html.includes("Retrying automatically"));
    assert(!html.includes("your submission was not saved"));
    assertStringIncludes(html, "Your changes may already be saved.");
    assertStringIncludes(
      html,
      "Check the existing records or your booking before you submit again.",
    );
    assertStringIncludes(html, "font-family:system-ui");
    assertStringIncludes(html, 'href="https://status.bunny.net/"');
  });
});

describe("qrBookErrorPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("identifies a checkout failure and escapes the provider message", () => {
    const html = qrBookCheckoutErrorPage("summer-fete", "Failed <payment>");
    assertStringIncludes(html, "<title>Could not start payment</title>");
    assertStringIncludes(html, "<h1>Could not start your payment</h1>");
    assertStringIncludes(html, "<p>Failed &lt;payment&gt;</p>");
    assertStringIncludes(html, 'href="/ticket/summer-fete"');
  });

  test("offers the normal booking page when the listing has a slug", () => {
    const html = qrBookErrorPage("summer-fete");
    assertStringIncludes(html, "<h1>QR code expired or invalid</h1>");
    assertStringIncludes(html, "This QR code has expired");
    assertStringIncludes(
      html,
      '<a href="/ticket/summer-fete">Go to booking page</a>',
    );
  });

  test("omits the booking link when there is no standalone page", () => {
    const html = qrBookErrorPage(null);
    assertStringIncludes(html, "This QR code has expired");
    assert(!html.includes("Go to booking page"));
    assert(!html.includes('href="/ticket/'));
  });
});

describe("rateLimitedPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the too-many-requests message", () => {
    const html = rateLimitedPage();
    assertStringIncludes(html, "<h1>Too Many Requests</h1>");
    assertStringIncludes(html, "You've hit too many invalid ticket links.");
  });
});

describe("databaseBusyPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("auto-refreshes and reassures when the method is idempotent", () => {
    const html = databaseBusyPage(true);
    assertStringIncludes(html, "<h1>The database is too busy.</h1>");
    assertStringIncludes(html, 'http-equiv="refresh"');
    assertStringIncludes(html, "Reloading so you can try again.");
    assert(!html.includes("your submission was not saved"));
  });

  test("skips the refresh and asks to resubmit for non-idempotent methods", () => {
    const html = databaseBusyPage(false);
    assertStringIncludes(html, "<h1>The database is too busy.</h1>");
    assert(!html.includes('http-equiv="refresh"'));
    assertStringIncludes(
      html,
      "Please go back and try again — your submission was not saved.",
    );
    assert(!html.includes("Reloading so you can try again."));
  });
});

describe("readOnlyPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  // Set RENEWAL_URL through the worker-local overlay (not the shared process
  // env, which parallel test files read) and restore it afterwards.
  const withRenewalUrl = (value: string | undefined, run: () => void): void => {
    using _env = withEnv({ RENEWAL_URL: value });
    run();
  };

  test("includes the renewal link when RENEWAL_URL is set", () => {
    withRenewalUrl("https://example.com/renew", () => {
      const html = readOnlyPage();
      assertStringIncludes(html, "This site is in read-only mode.");
      assertStringIncludes(
        html,
        '<a href="https://example.com/renew">Renew now</a>',
      );
    });
  });

  test("omits the renewal link when RENEWAL_URL is unset", () => {
    withRenewalUrl(undefined, () => {
      const html = readOnlyPage();
      assertStringIncludes(html, "This site is in read-only mode.");
      assert(!html.includes("Renew now"));
    });
  });
});

describe("migrationInProgressPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders update message with auto-refresh", () => {
    const html = migrationInProgressPage();
    assertStringIncludes(html, "<h1>Update In Progress</h1>");
    assertStringIncludes(html, "backing up and updating the database");
    assertStringIncludes(html, 'http-equiv="refresh"');
    assertStringIncludes(html, 'content="5"');
    assertStringIncludes(html, "<style>");
    assertStringIncludes(html, "font-family:system-ui");
  });

  test("does not present itself as an error", () => {
    const html = migrationInProgressPage();
    assert(!html.includes("<title>Error"));
    assert(!html.includes("<h1>Error"));
  });
});

describe("siteNotActivatedPage", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders not-activated message in the error dialog style", () => {
    const html = siteNotActivatedPage();
    assertStringIncludes(
      html,
      '<div class="prose"><h1>Not Activated</h1><p>This site has not been activated yet.</p></div>',
    );
    assertStringIncludes(html, "<style>");
    assertStringIncludes(html, "font-family:system-ui");
  });

  test("does not auto-refresh", () => {
    const html = siteNotActivatedPage();
    assert(!html.includes('http-equiv="refresh"'));
  });
});
