/**
 * Admin builder page template — create new Tickets instances
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { builderForm } from "#routes/admin/builder.ts";
import { getDefaultDbProvider } from "#shared/config.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { BuiltSitesGuideFooter } from "#templates/admin/built-sites/list-parts.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { DataTable, namedColumns } from "#templates/components/data-table.tsx";
import { ProseSection } from "#templates/components/prose-section.tsx";
/* jscpd:ignore-end */

export type BuiltSiteDisplay = {
  name: string;
  siteUrl: string;
  created: string;
};

/** Form to create a new site */
const BuilderForm = (): JSX.Element => (
  <ProseSection
    footer={
      <CsrfForm action="/admin/builder" id="builder-form">
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
        <SubmitButton icon="hammer">
          {t("builder.build_site_button")}
        </SubmitButton>
      </CsrfForm>
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
    <DataTable
      columns={namedColumns("builder.table_url", "builder.table_built")}
      rows={sites.map((site) => [
        site.name,
        <a href={site.siteUrl} rel="noopener" target="_blank">
          {site.siteUrl}
        </a>,
        site.created,
      ])}
    />
  );

export const adminBuilderPage = (
  session: AdminSession,
  sites: BuiltSiteDisplay[],
  error?: string,
  success?: string,
): string =>
  flashAdminPage(t("builder.site_builder_title"))(session, error, success)(
    <>
      <h2>{t("builder.site_builder_title")}</h2>

      <BuilderForm />

      <ProseSection
        footer={<BuiltSitesTable sites={sites} />}
        title={t("builder.built_sites_title")}
      />

      <BuiltSitesGuideFooter />
    </>,
  );
