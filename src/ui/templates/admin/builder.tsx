/**
 * Admin builder page template — create new Tickets instances
 */

import { t } from "#i18n";
import { builderForm } from "#routes/admin/builder.ts";
import { getDefaultDbProvider } from "#shared/config.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

export type BuiltSiteDisplay = {
  name: string;
  siteUrl: string;
  created: string;
};

/** Form to create a new site */
const BuilderForm = (): JSX.Element => (
  <section>
    <div class="prose">
      <h2>{t("builder.create_new_site")}</h2>
      <p>{t("builder.create_description")}</p>
    </div>
    <CsrfForm action="/admin/builder" id="builder-form">
      <Raw html={builderForm.render({ db_provider: getDefaultDbProvider() })} />
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
  </section>
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
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("common.name")}</th>
            <th>{t("builder.table_url")}</th>
            <th>{t("builder.table_built")}</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => (
            <tr>
              <td>{site.name}</td>
              <td>
                <a href={site.siteUrl} rel="noopener" target="_blank">
                  {site.siteUrl}
                </a>
              </td>
              <td>{site.created}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

export const adminBuilderPage = (
  session: AdminSession,
  sites: BuiltSiteDisplay[],
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title={t("builder.site_builder_title")}>
      <AdminNav active="/admin/settings" session={session} />

      <Flash {...(error !== undefined ? { error } : {})} {...(success !== undefined ? { success } : {})} />

      <h2>{t("builder.site_builder_title")}</h2>

      <BuilderForm />

      <section>
        <div class="prose">
          <h2>{t("builder.built_sites_title")}</h2>
        </div>
        <BuiltSitesTable sites={sites} />
      </section>
    </Layout>,
  );
