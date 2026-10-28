import { assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import {
  CATALOG_BUNDLE_EXAMPLE_JSON,
  CATALOG_GROUP_EXAMPLE_JSON,
  CATALOG_LISTING_EXAMPLE_JSON,
} from "#shared/catalog-transfer-example.ts";
import { renderGuideSections } from "#templates/admin/guide/components.tsx";
import { importExportSections } from "#templates/admin/guide/import-export.tsx";

test("the catalog examples are labelled and code-fenced", () => {
  /** What a `<code>` body shows: JSX escapes double quotes as entities. */
  const shown = (code: string): string => code.replaceAll('"', "&quot;");
  const html = String(renderGuideSections(importExportSections()));
  assertStringIncludes(
    html,
    `<pre><code>${shown(CATALOG_LISTING_EXAMPLE_JSON)}</code></pre>`,
  );
  assertStringIncludes(
    html,
    `<pre><code>${shown(CATALOG_GROUP_EXAMPLE_JSON)}</code></pre>`,
  );
  assertStringIncludes(
    html,
    `<pre><code>${shown(CATALOG_BUNDLE_EXAMPLE_JSON)}</code></pre>`,
  );
  // The group example names its label, not the listing's.
  assertStringIncludes(
    html,
    "<p><strong>A group — its own fields plus its member listings (by name),",
  );
});

test("the section keeps its anchor id and its promo copy joins cleanly", () => {
  const html = String(renderGuideSections(importExportSections()));
  // The footer deep-links use /admin/guide#import-export.
  assertStringIncludes(html, '<h3 id="import-export">');
  // The custom entry's word joins: an inline code word follows plain text
  // without doubling or dropping the space the template literal carries.
  assertStringIncludes(
    html,
    "The top-level <code>kind</code> is either <code>&quot;listing&quot;</code>, <code>&quot;group&quot;</code>, or <code>&quot;bundle&quot;</code>, and <code>version</code> stops a file",
  );
  // The bundle entry names the transaction promise.
  assertStringIncludes(
    html,
    "The import is one transaction: nothing is created when one item fails",
  );
  // The tail paragraph's join: the inline <code> word follows plain text with
  // the one space the template literal carries.
  assertStringIncludes(
    html,
    `Only <code>name</code> (and a listing's <code>maxAttendees</code>) are always`,
  );
});
