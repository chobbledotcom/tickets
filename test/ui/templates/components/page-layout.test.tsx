import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PageBlock, PageLayout } from "#templates/components/page-layout.tsx";

describe("page layout components", () => {
  test("separates page regions from related content blocks", () => {
    const html = String(
      <PageLayout className="example-page">
        <PageBlock className="example-block" id="details">
          <h2>Details</h2>
          <p>Related copy</p>
        </PageBlock>
        <p>Another region</p>
      </PageLayout>,
    );

    expect(html).toBe(
      '<div class="page-layout example-page"><div class="page-block example-block" id="details"><h2>Details</h2><p>Related copy</p></div><p>Another region</p></div>',
    );
  });

  test("uses only the base classes when no optional attributes are supplied", () => {
    expect(String(<PageLayout>content</PageLayout>)).toBe(
      '<div class="page-layout">content</div>',
    );
    expect(String(<PageBlock>content</PageBlock>)).toBe(
      '<div class="page-block">content</div>',
    );
  });
});
