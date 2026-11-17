// Contract tests for the site-pages admin JSON API: the content-page CRUD
// (site_pages rows, addressed by id) and the refusals it carries. The input
// mapping's field refusals live in api-site-pages-input.test.ts. Technical
// surface — direct Deno tests (docs/e2e-tests.md); the form-side parity pins live
// in test/features/admin/parity/site-pages.test.ts.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addPageItem, getAllPageItems } from "#db/site-page-items.ts";
import { getSitePageById } from "#db/site-pages.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { writeUpdate } from "#routes/admin/api-site-pages.ts";
import { publicNavModel } from "#routes/public/site-nav.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import {
  assertApiDeleteOk,
  assertJson,
  expectApiError,
} from "#test-utils/assertions.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { describeWithSitePages as describeWithEnv } from "#test-utils/feature-suites.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import {
  apiRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import type { SitePage } from "#types";

describeWithEnv("Admin API - Site pages", { db: true }, () => {
  /** Load the stored row for `pageId` and check every field `expected` names,
   *  so a write test proves what reached the table, not only what the API
   *  echoed back. */
  const expectStoredPage = async (
    pageId: number,
    expected: Partial<SitePage>,
  ): Promise<void> => {
    const stored = await getSitePageById(pageId);
    if (stored === null) throw new Error(`Site page ${pageId} is not stored`);
    expect(stored).toMatchObject(expected);
  };

  /** PUT `body` to one page's update endpoint and assert the API refuses it
   *  with the form's own message for that refusal. */
  const expectUpdateRefused = (
    pageId: number,
    body: Record<string, unknown>,
    message: string,
  ): Promise<unknown> =>
    expectApiError(
      apiRequest(`/api/admin/site-pages/${pageId}`, { body, method: "PUT" }),
      400,
      message,
    );

  /** One page nested under another, the pair the parent pins use. */
  const nestedPages = async () => {
    const parent = await createTestSitePage("visit", { name: "Visit" });
    const child = await createTestSitePage("extras", { name: "Extras" });
    await addPageItem(parent.id, "page", child.id);
    return { child, parent };
  };

  /** Put a page under `parentId` and check the API answers with that
   *  parent. */
  const putPageUnder = async (
    pageId: number,
    parentId: number,
  ): Promise<void> => {
    await assertJson(
      apiRequest(`/api/admin/site-pages/${pageId}`, {
        body: { parent: parentId },
        method: "PUT",
      }),
      200,
      (body) => {
        expect(body.page.parent).toBe(parentId);
      },
    );
  };

  describe("GET /api/admin/site-pages", () => {
    test("lists content pages with their parent page", async () => {
      const { child, parent } = await nestedPages();

      await assertJson(apiRequest("/api/admin/site-pages"), 200, (body) => {
        const rows = body["site-pages"] as Array<{
          id: number;
          name: string;
          parent: number | null;
          slug: string;
        }>;
        const childRow = rows.find((row) => row.id === child.id);
        const parentRow = rows.find((row) => row.id === parent.id);
        expect(childRow?.parent).toBe(parent.id);
        expect(parentRow?.parent).toBeNull();
      });
    });

    test("answers 401 without auth", async () => {
      const response = await handleRequest(
        mockRequest("/api/admin/site-pages"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/site-pages/:pageId", () => {
    test("returns one page with every stored field", async () => {
      const page = await createTestSitePage("visit", {
        content: "Walks and talks.",
        hidden: true,
        metaDescription: "Before you come",
        metaTitle: "Visit",
        name: "Visit",
      });

      await assertJson(
        apiRequest(`/api/admin/site-pages/${page.id}`),
        200,
        (body) => {
          expect(body.page.id).toBe(page.id);
          expect(body.page.name).toBe("Visit");
          expect(body.page.slug).toBe("visit");
          expect(body.page.hidden).toBe(true);
          expect(body.page.content).toBe("Walks and talks.");
          expect(body.page.meta_title).toBe("Visit");
          expect(body.page.meta_description).toBe("Before you come");
          expect(body.page.parent).toBeNull();
          // The slug HMAC never leaves the server.
          expect(Object.hasOwn(body.page, "slug_index")).toBe(false);
        },
      );
    });

    test("answers 404 for an unknown page", async () => {
      await expectApiError(
        apiRequest("/api/admin/site-pages/99999"),
        404,
        "Page not found",
      );
    });

    test("works with cookie+CSRF auth", async () => {
      const page = await createTestSitePage("cookie-page");
      await assertJson(
        handleRequest(
          requestAsSession(`/api/admin/site-pages/${page.id}`, {
            cookie: await testCookie(),
            csrfToken: await testCsrfToken(),
          }),
        ),
        200,
        (body) => {
          expect(body.page.slug).toBe("cookie-page");
        },
      );
    });
  });

  describe("POST /api/admin/site-pages", () => {
    test("creates a page with the posted fields", async () => {
      const posted = {
        content: "Pack light.",
        hidden: true,
        meta_description: "Before you come",
        meta_title: "Plan",
        name: "Plan your weekend",
        slug: "plan-your-weekend",
      };
      const body = await assertJson(
        apiRequest("/api/admin/site-pages", { body: posted, method: "POST" }),
        201,
        (echoed) => {
          expect(echoed.page).toMatchObject(posted);
          expect(echoed.page.parent).toBeNull();
        },
      );
      await expectStoredPage(body.page.id, {
        hidden: true,
        meta_description: "Before you come",
        meta_title: "Plan",
      });
      expect(await wasActivityLogged("Page 'Plan your weekend' created")).toBe(
        true,
      );
    });

    test("defaults a silent body to a visible page with empty meta", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages", {
          body: { name: "Bare", slug: "bare" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.page.hidden).toBe(false);
          expect(body.page.content).toBe("");
          expect(body.page.meta_title).toBe("");
        },
      );
    });

    test("stores a slug at the form's length cap", async () => {
      const slug = "a".repeat(250);
      await assertJson(
        apiRequest("/api/admin/site-pages", {
          body: { name: "Capped slug", slug },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.page.slug).toBe(slug);
        },
      );
    });
  });

  describe("PUT /api/admin/site-pages/:pageId", () => {
    test("updates the supplied fields and keeps the rest", async () => {
      const page = await createTestSitePage("visit", {
        content: "Old text",
        metaTitle: "Visit",
        name: "Visit",
      });

      await assertJson(
        apiRequest(`/api/admin/site-pages/${page.id}`, {
          body: { content: "New text" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.page.content).toBe("New text");
          expect(body.page.name).toBe("Visit");
          expect(body.page.meta_title).toBe("Visit");
        },
      );
    });

    test("updates every field the form edits", async () => {
      const page = await createTestSitePage("visit", { name: "Visit" });
      const edited = {
        content: "New text",
        meta_description: "New summary",
        meta_title: "New title",
        name: "Renamed",
        slug: "renamed",
      };

      await assertJson(
        apiRequest(`/api/admin/site-pages/${page.id}`, {
          body: edited,
          method: "PUT",
        }),
        200,
        (echoed) => {
          expect(echoed.page).toMatchObject(edited);
        },
      );
      await expectStoredPage(page.id, edited);
    });

    test("flips the Hidden flag and the nav model follows", async () => {
      const page = await createTestSitePage("visit", { name: "Visit" });
      const key = sitePageItemTargets.key(
        sitePageItemTargets.of("page")(page.id),
      );

      const before = await publicNavModel(key);
      expect(before.activeRootId).toBe(page.id);

      await assertJson(
        apiRequest(`/api/admin/site-pages/${page.id}`, {
          body: { hidden: true },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.page.hidden).toBe(true);
        },
      );

      // The hidden page leaves the menus: reading the nav as the page itself
      // highlights nothing.
      const after = await withRequestContext(() => publicNavModel(key));
      expect(after.activeRootId).toBeNull();
    });

    test("nests the page under another page and back", async () => {
      const parent = await createTestSitePage("visit", { name: "Visit" });
      const child = await createTestSitePage("extras", { name: "Extras" });

      await putPageUnder(child.id, parent.id);

      await assertJson(
        apiRequest(`/api/admin/site-pages/${child.id}`, {
          body: { parent: null },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.page.parent).toBeNull();
        },
      );
    });

    test("moves a nested page to a different parent in one request", async () => {
      const parent = await createTestSitePage("visit", { name: "Visit" });
      const child = await createTestSitePage("extras", { name: "Extras" });
      const second = await createTestSitePage("more", { name: "More" });
      await addPageItem(parent.id, "page", child.id);

      await putPageUnder(child.id, second.id);

      await assertJson(
        apiRequest(`/api/admin/site-pages/${child.id}`),
        200,
        (body) => {
          expect(body.page.parent).toBe(second.id);
        },
      );
    });

    test("keeps a nested page in place when the update re-sends its parent", async () => {
      const { child, parent } = await nestedPages();

      await putPageUnder(child.id, parent.id);
      // The no-op wrote no second parent edge for the child.
      const edges = (await getAllPageItems()).filter(
        (item) => item.item_type === "page" && item.item_id === child.id,
      );
      expect(edges.map((edge) => edge.page_id)).toEqual([parent.id]);
    });

    test("refuses nesting a page under itself", async () => {
      const page = await createTestSitePage("visit", { name: "Visit" });
      await expectUpdateRefused(
        page.id,
        { parent: page.id },
        t("site.pages.error.ineligible"),
      );
    });

    test("refuses a parent that would close a cycle", async () => {
      const { child, parent } = await nestedPages();

      await expectUpdateRefused(
        parent.id,
        { parent: child.id },
        "That item can't be added to this page.",
      );
    });

    test("refuses a parent that is not a page id or null", async () => {
      const page = await createTestSitePage("visit");
      for (const parent of ["visit", 1.5]) {
        await expectUpdateRefused(
          page.id,
          { parent },
          "parent must be a page id or null",
        );
      }
    });

    test("refuses a slug a listing owns with the form's message", async () => {
      const page = await createTestSitePage("visit", { name: "Visit" });
      const listing = await createTestListing({ name: "Kayak" });

      await expectUpdateRefused(
        page.id,
        { slug: listing.slug },
        t("site.pages.error.slug_taken"),
      );
    });

    test("refuses a parent that names no page with the form's message", async () => {
      const page = await createTestSitePage("visit", { name: "Visit" });

      await expectUpdateRefused(
        page.id,
        { parent: 99999999 },
        t("site.pages.error.ineligible"),
      );
    });

    test("logs the update the way the form's save does", async () => {
      const page = await createTestSitePage("visit", { name: "Visit" });
      await apiRequest(`/api/admin/site-pages/${page.id}`, {
        body: { content: "Rewritten" },
        method: "PUT",
      });
      expect(await wasActivityLogged("Page 'Visit' updated")).toBe(true);
    });
  });

  describe("the update transaction", () => {
    test("rolls the write back when the parent move loses its eligibility check", async () => {
      const page = await createTestSitePage("visit", {
        content: "Old text",
        name: "Visit",
      });

      const outcome = await writeUpdate(
        page,
        {
          content: "New text",
          hidden: false,
          metaDescription: "",
          metaTitle: "",
          name: "Renamed",
          slug: "renamed",
        },
        // The boolean addPageItem returns when the single-parent re-check
        // inside the transaction loses to a concurrent move.
        async () => false,
      );

      if (!("refusal" in outcome)) {
        throw new Error("the refused parent move did not refuse the update");
      }
      expect(outcome.refusal.status).toBe(400);
      expect(await outcome.refusal.json()).toEqual({
        error: t("site.pages.error.ineligible"),
      });
      // The refused transaction rolled the row write back with the edge.
      await expectStoredPage(page.id, { content: "Old text", name: "Visit" });
    });
  });

  describe("DELETE /api/admin/site-pages/:pageId", () => {
    test("deletes on a matching name confirmation", async () => {
      const { child, parent } = await nestedPages();

      await assertApiDeleteOk(`/api/admin/site-pages/${parent.id}`, "Visit");
      expect(await getSitePageById(parent.id)).toBeNull();
      // The child survives as a top-level page.
      const orphan = await getSitePageById(child.id);
      expect(orphan).not.toBeNull();
      expect(await wasActivityLogged("Page 'Visit' deleted")).toBe(true);
    });

    test("refuses a delete whose name confirmation does not match", async () => {
      const page = await createTestSitePage("visit", { name: "Visit" });

      await expectApiError(
        apiRequest(`/api/admin/site-pages/${page.id}`, {
          body: { confirm_identifier: "Wrong" },
          method: "DELETE",
        }),
        400,
        "Page name does not match. Please provide the exact page name in confirm_identifier.",
      );
      // The page survives the refused delete.
      expect(await getSitePageById(page.id)).not.toBeNull();
    });
  });
});
