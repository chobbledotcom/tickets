import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PageBlock,
  PageRegions,
} from "#templates/components/page-structure.tsx";

describe("page structure components", () => {
  test("separates page regions from related content blocks", () => {
    const html = String(
      <PageRegions className="example-page">
        <PageBlock className="example-block" id="details">
          <h2>Details</h2>
          <p>Related copy</p>
        </PageBlock>
        <p>Another region</p>
      </PageRegions>,
    );

    expect(html).toBe(
      '<div class="page-regions example-page"><div class="page-block example-block" id="details"><h2>Details</h2><p>Related copy</p></div><p>Another region</p></div>',
    );
  });

  test("uses only the base classes when no optional attributes are supplied", () => {
    expect(String(<PageRegions>content</PageRegions>)).toBe(
      '<div class="page-regions">content</div>',
    );
    expect(String(<PageBlock>content</PageBlock>)).toBe(
      '<div class="page-block">content</div>',
    );
  });

  test("preserves semantic regions when a block requests one", () => {
    expect(String(<PageBlock as="section">content</PageBlock>)).toBe(
      '<section class="page-block">content</section>',
    );
  });
});
