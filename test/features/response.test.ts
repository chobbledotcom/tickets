// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  databaseBusyResponse,
  migrationInProgressResponse,
  redirect,
  redirectResponse,
  siteNotActivatedResponse,
  temporaryErrorResponse,
  withCookie,
} from "#routes/response.ts";
import { detectIframeMode, runWithIframeContext } from "#shared/iframe.ts";
import { runWithRequestId } from "#shared/logger.ts";
import {
  expectHtmlResponse,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

describeWithEnv("route responses", { db: true }, () => {
  describe("withCookie", () => {
    test("adds a cookie to a response without existing cookies", async () => {
      const response = new Response("body", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });

    test("preserves existing set-cookie headers when adding another", async () => {
      const headers = new Headers();
      headers.append("set-cookie", "first=one; Path=/");
      const response = new Response("body", { headers, status: 200 });
      const result = await withCookie(response, "second=two; Path=/");
      const cookies = result.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      expect(cookies).toContain("first=one; Path=/");
      expect(cookies).toContain("second=two; Path=/");
    });

    test("preserves response status", async () => {
      const response = new Response("body", { status: 201 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(201);
    });

    test("preserves text response body", async () => {
      const response = new Response("hello world", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(await result.text()).toBe("hello world");
    });

    test("preserves binary response body", async () => {
      const bytes = new Uint8Array([0, 1, 2, 128, 255]);
      const response = new Response(bytes, { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      const body = new Uint8Array(await result.arrayBuffer());
      expect(body.length).toBe(5);
      expect(body[0]).toBe(0);
      expect(body[3]).toBe(128);
      expect(body[4]).toBe(255);
    });

    test("handles null body response", async () => {
      const response = new Response(null, { status: 204 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(204);
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });
  });

  describe("redirect", () => {
    const withRequestContext = <T>(fn: () => T): Promise<T> =>
      runWithRequestId(async () => fn());

    test("stores a success message without adding it to the URL", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Saved", true);
        expectRedirectWithFlash("/admin/settings", "Saved")(response);
        expect(response.headers.get("location")).not.toContain("success=");
      }));

    test("targets a form while preserving its anchor", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Updated", true, {
          formId: "settings&email",
        });
        expectRedirectWithFlash(
          "/admin/settings?form=settings%26email#settings&email",
          "Updated",
        )(response);
      }));

    test("preserves an existing query and fragment", () =>
      withRequestContext(() => {
        const response = redirect(
          "/admin/listing/1?tab=attendees#notes",
          "Updated",
          true,
        );
        expectRedirectWithFlash(
          "/admin/listing/1?tab=attendees#notes",
          "Updated",
        )(response);
      }));

    test("stores an error flash", () =>
      withRequestContext(() => {
        const response = redirect("/admin/settings", "Failed", false);
        expectRedirectWithFlash("/admin/settings", "Failed", false)(response);
      }));

    test("keeps a caller-provided cookie beside the flash cookie", () =>
      withRequestContext(() => {
        const response = redirect("/admin", "Done", true, {
          cookie: "session=abc; Path=/",
        });
        expect(response.headers.getSetCookie()).toContain(
          "session=abc; Path=/",
        );
        expectRedirectWithFlash("/admin", "Done")(response);
      }));
  });

  describe("redirectResponse", () => {
    test("creates a 302 response with the requested location and cookie", () => {
      const response = redirectResponse("/ticket/test", "session=abc; Path=/");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/ticket/test");
      expect(response.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });

    test("carries iframe mode into the redirect location", () =>
      runWithIframeContext(() => {
        detectIframeMode(new URL("https://example.com/?iframe=true"));
        const response = redirectResponse("/ticket/reserved?tokens=abc");
        expect(response.headers.get("location")).toBe(
          "/ticket/reserved?tokens=abc&iframe=true",
        );
      }));

    test("leaves the location alone outside iframe mode", () =>
      runWithIframeContext(() => {
        const response = redirectResponse("/ticket/test");
        expect(response.headers.get("location")).toBe("/ticket/test");
      }));
  });

  describe("system responses", () => {
    test("renders a temporary error that reloads", async () => {
      const response = temporaryErrorResponse();
      await expectHtmlResponse(
        response,
        503,
        "Temporary Error",
        "Retrying automatically",
        'http-equiv="refresh"',
      );
    });

    test("reloads a busy database page only for a safe request", async () => {
      const retry = await expectHtmlResponse(
        databaseBusyResponse(true),
        503,
        "The database is too busy.",
        'http-equiv="refresh"',
      );
      const noRetry = await expectHtmlResponse(
        databaseBusyResponse(false),
        503,
        "Please go back and try again",
      );
      expect(retry).toContain('http-equiv="refresh"');
      expect(noRetry).not.toContain('http-equiv="refresh"');
    });

    test("renders the not-activated page without reloading", async () => {
      const html = await expectHtmlResponse(
        siteNotActivatedResponse(),
        503,
        "This site has not been activated yet",
      );
      expect(html).not.toContain('http-equiv="refresh"');
    });

    test("renders the migration page with reloading", async () => {
      const html = await expectHtmlResponse(
        migrationInProgressResponse(),
        503,
        "Update In Progress",
        "backing up and updating the database",
        'http-equiv="refresh"',
      );
      expect(html).not.toContain("Temporary Error");
    });
  });
});
