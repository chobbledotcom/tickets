import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  databaseBusyPage,
  migrationInProgressPage,
  notFoundPage,
  qrBookErrorPage,
  rateLimitedPage,
  readOnlyPage,
  siteNotActivatedPage,
  temporaryErrorPage,
} from "#templates/public/errors.tsx";
import { registerPublicTemplateHooks } from "#test/templates/public/helpers.ts";
import { withEnv } from "#test-utils/env.ts";

describe("notFoundPage", () => {
  registerPublicTemplateHooks();

  test("renders not found message", () => {
    const html = notFoundPage();
    expect(html).toContain("<h1>Not Found</h1>");
  });
});

describe("temporaryErrorPage", () => {
  registerPublicTemplateHooks();

  test("renders error message with auto-refresh", () => {
    const html = temporaryErrorPage();
    expect(html).toContain("<h1>Temporary Error</h1>");
    expect(html).toContain("Retrying automatically");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="2"');
    expect(html).toContain("<style>");
    expect(html).toContain("font-family:system-ui");
    // Points at Bunny's status page, with the space before the link kept.
    expect(html).toContain(
      'Check <strong><a href="https://status.bunny.net/">status.bunny.net</a>',
    );
  });
});

describe("qrBookErrorPage", () => {
  registerPublicTemplateHooks();

  test("offers the normal booking page when the listing has a slug", () => {
    const html = qrBookErrorPage("summer-fete");
    expect(html).toContain("<h1>QR code expired or invalid</h1>");
    expect(html).toContain("This QR code has expired");
    expect(html).toContain(
      '<a href="/ticket/summer-fete">Go to booking page</a>',
    );
  });

  test("omits the booking link when there is no standalone page", () => {
    const html = qrBookErrorPage(null);
    expect(html).toContain("This QR code has expired");
    expect(html).not.toContain("Go to booking page");
    expect(html).not.toContain('href="/ticket/');
  });
});

describe("rateLimitedPage", () => {
  registerPublicTemplateHooks();

  test("renders the too-many-requests message", () => {
    const html = rateLimitedPage();
    expect(html).toContain("<h1>Too Many Requests</h1>");
    expect(html).toContain("You've hit too many invalid ticket links.");
  });
});

describe("databaseBusyPage", () => {
  registerPublicTemplateHooks();

  test("auto-refreshes and reassures when the method is idempotent", () => {
    const html = databaseBusyPage(true);
    expect(html).toContain("<h1>The database is too busy.</h1>");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("Reloading so you can try again.");
    expect(html).not.toContain("your submission was not saved");
  });

  test("skips the refresh and asks to resubmit for non-idempotent methods", () => {
    const html = databaseBusyPage(false);
    expect(html).toContain("<h1>The database is too busy.</h1>");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain(
      "Please go back and try again — your submission was not saved.",
    );
    expect(html).not.toContain("Reloading so you can try again.");
  });
});

describe("readOnlyPage", () => {
  registerPublicTemplateHooks();

  // Set RENEWAL_URL through the worker-local overlay (not the shared process
  // env, which parallel test files read) and restore it afterwards.
  const withRenewalUrl = (value: string | undefined, run: () => void): void => {
    const restore = withEnv({ RENEWAL_URL: value });
    try {
      run();
    } finally {
      restore();
    }
  };

  test("includes the renewal link when RENEWAL_URL is set", () => {
    withRenewalUrl("https://example.com/renew", () => {
      const html = readOnlyPage();
      expect(html).toContain("This site is in read-only mode.");
      expect(html).toContain(
        '<a href="https://example.com/renew">Renew now</a>',
      );
    });
  });

  test("omits the renewal link when RENEWAL_URL is unset", () => {
    withRenewalUrl(undefined, () => {
      const html = readOnlyPage();
      expect(html).toContain("This site is in read-only mode.");
      expect(html).not.toContain("Renew now");
    });
  });
});

describe("migrationInProgressPage", () => {
  registerPublicTemplateHooks();

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
  registerPublicTemplateHooks();

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
