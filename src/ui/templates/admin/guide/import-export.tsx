/**
 * Admin guide — Import & Export (catalog transfer) section.
 *
 * The JSON examples are the schema-derived constants from
 * `#shared/catalog-transfer-example.ts` — the same shape the real exporter
 * produces and the real importer accepts — so the guide never drifts from the
 * format. Import and export share one format, so one pair of examples documents
 * both directions.
 */

import {
  CATALOG_GROUP_EXAMPLE_JSON,
  CATALOG_LISTING_EXAMPLE_JSON,
} from "#shared/catalog-transfer-example.ts";
import {
  custom,
  ExampleCode,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const importExportSections = (): GuideSection[] => [
  {
    entries: [
      faq("what_is_catalog_transfer"),
      faq("how_do_i_export_catalog"),
      faq("how_do_i_import_catalog"),
      faq("what_is_in_catalog_file"),
      custom(
        "catalog_json_shape",
        <>
          <p>
            One shared format covers both directions — the file you download on
            export is exactly what an import accepts. The top-level{" "}
            <code>kind</code> is either <code>"listing"</code> or{" "}
            <code>"group"</code>, and <code>version</code> guards against
            importing a file from an incompatible format. Prices are whole
            numbers in the smallest currency unit (pence for GBP, cents for
            USD).
          </p>
          <p>
            <strong>A listing</strong> — its own fields plus the groups it
            belongs to, each referenced by name and carrying any package
            price/quantity override. The <code>parents</code> array names the
            listings this one is offered under as an add-on; it is empty here
            because a package member can't also be an add-on child:
          </p>
          <pre>
            <code>{CATALOG_LISTING_EXAMPLE_JSON}</code>
          </pre>
          <ExampleCode
            code={CATALOG_GROUP_EXAMPLE_JSON}
            label={
              <>
                A group — its own fields plus its member listings (by name),
                each carrying its package price, quantity, and per-day
                overrides:
              </>
            }
          />
          <p>
            Every optional field can be omitted — the importing site fills in
            its own defaults. Only <code>name</code> (and a listing's{" "}
            <code>maxAttendees</code>) are always required.
          </p>
        </>,
      ),
    ],
    id: "import-export",
    titleKey: "import_export",
  },
];
