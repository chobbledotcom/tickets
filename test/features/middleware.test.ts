import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  applySecurityHeaders,
  buildCspHeader,
  contentTypeRejectionResponse,
  getCleanUrl,
  getSecurityHeaders,
  isEmbeddablePath,
  isJsonApiPath,
  isValidContentType,
  isWebhookPath,
} from "#routes/middleware.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const BASE_CSP =
  "default-src 'self'; img-src 'self' https://tile.openstreetmap.org; base-uri 'self'; object-src 'none'; form-action 'self'";

const requestWithType = (method: string, contentType?: string): Request =>
  new Request("http://localhost/test", {
    ...(contentType === undefined
      ? {}
      : { headers: { "content-type": contentType } }),
    method,
  });

describe("buildCspHeader", () => {
  test("defaults to the self-only resource policy", () => {
    expect(buildCspHeader(true)).toBe(BASE_CSP);
  });

  test("blocks framing for ordinary pages", () => {
    expect(buildCspHeader(false)).toBe(`frame-ancestors 'none'; ${BASE_CSP}`);
  });

  test("allows Botpoison's exact connection endpoint", () => {
    expect(buildCspHeader(true, undefined, true)).toBe(
      "default-src 'self'; img-src 'self' https://tile.openstreetmap.org; base-uri 'self'; object-src 'none'; connect-src 'self' https://api.botpoison.com; form-action 'self'",
    );
  });

  test("allows a baked CDN only for scripts and styles", () => {
    expect(
      buildCspHeader(false, undefined, false, "https://assets.example.com"),
    ).toBe(
      "frame-ancestors 'none'; default-src 'self'; img-src 'self' https://tile.openstreetmap.org; base-uri 'self'; object-src 'none'; script-src 'self' https://assets.example.com; style-src 'self' https://assets.example.com; form-action 'self'",
    );
  });

  test("allows Stripe's hosted checkout", () => {
    expect(buildCspHeader(true, { provider: "stripe" })).toContain(
      "form-action 'self' https://checkout.stripe.com",
    );
  });

  test("allows SumUp's hosted checkout domains", () => {
    expect(buildCspHeader(true, { provider: "sumup" })).toContain(
      "form-action 'self' https://checkout.sumup.com https://pay.sumup.com",
    );
  });

  test("uses Square production domains", () => {
    const csp = buildCspHeader(true, { provider: "square", sandbox: false });
    expect(csp).toContain("https://connect.squareup.com");
    expect(csp).toContain("https://api.squareup.com");
    expect(csp).not.toContain("squareupsandbox.com");
  });

  test("uses Square sandbox domains", () => {
    const csp = buildCspHeader(true, { provider: "square", sandbox: true });
    expect(csp).toContain("https://connect.squareupsandbox.com");
    expect(csp).toContain("https://api.squareupsandbox.com");
    expect(csp).not.toContain("https://connect.squareup.com");
  });
});

describe("JSON paths", () => {
  for (const path of ["/payment/webhook", "/sms/webhook"]) {
    test(`${path} is a webhook`, () => {
      expect(isWebhookPath(path)).toBe(true);
    });
  }

  test("near-miss webhook paths do not match", () => {
    expect(isWebhookPath("/payment/webhooks")).toBe(false);
    expect(isWebhookPath("/sms/webhooks")).toBe(false);
  });

  for (const path of [
    "/admin/listing/12/scan",
    "/api/listings",
    "/v1/devices/one",
  ]) {
    test(`${path} is a JSON API path`, () => {
      expect(isJsonApiPath(path)).toBe(true);
    });
  }

  test("near-miss API paths do not match", () => {
    expect(isJsonApiPath("/admin/listing/x/scan")).toBe(false);
    expect(isJsonApiPath("/apis/listings")).toBe(false);
    expect(isJsonApiPath("/v10/devices/one")).toBe(false);
  });
});

describe("isEmbeddablePath", () => {
  test("accepts one or more valid ticket slugs", () => {
    expect(isEmbeddablePath("/ticket/one")).toBe(true);
    expect(isEmbeddablePath("/ticket/one-two+three_4")).toBe(true);
  });

  test("rejects malformed ticket paths", () => {
    expect(isEmbeddablePath("/ticket/UPPERCASE")).toBe(false);
    expect(isEmbeddablePath("/ticket/two--hyphens")).toBe(false);
  });
});

