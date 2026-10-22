// The site-pages input mapping's refusals, answered through the JSON API: the
// same field rules and messages the Site -> Pages form runs, on create and on
// update. The happy paths and the write-path refusals live in
// api-site-pages.test.ts.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sitePages } from "#db/site-pages.ts";
import { t } from "#i18n";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Site page input refusals", { db: true }, () => {
  test("refuses a non-string name with the field message", async () => {
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { name: 42, slug: "named-42" },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe("name must be a string");
      },
    );
  });

  test("refuses a missing name with the field message", async () => {
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { slug: "no-name" },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe("name is required");
      },
    );
    const all = await sitePages.getAll();
    expect(all.find((page) => page.slug === "no-name")).toBeUndefined();
  });

  test("refuses a missing slug with the slug rule's message", async () => {
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { name: "No slug" },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe("Slug is required");
      },
    );
    const all = await sitePages.getAll();
    expect(all.find((page) => page.name === "No slug")).toBeUndefined();
    // The create's silent-slug fallback runs the empty stored slug through
    // the same rule, so nothing may store under the empty slug either.
    expect(all.find((page) => page.slug === "")).toBeUndefined();
  });

  test("refuses a non-boolean hidden flag with the field message", async () => {
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { hidden: "yes", name: "Boxy", slug: "boxy" },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe("hidden must be a boolean");
      },
    );
  });

  test("refuses a reserved slug with the form's message", async () => {
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { name: "Home page", slug: "home" },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          "That slug is reserved — please choose another.",
        );
      },
    );
  });

  test("refuses a slug a listing owns with the form's message", async () => {
    const listing = await createTestListing({ name: "Kayak" });
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { name: "Kayak page", slug: listing.slug },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          "That slug is already in use by a listing, group, or page.",
        );
      },
    );
  });

  test("refuses a name past the form's length cap with its message", async () => {
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { name: "x".repeat(251), slug: "long-name" },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          t("fields.validation.max_length", {
            label: t("site.pages.field.name"),
            max: 250,
          }),
        );
      },
    );
  });

  test("refuses a slug past the form's length cap with its message", async () => {
    await assertJson(
      apiRequest("/api/admin/site-pages", {
        body: { name: "Long slug", slug: "a".repeat(251) },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          t("fields.validation.max_length", {
            label: t("common.slug"),
            max: 250,
          }),
        );
      },
    );
  });

  test("refuses a non-string content value with the field message", async () => {
    const page = await createTestSitePage("visit", { name: "Visit" });

    await assertJson(
      apiRequest(`/api/admin/site-pages/${page.id}`, {
        body: { content: 5 },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toBe("content must be a string");
      },
    );
  });

  test("refuses content past the form's length cap with its message", async () => {
    const page = await createTestSitePage("visit", { name: "Visit" });

    await assertJson(
      apiRequest(`/api/admin/site-pages/${page.id}`, {
        body: { content: "x".repeat(10_241) },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          t("fields.validation.max_length", {
            label: t("fields.content"),
            max: 10_240,
          }),
        );
      },
    );
  });

  test("refuses a meta description past the form's length cap with its message", async () => {
    const page = await createTestSitePage("visit", { name: "Visit" });

    await assertJson(
      apiRequest(`/api/admin/site-pages/${page.id}`, {
        body: { meta_description: "x".repeat(161) },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          t("fields.validation.max_length", {
            label: t("fields.meta_description"),
            max: 160,
          }),
        );
      },
    );
  });

  test("refuses a meta title past the form's length cap with its message", async () => {
    const page = await createTestSitePage("visit", { name: "Visit" });

    await assertJson(
      apiRequest(`/api/admin/site-pages/${page.id}`, {
        body: { meta_title: "x".repeat(65) },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          t("fields.validation.max_length", {
            label: t("fields.meta_title"),
            max: 64,
          }),
        );
      },
    );
  });

  test("refuses a slug outside the URL-safe shape with the slug rule's message", async () => {
    const page = await createTestSitePage("visit", { name: "Visit" });

    await assertJson(
      apiRequest(`/api/admin/site-pages/${page.id}`, {
        body: { slug: "bad!!slug" },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          "Slug must be lowercase letters and numbers separated by single hyphens or underscores",
        );
      },
    );
  });
});
