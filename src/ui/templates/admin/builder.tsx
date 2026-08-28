/**
 * Admin builder page template — create new Tickets instances
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { getDefaultDbProvider } from "#shared/config.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { flashDataPage } from "#templates/admin/admin-page.tsx";
import { BuiltSitesGuideFooter } from "#templates/admin/built-sites/list-parts.tsx";
/* jscpd:ignore-start */
import { NewTabUrl } from "#templates/components/new-tab-link.tsx";
import { ProseSection } from "#templates/components/prose-section.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import { builderForm } from "#templates/fields/builder.ts";
/* jscpd:ignore-end */

export type BuiltSiteDisplay = {
  name: string;
  siteUrl: string;
  created: string;
};

const builtSitesTable = defineTable<BuiltSiteDisplay>([
  translatedTableColumn("name", "common.name", (site) => site.name),
  translatedTableColumn("url", "builder.table_url", (site) => (
    <NewTabUrl url={site.siteUrl} />
  )),
  translatedTableColumn("built", "builder.table_built", (site) => site.created),
]);

/** Form to create a new site */
const BuilderForm = (): JSX.Element => (
  <ProseSection
    footer={
      <SaveForm
        action="/admin/builder"
        id="builder-form"
        submitIcon="hammer"
        submitLabel={t("builder.build_site_button")}
      >
        <Raw
          html={builderForm.render({ db_provider: getDefaultDbProvider() })}
        />
        <fieldset>
          <label>
            <input name="assignable" type="checkbox" value="1" />
            {t("builder.available_for_assignment")}
          </label>
          <small>{t("builder.available_for_assignment_help")}</small>
        </fieldset>
      </SaveForm>
    }
    title={t("builder.create_new_site")}
  >
    <p>{t("builder.create_description")}</p>
  </ProseSection>
);

/** Table showing previously built sites */
const BuiltSitesTable = ({
  sites,
}: {
  sites: BuiltSiteDisplay[];
}): JSX.Element =>
  sites.length === 0 ? (
    <p>
      <em>{t("builder.no_sites_yet")}</em>
    </p>
  ) : (
    renderTable(builtSitesTable, sites)
  );

export const adminBuilderPage = flashDataPage<BuiltSiteDisplay[]>(
  "builder.site_builder_title",
  undefined,
  (sites) => (
    <>
      <h2>{t("builder.site_builder_title")}</h2>

      <BuilderForm />

      <ProseSection
        footer={<BuiltSitesTable sites={sites} />}
        title={t("builder.built_sites_title")}
      />

      <BuiltSitesGuideFooter />
    </>
  ),
);
