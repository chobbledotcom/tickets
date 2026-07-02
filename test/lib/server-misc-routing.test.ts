import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getCleanUrl, handleRequest, isValidContentType } from "#routes";
import {
  databaseBusyResponse,
  migrationInProgressResponse,
  redirect,
  redirectResponse,
  siteNotActivatedResponse,
  temporaryErrorResponse,
} from "#routes/response.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { runWithRequestId } from "#shared/logger.ts";
import {
  createTestDb,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  getEmbeddableTicketResponse,
  getHeader,
  mockFormRequest,
  mockRequest,
  resetDb,
  testCookie,
  withExpectedError,
} from "#test-utils";

describeWithEnv("server (misc: security and routing)", { db: true }, () => {
  const getTicketPageResponse = getEmbeddableTicketResponse;

  async function getMultiSlugTicketPageResponse(): Promise<Response> {
    const listing1 = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const listing2 = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    return handleRequest(
      mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
    );
  }

  const clearWrappedPrivateKey = async () => {
    const { getDb: getDbFn } = await import("#shared/db/client.ts");
    const { settings: s } = await import("#shared/db/settings.ts");
    await getDbFn().execute({
      args: [],
      sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
    });
    s.invalidateCache();
  };

  describe("security headers", () => {
    describe("X-Frame-Options", () => {
      test("home page has X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("admin pages have X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("ticket page does NOT have X-Frame-Options (embeddable)", async () => {
        const response = await getTicketPageResponse();
        expect(response.headers.get("x-frame-options")).toBeNull();
      });

      test("multi-slug ticket page does NOT have X-Frame-Options (embeddable)", async () => {
        const response = await getMultiSlugTicketPageResponse();
        expect(response.headers.get("x-frame-options")).toBeNull();
      });

      test("payment pages have X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/payment/success"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("setup page has X-Frame-Options: DENY", async () => {
        resetDb();
        await createTestDb();
        const response = await handleRequest(mockRequest("/setup/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });
    });

    describe("Content-Security-Policy", () => {
      const baseCsp =
        "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'";

      test("non-embeddable pages have frame-ancestors 'none' and security restrictions", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("content-security-policy")).toBe(
          `frame-ancestors 'none'; ${baseCsp}`,
        );
      });

      test("ticket page has CSP but allows embedding (no frame-ancestors)", async () => {
        const response = await getTicketPageResponse();
        expect(response.headers.get("content-security-policy")).toBe(baseCsp);
      });

      test("multi-slug ticket page allows embedding (no frame-ancestors)", async () => {
        const response = await getMultiSlugTicketPageResponse();
        expect(response.headers.get("content-security-policy")).toBe(baseCsp);
      });

      test("square sandbox CSP includes sandbox domains", async () => {
        await settings.update.paymentProvider("square");
        await settings.update.square.sandbox(true);
        const response = await handleRequest(mockRequest("/"));
        const csp = getHeader(response, "content-security-policy");
        expect(csp).toContain("squareupsandbox.com");
      });
    });

    describe("CSP security invariants", () => {
      const assertCspDirective = (
        csp: string,
        directive: string,
        expected: string,
      ) => {
        const match = csp.match(new RegExp(`${directive} ([^;]+)`));
        expect(match?.[1]).toBe(expected);
      };

      const coreDirectives: Array<[string, string]> = [
        ["default-src", "'self'"],
        ["base-uri", "'self'"],
        ["object-src", "'none'"],
        ["form-action", "'self'"],
      ];

      for (const [directive, expected] of coreDirectives) {
        test(`${directive} is ${expected} on non-embeddable pages`, async () => {
          const csp = getHeader(
            await handleRequest(mockRequest("/")),
            "content-security-policy",
          );
          assertCspDirective(csp, directive, expected);
        });
      }

      test("non-embeddable pages have frame-ancestors 'none'", async () => {
        const csp = getHeader(
          await handleRequest(mockRequest("/")),
          "content-security-policy",
        );
        assertCspDirective(csp, "frame-ancestors", "'none'");
      });

      test("ticket pages omit frame-ancestors 'none'", async () => {
        const csp =
          (await getTicketPageResponse()).headers.get(
            "content-security-policy",
          ) ?? "";
        expect(csp).not.toContain("frame-ancestors 'none'");
      });

      test("configured embed hosts appear in frame-ancestors", async () => {
        await settings.update.embedHosts(
          "https://example.com, https://app.example.org",
        );
        const csp =
          (await getTicketPageResponse()).headers.get(
            "content-security-policy",
          ) ?? "";
        expect(csp).toContain("https://example.com");
        expect(csp).toContain("https://app.example.org");
      });

      const paymentProviders: Array<{
        domainSubstring: string;
        label: string;
        setup: () => Promise<void>;
      }> = [
        {
          domainSubstring: "checkout.stripe.com",
          label: "Stripe",
          setup: () => settings.update.paymentProvider("stripe"),
        },
        {
          domainSubstring: "squareup.com",
          label: "Square",
          setup: async () => {
            await settings.update.paymentProvider("square");
            await settings.update.square.sandbox(false);
          },
        },
        {
          domainSubstring: "squareupsandbox.com",
          label: "Square sandbox",
          setup: async () => {
            await settings.update.paymentProvider("square");
            await settings.update.square.sandbox(true);
          },
        },
        {
          domainSubstring: "checkout.sumup.com",
          label: "SumUp",
          setup: () => settings.update.paymentProvider("sumup"),
        },
      ];

      for (const { domainSubstring, label, setup } of paymentProviders) {
        test(`${label} only widens form-action (no script-src or style-src)`, async () => {
          await setup();
          const csp = getHeader(
            await handleRequest(mockRequest("/")),
            "content-security-policy",
          );
          assertCspDirective(csp, "default-src", "'self'");
          expect(csp).toContain(domainSubstring);
          expect(csp).not.toContain("script-src");
          expect(csp).not.toContain("style-src");
        });
      }
    });

    describe("other security headers", () => {
      test("responses have X-Content-Type-Options: nosniff", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      });

      test("responses have Referrer-Policy header", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
      });

      test("responses have X-Robots-Tag: noindex, nofollow", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      });

      test("omits Strict-Transport-Security on localhost", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.has("strict-transport-security")).toBe(false);
      });

      test("includes Strict-Transport-Security on non-localhost domains", async () => {
        setEffectiveDomainForTest("example.com");
        try {
          const response = await handleRequest(
            mockRequest("https://example.com/"),
          );
          expect(response.headers.get("strict-transport-security")).toBe(
            "max-age=63072000; includeSubDomains; preload",
          );
        } finally {
          resetEffectiveDomain();
        }
      });

      test("ticket pages also have base security headers", async () => {
        const response = await getTicketPageResponse();
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
        expect(response.headers.get("x-robots-tag")).toBe("index, follow");
      });
    });
  });

  describe("Content-Type validation", () => {
    test("rejects POST requests without Content-Type header", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          body: "password=test",
          headers: {
            host: "localhost",
          },
          method: "POST",
        }),
      );
      await expectHtmlResponse(response, 400, "Invalid Content-Type");
    });

    test("rejects POST requests with wrong Content-Type", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          body: JSON.stringify({ password: "test" }),
          headers: {
            "content-type": "application/json",
            host: "localhost",
          },
          method: "POST",
        }),
      );
      await expectHtmlResponse(response, 400, "Invalid Content-Type");
    });

    test("accepts POST requests with multipart/form-data Content-Type", () => {
      const request = new Request("http://localhost/admin/login", {
        body: "------test--",
        headers: {
          "content-type": "multipart/form-data; boundary=----test",
          host: "localhost",
        },
        method: "POST",
      });
      expect(isValidContentType(request, "/admin/login")).toBe(true);
    });
  });

  describe("routes/middleware.ts (empty content-type)", () => {
    test("POST with empty content-type is rejected", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          body: "password=test",
          headers: {
            "content-type": "",
            host: "localhost",
          },
          method: "POST",
        }),
      );
      await expectHtmlResponse(response, 400, "Invalid Content-Type");
    });
  });

  describe("routes/router.ts (slug and generic param patterns)", () => {
    test("slug pattern matches lowercase alphanumeric with hyphens", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "My Test Listing",
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("shared/session-private-key.ts (getSessionPrivateKey)", () => {
    test("returns null when wrappedDataKey is null", async () => {
      const { getSessionPrivateKey } = await import(
        "#shared/session-private-key.ts"
      );
      const result = await getSessionPrivateKey({
        token: "any-token",
        wrappedDataKey: null,
      });
      expect(result).toBeNull();
    });

    test("returns null when wrappedPrivateKey is not set in DB", async () => {
      await clearWrappedPrivateKey();

      const { getSessionPrivateKey } = await import(
        "#shared/session-private-key.ts"
      );
      const result = await getSessionPrivateKey({
        token: "any-token",
        wrappedDataKey: "some-wrapped-key",
      });
      expect(result).toBeNull();
    });

    test("returns null when crypto operation throws", async () => {
      const { getSessionPrivateKey } = await import(
        "#shared/session-private-key.ts"
      );
      const result = await getSessionPrivateKey({
        token: "any-token",
        wrappedDataKey: "corrupt-key-data",
      });
      expect(result).toBeNull();
    });
  });

  describe("routes/utils.ts (redirect)", () => {
    const withRequestContext = <T>(fn: () => T): T => runWithRequestId(fn);

    const createFlashRedirect = () => {
      const response = redirect("/admin/settings", "Saved", true);
      const location = expectRedirect(response);
      const url = new URL(location, "http://localhost");
      const flashId = url.searchParams.get("flash");
      return { flashId, response };
    };

    test("creates success redirect without form ID", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Saved", true);
        expectRedirectWithFlash("/admin/settings", "Saved")(response);
      }));

    test("creates success redirect with form ID and anchor", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Timezone updated", true, {
          formId: "settings-timezone",
        });
        expectRedirectWithFlash(
          "/admin/settings?form=settings-timezone#settings-timezone",
          "Timezone updated",
        )(response);
      }));

    test("encodes special characters in message and form ID", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "A & B", true, {
          formId: "form&id",
        });
        const location = expectRedirect(response, "form=form%26id", "#form&id");
        expect(location).not.toContain("success=");
        expectRedirectWithFlash(
          "/admin/settings?form=form%26id#form&id",
          "A & B",
        )(response);
      }));

    test("creates error redirect", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Something failed", false);
        expectRedirectWithFlash(
          "/admin/settings",
          "Something failed",
          false,
        )(response);
      }));

    test("preserves existing query params without adding message", () =>
      withRequestContext(() => {
        const response = redirect(
          "/admin/listing/1?tab=attendees",
          "Updated",
          true,
        );
        expectRedirectWithFlash(
          "/admin/listing/1?tab=attendees",
          "Updated",
        )(response);
      }));

    test("preserves hash fragment", () =>
      withRequestContext(() => {
        const response = redirect("/admin/calendar#attendees", "Done", true);
        expectRedirectWithFlash("/admin/calendar#attendees", "Done")(response);
      }));

    test("encodes special characters in flash cookie", () =>
      withRequestContext(() => {
        const response = redirect("/admin/listing/1", "A & B", true);
        expectRedirectWithFlash("/admin/listing/1", "A & B")(response);
      }));

    test("uses request ID as flash key in redirect URL", () =>
      withRequestContext(() => {
        const { flashId } = createFlashRedirect();
        expect(flashId).toBeDefined();
        expect(flashId!.length).toBe(4);
      }));

    test("keys flash cookie by the flash ID in the URL", () =>
      withRequestContext(() => {
        const { response, flashId } = createFlashRedirect();
        const cookies = response.headers.getSetCookie();
        const flashCookie = cookies.find((c) =>
          c.startsWith(`flash_${flashId!}=`),
        );
        expect(flashCookie).toBeDefined();
      }));

    test("passes cookie through to response alongside flash cookie", () =>
      withRequestContext(() => {
        const response = redirect("/admin", "Done", true, {
          cookie: "session=abc; Path=/",
        });
        const cookies = response.headers.getSetCookie();
        expect(cookies.some((c) => c === "session=abc; Path=/")).toBe(true);
        expectRedirectWithFlash("/admin", "Done")(response);
      }));
  });

  describe("routes/utils.ts (redirectResponse)", () => {
    test("creates 302 redirect with location header", () => {
      const response = redirectResponse("/ticket/test");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/ticket/test");
    });

    test("appends iframe=true when iframe mode is active", () => {
      detectIframeMode("https://example.com/?iframe=true");
      const response = redirectResponse("/ticket/reserved?tokens=abc");
      expect(response.headers.get("location")).toBe(
        "/ticket/reserved?tokens=abc&iframe=true",
      );
      detectIframeMode("https://example.com/");
    });

    test("does not append iframe param when iframe mode is inactive", () => {
      detectIframeMode("https://example.com/");
      const response = redirectResponse("/ticket/test");
      expect(response.headers.get("location")).toBe("/ticket/test");
    });

    test("sets cookie header when cookie is provided", () => {
      const response = redirectResponse("/admin", "session=abc; Path=/");
      expect(response.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });
  });

  describe("routes/utils.ts (CSRF token validation)", () => {
    test("empty csrf_token from form falls back to empty string", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          { current_password: "test" },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });
  });

  describe("Tracking parameter stripping", () => {
    describe("getCleanUrl", () => {
      test("returns null when URL has no tracking params", () => {
        const url = new URL("http://localhost/ticket/my-listing");
        expect(getCleanUrl(url)).toBeNull();
      });

      test("returns null when URL has only non-tracking params", () => {
        const url = new URL("http://localhost/ticket/my-listing?iframe=true");
        expect(getCleanUrl(url)).toBeNull();
      });

      test("strips fbclid parameter", () => {
        const url = new URL("http://localhost/ticket/my-listing?fbclid=abc123");
        expect(getCleanUrl(url)).toBe("/ticket/my-listing");
      });

      test("strips fbclid but preserves other params", () => {
        const url = new URL(
          "http://localhost/ticket/my-listing?iframe=true&fbclid=abc123",
        );
        expect(getCleanUrl(url)).toBe("/ticket/my-listing?iframe=true");
      });

      test("strips utm parameters", () => {
        const url = new URL(
          "http://localhost/ticket/my-listing?utm_source=facebook&utm_medium=social",
        );
        expect(getCleanUrl(url)).toBe("/ticket/my-listing");
      });

      test("strips gclid parameter", () => {
        const url = new URL("http://localhost/ticket/my-listing?gclid=xyz789");
        expect(getCleanUrl(url)).toBe("/ticket/my-listing");
      });

      test("strips multiple tracking params while preserving non-tracking ones", () => {
        const url = new URL(
          "http://localhost/ticket/reserved?tokens=abc&fbclid=123&utm_source=fb",
        );
        expect(getCleanUrl(url)).toBe("/ticket/reserved?tokens=abc");
      });
    });

    describe("handleRequest redirect", () => {
      test("redirects GET requests with fbclid to clean URL", async () => {
        const response = await handleRequest(
          mockRequest("/ticket/my-listing?fbclid=IwdGRjcAQFOkpleHRuA2FlbQ"),
        );
        expect(response.status).toBe(301);
        expect(response.headers.get("location")).toBe("/ticket/my-listing");
      });

      test("redirects GET requests preserving non-tracking params", async () => {
        const response = await handleRequest(
          mockRequest("/ticket/my-listing?iframe=true&fbclid=abc123"),
        );
        expect(response.status).toBe(301);
        expect(response.headers.get("location")).toBe(
          "/ticket/my-listing?iframe=true",
        );
      });

      test("does not redirect POST requests with tracking params", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
        });
        const response = await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}?fbclid=abc123`, {
            name: "Test",
          }),
        );
        expect(response.status).not.toBe(301);
      });

      test("does not redirect GET requests without tracking params", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        expect(response.status).toBe(200);
      });
    });
  });

  describe("routes/router.ts (param patterns)", () => {
    test("matches slug pattern with lowercase alphanumeric and hyphens", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "My Test Listing",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      expect(response.status).toBe(200);
    });

    test("returns 404 for unknown route pattern", async () => {
      const response = await handleRequest(mockRequest("/unknown-path-xyz"));
      expect(response.status).toBe(404);
    });
  });

  describe("routes/router.ts (slug and generic param coverage)", () => {
    test("createRouter matches slug param pattern correctly", async () => {
      const { createRouter } = await import("#routes/router.ts");
      let capturedParams: Record<string, string | number | undefined> = {};
      const router = createRouter({
        "GET /item/:slug": (_req, params) => {
          capturedParams = params;
          return new Response("matched slug");
        },
      });
      const req = new Request("http://localhost/item/my-test-listing");
      const response = await router(req, "/item/my-test-listing", "GET");
      expect(response).not.toBeNull();
      expect(capturedParams.slug).toBe("my-test-listing");
      const text = await response!.text();
      expect(text).toBe("matched slug");
    });

    test("createRouter matches generic (non-id non-slug) param pattern", async () => {
      const { createRouter } = await import("#routes/router.ts");
      let capturedParams: Record<string, string | number | undefined> = {};
      const router = createRouter({
        "GET /file/:name": (_req, params) => {
          capturedParams = params;
          return new Response("matched generic");
        },
      });
      const req = new Request("http://localhost/file/my-file.txt");
      const response = await router(req, "/file/my-file.txt", "GET");
      expect(response).not.toBeNull();
      expect(capturedParams.name).toBe("my-file.txt");
      const text = await response!.text();
      expect(text).toBe("matched generic");
    });

    test("createRouter returns null for unmatched routes", async () => {
      const { createRouter } = await import("#routes/router.ts");
      const router = createRouter({
        "GET /known": () => new Response("ok"),
      });
      const req = new Request("http://localhost/unknown");
      const response = await router(req, "/unknown", "GET");
      expect(response).toBeNull();
    });
  });

  describe("routes/index.ts (routeMainApp null fallback)", () => {
    test("redirects legacy /events only when the public site is enabled", async () => {
      await settings.update.showPublicSite(true);
      const enabled = await handleRequest(mockRequest("/events"));
      expect(enabled.status).toBe(302);
      expect(enabled.headers.get("location")).toBe("/listings");

      await settings.update.showPublicSite(false);
      const disabled = await handleRequest(mockRequest("/events"));
      expect(disabled.status).toBe(404);
    });

    test("returns 404 when routeMainApp returns null for unmatched path", async () => {
      const response = await handleRequest(
        mockRequest("/completely-unknown-path-xyz-987"),
      );
      await expectHtmlResponse(response, 404, "Not Found");
    });
  });

  describe("routeMainApp fallback to notFoundResponse", () => {
    test("returns 404 for unknown path after setup", async () => {
      const response = await handleRequest(
        mockRequest("/this-path-definitely-does-not-exist-anywhere"),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("CDN/transient error handling", () => {
    test("temporaryErrorResponse returns 503 with styled HTML and auto-refresh", async () => {
      const response = temporaryErrorResponse();
      await expectHtmlResponse(
        response,
        503,
        "Temporary Error",
        "Retrying automatically",
        'http-equiv="refresh"',
      );
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
    });

    test("databaseBusyResponse(true) returns 503 styled HTML with auto-refresh", async () => {
      const response = databaseBusyResponse(true);
      await expectHtmlResponse(
        response,
        503,
        "The database is too busy.",
        "Reloading so you can try again.",
        'http-equiv="refresh"',
      );
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
    });

    test("databaseBusyResponse(false) omits auto-refresh for non-idempotent writes", async () => {
      const response = databaseBusyResponse(false);
      const html = await expectHtmlResponse(
        response,
        503,
        "The database is too busy.",
        "Please go back and try again",
      );
      expect(html).not.toContain('http-equiv="refresh"');
    });

    test("siteNotActivatedResponse returns 503 styled HTML without auto-refresh", async () => {
      const response = siteNotActivatedResponse();
      const html = await expectHtmlResponse(
        response,
        503,
        "This site has not been activated yet",
      );
      expect(html).not.toContain('http-equiv="refresh"');
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
    });

    test("migrationInProgressResponse returns 503 styled HTML with auto-refresh", async () => {
      const response = migrationInProgressResponse();
      const html = await expectHtmlResponse(
        response,
        503,
        "Update In Progress",
        "backing up and updating the database",
        'http-equiv="refresh"',
      );
      expect(html).not.toContain("Temporary Error");
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
    });

    test("serves the migration-in-progress page while a migration holds the lock", async () => {
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      const { invalidateInitDbCache, SCHEMA_HASH } = await import(
        "#shared/db/migrations.ts"
      );
      const db = getDbFn();
      // Stale schema hash makes initDb see a pending migration; a fresh lock
      // makes it believe another isolate is already running that migration.
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response()),
      );
      try {
        await db.execute(
          "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
        );
        await db.execute({
          args: ["migration_lock", new Date().toISOString()],
          sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        });
        invalidateInitDbCache();

        const response = await handleRequest(mockRequest("/"));

        const html = await expectHtmlResponse(
          response,
          503,
          "Update In Progress",
          'http-equiv="refresh"',
        );
        expect(html).not.toContain("Temporary Error");
      } finally {
        fetchStub.restore();
        await db.execute("DELETE FROM settings WHERE key = 'migration_lock'");
        await db.execute({
          args: [SCHEMA_HASH],
          sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
        });
        invalidateInitDbCache();
      }
    });

    test("rethrows unhandled errors in test mode", async () => {
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      const { invalidateListingsCache } = await import(
        "#shared/db/listings.ts"
      );
      const { settings: s } = await import("#shared/db/settings.ts");
      const db = getDbFn();
      invalidateListingsCache();
      await s.loadKeys(ALL_SETTINGS_KEYS);
      const hadExpectError = Deno.env.get("TEST_EXPECT_ERROR");
      Deno.env.delete("TEST_EXPECT_ERROR");
      const executeStub = stub(db, "execute", () => {
        throw new Error("synthetic db failure");
      });
      try {
        await expect(
          handleRequest(mockRequest("/ticket/nonexistent")),
        ).rejects.toThrow("synthetic db failure");
      } finally {
        executeStub.restore();
        if (hadExpectError) Deno.env.set("TEST_EXPECT_ERROR", hadExpectError);
      }
    });

    test("a DatabaseBusyError renders the busy page, not a generic error", async () => {
      const { getDb: getDbFn, DatabaseBusyError } = await import(
        "#shared/db/client.ts"
      );
      const executeStub = stub(getDbFn(), "execute", () => {
        throw new DatabaseBusyError();
      });
      try {
        const response = await handleRequest(mockRequest("/ticket/anything"));
        expect(response.status).toBe(503);
        const html = await response.text();
        expect(html).toContain("The database is too busy.");
        expect(html).toContain('http-equiv="refresh"');
      } finally {
        executeStub.restore();
      }
    });

    test("SessionKeyError clears cookie and redirects to /admin", async () => {
      await clearWrappedPrivateKey();

      await withExpectedError(async () => {
        const response = await handleRequest(
          mockRequest("/admin", { headers: { cookie: await testCookie() } }),
        );

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/admin");
        const setCookie = getHeader(response, "set-cookie");
        expect(setCookie).toContain("session=");
        expect(setCookie).toContain("Max-Age=0");
      });
    });
  });
});
