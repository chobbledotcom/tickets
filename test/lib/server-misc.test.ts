import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { detectIframeMode } from "#lib/iframe.ts";
import { runWithRequestId } from "#lib/logger.ts";
import { getCleanUrl, handleRequest, isValidContentType } from "#routes";
import {
  redirect,
  redirectResponse,
  temporaryErrorResponse,
} from "#routes/utils.ts";
import {
  createTestDb,
  createTestEvent,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  getEmbeddableTicketResponse,
  getHeader,
  mockFormRequest,
  mockRequest,
  resetDb,
  testCookie,
  testCsrfToken,
  withExpectedError,
} from "#test-utils";
import { FormParams } from "#lib/form-data.ts";

describeWithEnv("server (misc)", { db: true }, () => {
  /** Create an embeddable test event and return its ticket page response */
  const getTicketPageResponse = getEmbeddableTicketResponse;

  /** Create two embeddable test events and return the multi-slug ticket page response */
  async function getMultiSlugTicketPageResponse(): Promise<Response> {
    const event1 = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const event2 = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    return handleRequest(mockRequest(`/ticket/${event1.slug}+${event2.slug}`));
  }

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
      const baseCsp = "default-src 'self'; form-action 'self'";

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
      const event = await createTestEvent({
        maxAttendees: 50,
        name: "My Test Event",
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("routes/utils.ts (getPrivateKey)", () => {
    test("returns null when wrappedDataKey is null", async () => {
      const { getPrivateKey } = await import("#routes/utils.ts");
      const result = await getPrivateKey({
        token: "any-token",
        wrappedDataKey: null,
      });
      expect(result).toBeNull();
    });

    test("returns null when wrappedPrivateKey is not set in DB", async () => {
      const { getDb: getDbFn } = await import("#lib/db/client.ts");
      const { settings: s } = await import("#lib/db/settings.ts");
      await getDbFn().execute({
        args: [],
        sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
      });
      s.invalidateCache();

      const { getPrivateKey } = await import("#routes/utils.ts");
      const result = await getPrivateKey({
        token: "any-token",
        wrappedDataKey: "some-wrapped-key",
      });
      expect(result).toBeNull();
    });

    test("returns null when crypto operation throws", async () => {
      const { getPrivateKey } = await import("#routes/utils.ts");
      const result = await getPrivateKey({
        token: "any-token",
        wrappedDataKey: "corrupt-key-data",
      });
      expect(result).toBeNull();
    });
  });

  describe("routes/utils.ts (redirect)", () => {
    /** Run callback inside a request context so getRequestId() returns a value */
    const withRequestContext = <T>(fn: () => T): T => runWithRequestId(fn);

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
          "/admin/event/1?tab=attendees",
          "Updated",
          true,
        );
        expectRedirectWithFlash(
          "/admin/event/1?tab=attendees",
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
        const response = redirect("/admin/event/1", "A & B", true);
        expectRedirectWithFlash("/admin/event/1", "A & B")(response);
      }));

    test("uses request ID as flash key in redirect URL", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Saved", true);
        const location = expectRedirect(response);
        const url = new URL(location, "http://localhost");
        const flashId = url.searchParams.get("flash");
        expect(flashId).toBeDefined();
        expect(flashId!.length).toBe(4);
      }));

    test("keys flash cookie by the flash ID in the URL", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Saved", true);
        const location = expectRedirect(response);
        const url = new URL(location, "http://localhost");
        const flashId = url.searchParams.get("flash")!;
        const cookies = response.headers.getSetCookie();
        const flashCookie = cookies.find((c) =>
          c.startsWith(`flash_${flashId}=`),
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

  describe("routes/admin/utils.ts (requirePrivateKey)", () => {
    test("throws SessionKeyError when private key is unavailable", async () => {
      const { requirePrivateKey } = await import("#routes/admin/utils.ts");
      const { SessionKeyError } = await import("#routes/utils.ts");
      const session = {
        token: "any-token",
        wrappedDataKey: null,
      } as Parameters<typeof requirePrivateKey>[0];
      await expect(requirePrivateKey(session)).rejects.toThrow(SessionKeyError);
    });
  });

  describe("routes/admin/utils.ts (helper factories)", () => {
    test("withEntityLoader returns handler response when entity exists", async () => {
      const { withEntityLoader } = await import("#routes/admin/utils.ts");

      const response = await withEntityLoader((id: number) =>
        Promise.resolve(id === 7 ? { id, name: "Loaded" } : null),
      )(7)((entity) => new Response(`entity:${entity.name}`));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("entity:Loaded");
    });

    test("withEntityFromParam returns 404 for invalid ids", async () => {
      const { withEntityFromParam } = await import("#routes/admin/utils.ts");

      const response = await withEntityFromParam(
        "not-a-number",
        () => Promise.resolve({ id: 1 }),
        () => new Response("ok"),
      );

      expect(response.status).toBe(404);
    });

    test("withSessionAndEntity loads entity after session auth", async () => {
      const { withSessionAndEntity } = await import("#routes/admin/utils.ts");
      const cookie = await testCookie();

      const response = await withSessionAndEntity((session, id) =>
        Promise.resolve({
          id,
          userId: session.userId,
        }),
      )(
        mockRequest("/admin/attendees/1", { headers: { cookie } }),
        123,
      )((request, _session, entity) => {
        const path = new URL(request.url).pathname;
        return new Response(`${path}:${entity.id}:${entity.userId}`);
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("/admin/attendees/1:123:1");
    });

    test("withAuthAndEntity handles form auth then loads entity", async () => {
      const { withAuthAndEntity } = await import("#routes/admin/utils.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await withAuthAndEntity((_session, id) =>
        Promise.resolve({
          id,
        }),
      )(
        mockFormRequest(
          "/admin/attendees/1",
          { csrf_token: csrfToken, value: "ok" },
          cookie,
        ),
        88,
      )((_session, form, entity) =>
        new Response(`${entity.id}:${form.getString("value")}`),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("88:ok");
    });

    test("createEntityRouteHandlers wires GET and POST flows", async () => {
      const { createEntityRouteHandlers } = await import("#routes/admin/utils.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handlers = createEntityRouteHandlers(
        (_session, id) => Promise.resolve({ id }),
        (params: { attendeeId: number }) => params.attendeeId,
      );

      const getResponse = await handlers.get((_request, _session, entity) =>
        new Response(`get:${entity.id}`),
      )(mockRequest("/admin/attendees/15", { headers: { cookie } }), {
        attendeeId: 15,
      });
      expect(await getResponse.text()).toBe("get:15");

      const postResponse = await handlers.post((_session, form, entity) =>
        new Response(`post:${entity.id}:${form.getString("name")}`),
      )(
        mockFormRequest(
          "/admin/attendees/16",
          { csrf_token: csrfToken, name: "x" },
          cookie,
        ),
        { attendeeId: 16 },
      );
      expect(await postResponse.text()).toBe("post:16:x");
    });

    test("createActionHandler supports custom error mapping", async () => {
      const { createActionHandler } = await import("#routes/admin/utils.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        execute: () => Promise.reject(new Error("kaboom")),
        message: "unused",
        onError: (error) => new Response(`mapped:${error.message}`, { status: 418 }),
        successRedirect: "/admin/attendees/1",
      });

      const response = await handler(
        mockFormRequest("/admin/attendees/1", { csrf_token: csrfToken }, cookie),
      );

      expect(response.status).toBe(418);
      expect(await response.text()).toBe("mapped:kaboom");
    });
  });

  describe("routes/utils.ts (CSRF token validation)", () => {
    test("empty csrf_token from form falls back to empty string", async () => {
      // Send form without csrf_token field at all
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
        const url = new URL("http://localhost/ticket/my-event");
        expect(getCleanUrl(url)).toBeNull();
      });

      test("returns null when URL has only non-tracking params", () => {
        const url = new URL("http://localhost/ticket/my-event?iframe=true");
        expect(getCleanUrl(url)).toBeNull();
      });

      test("strips fbclid parameter", () => {
        const url = new URL("http://localhost/ticket/my-event?fbclid=abc123");
        expect(getCleanUrl(url)).toBe("/ticket/my-event");
      });

      test("strips fbclid but preserves other params", () => {
        const url = new URL(
          "http://localhost/ticket/my-event?iframe=true&fbclid=abc123",
        );
        expect(getCleanUrl(url)).toBe("/ticket/my-event?iframe=true");
      });

      test("strips utm parameters", () => {
        const url = new URL(
          "http://localhost/ticket/my-event?utm_source=facebook&utm_medium=social",
        );
        expect(getCleanUrl(url)).toBe("/ticket/my-event");
      });

      test("strips gclid parameter", () => {
        const url = new URL("http://localhost/ticket/my-event?gclid=xyz789");
        expect(getCleanUrl(url)).toBe("/ticket/my-event");
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
          mockRequest("/ticket/my-event?fbclid=IwdGRjcAQFOkpleHRuA2FlbQ"),
        );
        expect(response.status).toBe(301);
        expect(response.headers.get("location")).toBe("/ticket/my-event");
      });

      test("redirects GET requests preserving non-tracking params", async () => {
        const response = await handleRequest(
          mockRequest("/ticket/my-event?iframe=true&fbclid=abc123"),
        );
        expect(response.status).toBe(301);
        expect(response.headers.get("location")).toBe(
          "/ticket/my-event?iframe=true",
        );
      });

      test("does not redirect POST requests with tracking params", async () => {
        const event = await createTestEvent({
          maxAttendees: 50,
        });
        const response = await handleRequest(
          mockFormRequest(`/ticket/${event.slug}?fbclid=abc123`, {
            name: "Test",
          }),
        );
        expect(response.status).not.toBe(301);
      });

      test("does not redirect GET requests without tracking params", async () => {
        const event = await createTestEvent({
          maxAttendees: 50,
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.status).toBe(200);
      });
    });
  });

  describe("routes/router.ts (param patterns)", () => {
    test("matches slug pattern with lowercase alphanumeric and hyphens", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        name: "My Test Event",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
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
      const req = new Request("http://localhost/item/my-test-event");
      const response = await router(req, "/item/my-test-event", "GET");
      expect(response).not.toBeNull();
      expect(capturedParams.slug).toBe("my-test-event");
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
    test("returns 404 when routeMainApp returns null for unmatched path", async () => {
      // A path that doesn't match any registered route
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

    test("rethrows unhandled errors in test mode", async () => {
      const { getDb: getDbFn } = await import("#lib/db/client.ts");
      const { invalidateEventsCache } = await import("#lib/db/events.ts");
      const { settings: s } = await import("#lib/db/settings.ts");
      const db = getDbFn();
      invalidateEventsCache();
      // Warm the settings cache so loadEffectiveDomain/isSetupComplete/etc.
      // resolve from cache; the stub then only affects route-handler queries
      // inside the inner try/catch.
      await s.loadAll();
      // Ensure TEST_EXPECT_ERROR is not set (concurrent tests may set it),
      // otherwise handleRequest swallows the error instead of rethrowing.
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

    test("SessionKeyError clears cookie and redirects to /admin", async () => {
      const { getDb: getDbFn } = await import("#lib/db/client.ts");
      const { settings: s } = await import("#lib/db/settings.ts");

      // Remove wrapped_private_key so requirePrivateKey throws SessionKeyError
      await getDbFn().execute({
        args: [],
        sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
      });
      s.invalidateCache();

      await withExpectedError(async () => {
        // Hit admin dashboard (GET /admin with session) which calls requirePrivateKey
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

  describe("routes/admin/utils.ts", () => {
    test("verifyIdentifier matches case-insensitive trimmed strings", async () => {
      const { verifyIdentifier } = await import("#routes/admin/utils.ts");

      expect(verifyIdentifier("Test Event", "test event")).toBe(true);
      expect(verifyIdentifier("  Test  ", "test")).toBe(true);
      expect(verifyIdentifier("Test", "Other")).toBe(false);
    });

    test("verifyOrRedirect returns null on match", async () => {
      const { verifyOrRedirect } = await import("#routes/admin/utils.ts");

      const form = new FormParams({ confirm_identifier: "Test Event" });
      const result = verifyOrRedirect(form, "Test Event", "/admin/test");
      expect(result).toBeNull();
    });

    test("verifyOrRedirect returns error redirect on mismatch without action", async () => {
      const { verifyOrRedirect } = await import("#routes/admin/utils.ts");

      const form = new FormParams({ confirm_identifier: "Wrong" });
      const result = verifyOrRedirect(form, "Test Event", "/admin/test");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(302);
      const location = result!.headers.get("location");
      expect(location).toContain("/admin/test");
    });

    test("verifyOrRedirect returns error redirect with action label", async () => {
      const { verifyOrRedirect } = await import("#routes/admin/utils.ts");

      const form = new FormParams({ confirm_identifier: "Wrong" });
      const result = verifyOrRedirect(
        form,
        "Test Event",
        "/admin/test",
        "Event name",
        "deletion",
      );
      expect(result).not.toBeNull();
      expectFlash(result!, "Event name does not match. Please type the exact event name to confirm deletion.", false);
    });

    test("verifyIdentifierOrJsonError returns null on match", async () => {
      const { verifyIdentifierOrJsonError } = await import(
        "#routes/admin/utils.ts"
      );

      expect(
        verifyIdentifierOrJsonError("Test Event", "Test Event"),
      ).toBeNull();
    });

    test("verifyIdentifierOrJsonError returns error on mismatch", async () => {
      const { verifyIdentifierOrJsonError } = await import(
        "#routes/admin/utils.ts"
      );

      const error = verifyIdentifierOrJsonError(
        "Test Event",
        "Wrong",
        "Event name",
      );
      expect(error).toContain("does not match");
      expect(error).toContain("confirm_identifier");
    });

    test("verifyIdentifierOrJsonError handles non-string input", async () => {
      const { verifyIdentifierOrJsonError } = await import(
        "#routes/admin/utils.ts"
      );

      const error = verifyIdentifierOrJsonError("Test", null);
      expect(error).not.toBeNull();
    });

    test("getDateFilter returns valid date", async () => {
      const { getDateFilter } = await import("#routes/admin/utils.ts");

      const request = mockRequest("/test?date=2024-01-15");
      expect(getDateFilter(request)).toBe("2024-01-15");
    });

    test("getDateFilter returns null for invalid format", async () => {
      const { getDateFilter } = await import("#routes/admin/utils.ts");

      expect(getDateFilter(mockRequest("/test?date=01-15-2024"))).toBeNull();
      expect(getDateFilter(mockRequest("/test?date=2024/01/15"))).toBeNull();
      expect(getDateFilter(mockRequest("/test?date=not-a-date"))).toBeNull();
    });

    test("getDateFilter returns null when absent", async () => {
      const { getDateFilter } = await import("#routes/admin/utils.ts");

      expect(getDateFilter(mockRequest("/test"))).toBeNull();
      expect(getDateFilter(mockRequest("/test?date="))).toBeNull();
    });

    test("csvResponse returns proper CSV response", async () => {
      const { csvResponse } = await import("#routes/admin/utils.ts");

      const response = csvResponse("name,email\nJohn,john@test.com", "test.csv");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/csv; charset=utf-8",
      );
      expect(response.headers.get("content-disposition")).toContain(
        'filename="test.csv"',
      );
      const body = await response.text();
      expect(body).toBe("name,email\nJohn,john@test.com");
    });

    test("loadQuestionData returns undefined for empty attendeeIds", async () => {
      const { loadQuestionData } = await import("#routes/admin/utils.ts");

      expect(await loadQuestionData([1, 2], [])).toBeUndefined();
    });

    test("loadQuestionData returns undefined for empty eventIds", async () => {
      const { loadQuestionData } = await import("#routes/admin/utils.ts");

      expect(await loadQuestionData([], [1, 2])).toBeUndefined();
    });

    test("loadQuestionData returns undefined when no questions exist", async () => {
      const { loadQuestionData } = await import("#routes/admin/utils.ts");
      const { createTestAttendeeDirect } = await import("#test-utils");

      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        event.id,
        "Test",
        "test@test.com",
      );

      const result = await loadQuestionData([event.id], [attendee.id]);
      expect(result).toBeUndefined();
    });
  });
});
