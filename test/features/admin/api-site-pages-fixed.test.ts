// Contract tests for the site-pages JSON API's fixed pages (home, contact
// and terms) and the role parity the pages declare. Technical surface —
// direct Deno tests (E2E_TESTS.md).
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  createTestEditorSession,
  createTestManagerSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv("Admin API - Site pages fixed pages", { db: true }, () => {
  describe("fixed pages", () => {
    test("reads the homepage's name and content", async () => {
      await settings.update.homepageText("Walks from the square.");
      await assertJson(
        apiRequest("/api/admin/site-pages/home"),
        200,
        (body) => {
          expect(body.page.name).toBe("home");
          expect(body.page.content).toBe("Walks from the square.");
          expect(body.page.id).toBeUndefined();
          expect(body.page.slug).toBeUndefined();
          expect(body.page.hidden).toBeUndefined();
        },
      );
    });

    test("updates the homepage's text and logs the form's line", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: "New homepage text" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.page.content).toBe("New homepage text");
        },
      );
      expect(settings.homepageText).toBe("New homepage text");
      expect(await wasActivityLogged("Homepage updated")).toBe(true);
    });

    test("updates the contact page's text and logs the form's line", async () => {
      await apiRequest("/api/admin/site-pages/contact", {
        body: { content: "Call the hut." },
        method: "PUT",
      });
      expect(settings.contactPageText).toBe("Call the hut.");
      expect(await wasActivityLogged("Contact page updated")).toBe(true);
    });

    test("reads and updates the terms, logging the form's lines", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/terms"),
        200,
        (body) => {
          expect(body.page.name).toBe("terms");
        },
      );
      await apiRequest("/api/admin/site-pages/terms", {
        body: { content: "Bookings are non-refundable." },
        method: "PUT",
      });
      expect(settings.terms).toBe("Bookings are non-refundable.");
      expect(await wasActivityLogged("Terms and conditions updated")).toBe(
        true,
      );
      await apiRequest("/api/admin/site-pages/terms", {
        body: { content: "" },
        method: "PUT",
      });
      expect(await wasActivityLogged("Terms and conditions removed")).toBe(
        true,
      );
    });

    test("refuses a fixed page with no content in the body", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", { method: "PUT" }),
        400,
        (body) => {
          expect(body.error).toBe("content is required");
        },
      );
    });

    test("refuses a non-string content with the field message", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: 42 },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("content must be a string");
        },
      );
    });

    test("refuses the Hidden flag on a fixed page", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: "text", hidden: true },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("A fixed page cannot be hidden.");
        },
      );
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: "text", hidden: false },
          method: "PUT",
        }),
        400,
      );
    });

    test("refuses to create or delete a fixed page", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", { method: "POST" }),
        400,
        (body) => {
          expect(body.error).toBe("Fixed pages cannot be created.");
        },
      );
      await assertJson(
        apiRequest("/api/admin/site-pages/home", { method: "DELETE" }),
        400,
        (body) => {
          expect(body.error).toBe("Fixed pages cannot be deleted.");
        },
      );
    });

    test("answers 401 without auth on the fixed routes", async () => {
      expect(
        (await handleRequest(mockRequest("/api/admin/site-pages/home"))).status,
      ).toBe(401);
    });
  });

  describe("role parity with the pages", () => {
    test("an editor manages content pages, home and contact, but not terms", async () => {
      const { cookie } = await createTestEditorSession();
      const csrfToken = await testCsrfToken();
      const asEditor = (
        path: string,
        method: string,
        body?: Record<string, unknown>,
      ): Promise<Response> =>
        handleRequest(
          requestAsSession(
            path,
            { cookie, csrfToken },
            {
              ...(body === undefined
                ? {}
                : {
                    body: JSON.stringify(body),
                    headers: { "content-type": "application/json" },
                  }),
              method,
            },
          ),
        );

      // Content pages: read, write, create.
      const page = await createTestSitePage("visit", { name: "Visit" });
      expect((await asEditor("/api/admin/site-pages", "GET")).status).toBe(200);
      expect(
        (
          await asEditor(`/api/admin/site-pages/${page.id}`, "PUT", {
            content: "Editor text",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await asEditor("/api/admin/site-pages", "POST", {
            name: "Editor page",
            slug: "editor-page",
          })
        ).status,
      ).toBe(201);

      // Home and contact read and write.
      expect((await asEditor("/api/admin/site-pages/home", "GET")).status).toBe(
        200,
      );
      expect(
        (
          await asEditor("/api/admin/site-pages/home", "PUT", {
            content: "Editor homepage",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await asEditor("/api/admin/site-pages/contact", "PUT", {
            content: "Editor contact",
          })
        ).status,
      ).toBe(200);

      // Terms are owner-only, the same audience the terms editor declares.
      expect(
        (await asEditor("/api/admin/site-pages/terms", "GET")).status,
      ).toBe(403);
      expect(
        (
          await asEditor("/api/admin/site-pages/terms", "PUT", {
            content: "Editor terms",
          })
        ).status,
      ).toBe(403);
    });

    test("a manager is refused everywhere, the same as the pages", async () => {
      const managerCookie = await createTestManagerSession();
      const csrfToken = await testCsrfToken();
      const asManager = (path: string): Promise<Response> =>
        handleRequest(
          requestAsSession(path, { cookie: managerCookie, csrfToken }),
        );
      expect((await asManager("/api/admin/site-pages")).status).toBe(403);
      expect((await asManager("/api/admin/site-pages/home")).status).toBe(403);
      expect((await asManager("/api/admin/site-pages/terms")).status).toBe(403);
    });
  });
});
