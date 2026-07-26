import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import {
  buildForest,
  buildNavModel,
  targetKey,
} from "#shared/site-pages/core.ts";
import type { SitePage } from "#shared/types.ts";
import { sitePagePage } from "#templates/public/site-page.tsx";
import { navPage as page } from "#test/test-utils/site-pages/nav-fixtures.ts";

describe("sitePagePage (nav-model race)", () => {
  test("renders without items when the model no longer contains the page", () => {
    // A concurrent delete between the slug lookup and the nav reads leaves a
    // model with no chain for the page: the body renders with no item list.
    const gone: SitePage = {
      content: "Still **here**",
      id: 99,
      meta_description: "",
      meta_title: "",
      name: "Racy Page",
      slug: "racy",
      // Hand-crafted fixture stand-in for the blind index — test cast.
      slug_index: "idx" as BlindIndex,
      sort_order: 0,
    };
    const model = buildNavModel(
      buildForest([page(1)], []),
      new Map(),
      targetKey("page", gone.id),
    );
    const html = sitePagePage(
      gone,
      [],
      {
        hasContact: false,
        hasNews: false,
        hasOrder: false,
        hasTerms: false,
        pages: model,
      },
      "",
    );
    expect(html).toContain("<h1>Racy Page</h1>");
    expect(html).toContain(
      '</nav></div><div class="page-regions public-page"><h1>Racy Page</h1>',
    );
    expect(html).toContain("<strong>here</strong>");
    expect(html).not.toContain('class="page-items"');
  });
});
