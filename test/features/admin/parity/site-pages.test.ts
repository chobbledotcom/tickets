// Behaviour pins for the site-pages resource: what each surface answers
// today, one test per fact. The page posts to /admin/site/pages (SITE_FORM);
// the JSON API posts to /api/admin/site-pages (SITE_API). The fixed pages
// have no page-surface write of their own, so their pins record the API's
// refusals.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { settings } from "#db/settings.ts";
import { getSitePageBySlugIndex } from "#db/site-pages.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import { assertJson, expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import {
  createTestEditorSession,
  createTestManagerSession,
  requestAsSession,
} from "#test-utils/session.ts";
import {
  apiPostAs,
  expectNonStringNameRefused,
  ownerApiDelete,
  ownerApiPost,
  ownerApiPut,
  ownerPagePost,
  pagePostAs,
} from "./helpers.ts";

describeWithEnv("Site page parity pins", { db: true }, () => {
  const pageBySlug = async (slug: string) => {
    const row = await getSitePageBySlugIndex(await hmacHash(slug));
    if (!row) throw new Error(`no page was stored for slug ${slug}`);
    return row;
  };

  test("page create stores the posted fields", async () => {
    const response = await ownerPagePost("/admin/site/pages", {
      content: "Pack light.",
      hidden: "1",
      meta_description: "Before you come",
      meta_title: "Plan",
      name: "Plan your weekend",
      slug: "plan-your-weekend",
    });
    const row = await pageBySlug("plan-your-weekend");
    expectRedirectWithFlash(
      `/admin/site/pages/${row.id}/edit`,
      "Page created",
    )(response);
    expect(row.name).toBe("Plan your weekend");
    expect(row.slug).toBe("plan-your-weekend");
    expect(row.hidden).toBe(true);
    expect(row.content).toBe("Pack light.");
    expect(row.meta_title).toBe("Plan");
    expect(row.meta_description).toBe("Before you come");
  });

  test("api create stores the posted fields the same way", async () => {
    await assertJson(
      ownerApiPost("/api/admin/site-pages", {
        content: "Pack light.",
        hidden: true,
        meta_description: "Before you come",
        meta_title: "Plan",
        name: "Plan api weekend",
        slug: "plan-api-weekend",
      }),
      201,
      (body) => {
        expect(body.page.name).toBe("Plan api weekend");
        expect(body.page.slug).toBe("plan-api-weekend");
        expect(body.page.hidden).toBe(true);
        expect(body.page.content).toBe("Pack light.");
      },
    );
  });

  test("page update unticks the Hidden box the way the form posts it", async () => {
    const page = await createTestSitePage("visit", {
      hidden: true,
      name: "Visit",
    });
    // An unticked checkbox never reaches the form: the field is absent.
    const response = await ownerPagePost(`/admin/site/pages/${page.id}/edit`, {
      content: "Still here",
      meta_description: "",
      meta_title: "",
      name: "Visit",
      slug: "visit",
    });
    expectRedirectWithFlash(
      `/admin/site/pages/${page.id}/edit`,
      "Page updated",
    )(response);
    const row = await pageBySlug("visit");
    expect(row.hidden).toBe(false);
    expect(row.content).toBe("Still here");
  });

  test("api update keeps a silent Hidden flag and stores a supplied one", async () => {
    const page = await createTestSitePage("api-visit", {
      hidden: true,
      name: "Api visit",
    });
    // No hidden in the body: the stored flag stays.
    await assertJson(
      ownerApiPut(`/api/admin/site-pages/${page.id}`, {
        content: "Rewritten",
      }),
      200,
      (body) => {
        expect(body.page.hidden).toBe(true);
        expect(body.page.content).toBe("Rewritten");
      },
    );
    // A supplied false unticks it.
    await assertJson(
      ownerApiPut(`/api/admin/site-pages/${page.id}`, {
        hidden: false,
      }),
      200,
      (body) => {
        expect(body.page.hidden).toBe(false);
      },
    );
  });

  /** Pin one slug's refusal on both surfaces: the JSON API answers the
   *  message as a 400, the page form answers it as a flash redirect. */
  const refuseSlugOnBothSurfaces = async (
    slug: string,
    message: string,
  ): Promise<void> => {
    const api = await ownerApiPost("/api/admin/site-pages", {
      name: "Refused page",
      slug,
    });
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe(message);
    expectRedirectWithFlash(
      "/admin/site/pages/new",
      message,
      false,
    )(
      await ownerPagePost("/admin/site/pages", {
        name: "Refused page",
        slug,
      }),
    );
  };

  test("both surfaces refuse a reserved slug with the same message", async () => {
    await refuseSlugOnBothSurfaces("home", t("site.pages.error.reserved"));
  });

  test("both surfaces refuse a taken slug with the same message", async () => {
    const listing = await createTestListing({ name: "Kayak" });
    await refuseSlugOnBothSurfaces(
      listing.slug,
      t("site.pages.error.slug_taken"),
    );
  });

  test("api update refuses a non-string name with the field message", async () => {
    await expectNonStringNameRefused("site-pages", "page", {
      name: "Pinned guard page",
      slug: "pinned-guard-page",
    });
  });

  test("the api refuses to create, delete, or hide a fixed page", async () => {
    const created = await ownerApiPost("/api/admin/site-pages/home", {
      content: "text",
    });
    expect(created.status).toBe(400);
    expect((await created.json()).error).toBe("Fixed pages cannot be created.");

    const deleted = await ownerApiDelete("/api/admin/site-pages/home", {
      confirm_identifier: "home",
    });
    expect(deleted.status).toBe(400);
    expect((await deleted.json()).error).toBe("Fixed pages cannot be deleted.");

    const hidden = await ownerApiPut("/api/admin/site-pages/home", {
      content: "text",
      hidden: true,
    });
    expect(hidden.status).toBe(400);
    expect((await hidden.json()).error).toBe("A fixed page cannot be hidden.");
  });

  test("the api updates a fixed page's content and logs the form's line", async () => {
    const updated = await ownerApiPut("/api/admin/site-pages/contact", {
      content: "Call the hut on 010 000 0000.",
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).page.content).toBe(
      "Call the hut on 010 000 0000.",
    );
    expect(await wasActivityLogged("Contact page updated")).toBe(true);
    expect(settings.contactPageText).toBe("Call the hut on 010 000 0000.");
  });

  test("an editor writes pages on both surfaces, terms apart", async () => {
    const { cookie } = await createTestEditorSession();

    // The page form admits an editor (SITE_FORM), and so does the API.
    const page = await pagePostAs(
      "/admin/site/pages",
      { name: "Editor page", slug: "editor-page" },
      cookie,
    );
    expect(page.status).toBe(302);
    const api = await apiPostAs(
      "/api/admin/site-pages",
      { name: "Editor api page", slug: "editor-api-page" },
      cookie,
    );
    expect(api.status).toBe(201);

    // The terms editor is owner-only; the API matches.
    const terms = await handleRequest(
      requestAsSession("/api/admin/site-pages/terms", {
        cookie,
        csrfToken: "editor-csrf",
      }),
    );
    expect(terms.status).toBe(403);
  });

  test("a manager is refused on both surfaces", async () => {
    const managerCookie = await createTestManagerSession();
    const api = await apiPostAs(
      "/api/admin/site-pages",
      { name: "Manager page", slug: "manager-page" },
      managerCookie,
    );
    expect(api.status).toBe(403);
    const page = await pagePostAs(
      "/admin/site/pages",
      { name: "Manager page", slug: "manager-page" },
      managerCookie,
    );
    expect(page.status).toBe(403);
  });
});
