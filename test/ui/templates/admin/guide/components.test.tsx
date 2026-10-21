import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  custom,
  faq,
  Q,
  renderGuideSections,
  Section,
} from "#templates/admin/guide/components.tsx";

describe("admin guide components", () => {
  test("renders the standalone section and question structure with escaped copy", () => {
    const html = String(
      <Section title="Sample & section">
        <Q q="Question & answer?" />
      </Section>,
    );

    expect(html).toBe(
      '<div class="page-block"><h3>Sample &amp; section</h3><details><summary>Question &amp; answer?</summary></details></div>',
    );
  });

  test("renders FAQ locale HTML and a custom guide body in schema order", () => {
    const html = String(
      renderGuideSections([
        {
          entries: [
            faq("what_is_servicing"),
            custom(
              "listing_table_columns",
              <p data-entry="custom">Custom & safe</p>,
            ),
          ],
          id: "sample-guide",
          titleKey: "servicing",
        },
      ]),
    );

    assertStringIncludes(
      html,
      `<h3 id="sample-guide">${t("guide.sections.servicing")}</h3>`,
    );
    assertStringIncludes(
      html,
      `<summary>${t("guide.q.what_is_servicing")}</summary><p>`,
    );
    assertStringIncludes(html, "<strong>service event</strong>");
    assert(!html.includes("&lt;strong&gt;service event&lt;/strong&gt;"));
    assertStringIncludes(
      html,
      `<summary>${t("guide.q.listing_table_columns")}</summary><p data-entry="custom">Custom &amp; safe</p>`,
    );
    expect(html.indexOf(t("guide.q.what_is_servicing"))).toBeLessThan(
      html.indexOf(t("guide.q.listing_table_columns")),
    );
  });
});