describe("isValidContentType", () => {
  test("non-POST requests need no content type", () => {
    expect(isValidContentType(requestWithType("PATCH"), "/admin/login")).toBe(
      true,
    );
  });

  for (const path of ["/scheduled", "/instance/site-credentials"]) {
    test(`${path} accepts a bodyless POST`, () => {
      expect(isValidContentType(requestWithType("POST"), path)).toBe(true);
    });
  }

  for (const path of [
    "/payment/webhook",
    "/sms/webhook",
    "/admin/listing/12/scan",
    "/api/listings",
    "/v1/devices/one",
  ]) {
    test(`${path} accepts JSON case-insensitively`, () => {
      expect(
        isValidContentType(
          requestWithType("POST", "Application/JSON; charset=utf-8"),
          path,
        ),
      ).toBe(true);
    });
  }

  test("JSON endpoints reject another content type", () => {
    expect(
      isValidContentType(
        requestWithType("POST", "text/plain"),
        "/payment/webhook",
      ),
    ).toBe(false);
  });

  test("ordinary forms accept URL-encoded content", () => {
    expect(
      isValidContentType(
        requestWithType("POST", "application/x-www-form-urlencoded"),
        "/admin/login",
      ),
    ).toBe(true);
  });

  test("ordinary forms accept multipart content", () => {
    expect(
      isValidContentType(
        requestWithType("POST", "multipart/form-data; boundary=test"),
        "/admin/login",
      ),
    ).toBe(true);
  });

  test("ordinary forms reject missing content", () => {
    expect(isValidContentType(requestWithType("POST"), "/admin/login")).toBe(
      false,
    );
  });
});

test("contentTypeRejectionResponse is an exact secured plain-text 400", async () => {
  const response = contentTypeRejectionResponse();
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toBe("text/plain");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(await response.text()).toBe("Bad Request: Invalid Content-Type");
});

describe("getCleanUrl", () => {
  for (const parameter of [
    "fbclid",
    "gclid",
    "gad_source",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
  ]) {
    test(`strips ${parameter}`, () => {
      expect(
        getCleanUrl(
          new URL(`https://example.com/page?keep=yes&${parameter}=tracking`),
        ),
      ).toBe("/page?keep=yes");
    });
  }

  test("returns null when there is nothing to remove", () => {
    expect(
      getCleanUrl(new URL("https://example.com/page?keep=yes")),
    ).toBeNull();
  });
});

describe("getSecurityHeaders", () => {
  test("sets the exact base headers on ordinary pages", () => {
    expect(getSecurityHeaders(false)).toMatchObject({
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    });
  });

  test("allows indexing and framing on embeddable pages", () => {
    const headers = getSecurityHeaders(true);
    expect(headers["x-robots-tag"]).toBe("index, follow");
    expect(headers["x-frame-options"]).toBeUndefined();
  });

  test("sets HSTS only for a resolved production host", () => {
    setEffectiveDomainForTest("tickets.example.com");
    try {
      expect(getSecurityHeaders(false)["strict-transport-security"]).toBe(
        "max-age=63072000; includeSubDomains; preload",
      );
    } finally {
      resetEffectiveDomain();
    }
    expect(
      getSecurityHeaders(false)["strict-transport-security"],
    ).toBeUndefined();
  });
});

describeWithEnv("applySecurityHeaders", { db: true }, () => {
  test("turns the hidden-listing signal into the public noindex header", async () => {
    const response = await applySecurityHeaders(
      new Response("page", { headers: { "x-robots-noindex": "true" } }),
      true,
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.has("x-robots-noindex")).toBe(false);
  });

  test("prevents caching when the response has no explicit policy", async () => {
    const response = await applySecurityHeaders(new Response("page"), false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("preserves an explicit cache policy", async () => {
    const response = await applySecurityHeaders(
      new Response("asset", {
        headers: { "cache-control": "public, max-age=60" },
      }),
      false,
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("uses the configured Square sandbox policy", async () => {
    await settings.update.paymentProvider("square");
    await settings.update.square.sandbox(true);
    const response = await applySecurityHeaders(new Response("page"), false);
    expect(response.headers.get("content-security-policy")).toContain(
      "https://connect.squareupsandbox.com",
    );
  });

  test("adds configured frame ancestors only to embeddable pages", async () => {
    await settings.update.embedHosts("example.com");
    const response = await applySecurityHeaders(new Response("page"), true);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' example.com",
    );
  });
});
