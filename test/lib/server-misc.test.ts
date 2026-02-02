import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { handleRequest } from "#routes";
import {
  createTestDb,
  createTestDbWithSetup,
  createTestEvent,
  loginAsAdmin,
  mockFormRequest,
  mockRequest,
  mockRequestWithHost,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("server (misc)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

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
        const event = await createTestEvent({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
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
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self' https://checkout.stripe.com";

      test("non-embeddable pages have frame-ancestors 'none' and security restrictions", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("content-security-policy")).toBe(
          `frame-ancestors 'none'; ${baseCsp}`,
        );
      });

      test("ticket page has CSP but allows embedding (no frame-ancestors)", async () => {
        const event = await createTestEvent({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("content-security-policy")).toBe(baseCsp);
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

      test("ticket pages also have base security headers", async () => {
        const event = await createTestEvent({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      });
    });
  });

  describe("Content-Type validation", () => {
    test("rejects POST requests without Content-Type header", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });

    test("rejects POST requests with wrong Content-Type", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "test" }),
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });
  });

  describe("routes/middleware.ts (empty content-type)", () => {
    test("POST with empty content-type is rejected", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });
  });

  describe("routes/router.ts (slug and generic param patterns)", () => {
    test("slug pattern matches lowercase alphanumeric with hyphens", async () => {
      const event = await createTestEvent({
        name: "My Test Event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
      expect(response.status).toBe(200);
    });
  });

  describe("routes/utils.ts (getPrivateKey)", () => {
    test("returns null when wrappedDataKey is null", async () => {
      const { getPrivateKey } = await import("#routes/utils.ts");
      const result = await getPrivateKey("any-token", null);
      expect(result).toBeNull();
    });

    test("returns null when wrappedPrivateKey is not set in DB", async () => {
      const { getDb: getDbFn } = await import("#lib/db/client.ts");
      await getDbFn().execute({
        sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
        args: [],
      });

      const { getPrivateKey } = await import("#routes/utils.ts");
      const result = await getPrivateKey("any-token", "some-wrapped-key");
      expect(result).toBeNull();
    });

    test("returns null when crypto operation throws", async () => {
      const { getPrivateKey } = await import("#routes/utils.ts");
      const result = await getPrivateKey("any-token", "corrupt-key-data");
      expect(result).toBeNull();
    });
  });

  describe("routes/utils.ts (CSRF token validation)", () => {
    test("empty csrf_token from form falls back to empty string", async () => {
      const { cookie } = await loginAsAdmin();

      // Send form without csrf_token field at all
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          { current_password: "test" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });
  });

  describe("Domain validation", () => {
    test("allows requests with valid domain", async () => {
      const response = await handleRequest(mockRequest("/"));
      expect(response.status).toBe(302); // Homepage redirects to /admin/
    });

    test("rejects GET requests to invalid domain", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "evil.com"),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("rejects POST requests to invalid domain", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/admin/login", "evil.com", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("allows requests with valid domain including port", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "localhost:3000"),
      );
      expect(response.status).toBe(302); // Homepage redirects to /admin/
    });

    test("rejects requests without Host header", async () => {
      const response = await handleRequest(
        new Request("http://localhost/", {}),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("domain rejection response has security headers", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "evil.com"),
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });
  });

  describe("routes/router.ts (param patterns)", () => {
    test("matches slug pattern with lowercase alphanumeric and hyphens", async () => {
      const event = await createTestEvent({
        name: "My Test Event",
        maxAttendees: 50,
      });
      const response = await handleRequest(mockRequest(`/ticket/${event.slug}`));
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
      let capturedParams: Record<string, string | undefined> = {};
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
      let capturedParams: Record<string, string | undefined> = {};
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
      const response = await handleRequest(mockRequest("/completely-unknown-path-xyz-987"));
      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toContain("Not Found");
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

});
