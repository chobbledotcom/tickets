import { t } from "#i18n";
import { type BuiltSite, DEFAULT_UPDATE_TIER } from "#shared/db/built-sites.ts";
import {
  booleanToCheckbox,
  CsrfForm,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { SiteSecretsView } from "#shared/site-secrets.ts";
import type { BuiltSiteUpdateState } from "#shared/site-update.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
/* jscpd:ignore-start */
import { AdminPage, errorAdminPage } from "#templates/admin/admin-page.tsx";
/* jscpd:ignore-end */
import {
  BuiltSitesListActions,
  BuiltSitesListBody,
} from "#templates/admin/built-sites/list-parts.tsx";
import {
  renewalPanelFor,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { AdminListPage } from "#templates/admin/list-page.tsx";
import {
  ActionButton,
  GuideFooter,
  SaveChangesButton,
} from "#templates/components/actions.tsx";
import { NewResourceForm } from "#templates/components/new-resource-form.tsx";
import { getBuiltSiteFields } from "#templates/fields.ts";

export const adminBuiltSitesPage = (
  sites: BuiltSite[],
  session: AdminSession,
  successMessage?: string,
  renewalTiers: ListingWithCount[] = [],
): string => {
  const hostingIds = sites
    .filter((site) => site.hostingId && site.hostingProvider === "bunny")
    .map((site) => site.hostingId)
    .join("|");

  return AdminListPage({
    actions: <BuiltSitesListActions />,
    active: "/admin/built-sites",
    children: (
      <>
        <BuiltSitesListBody
          hostingIds={hostingIds}
          renewalTiers={renewalTiers}
          sites={sites}
        />
        <GuideFooter href="/admin/guide#built-sites">
          {t("built_sites.guide_link")}
        </GuideFooter>
      </>
    ),
    session,
    successMessage,
    title: t("built_sites.list_title"),
  });
};

export const builtSiteToFieldValues = (
  site?: BuiltSite,
): Record<string, string | number | null> => ({
  assignable: booleanToCheckbox(!!site?.assignable),
  db_provider: site?.dbProvider ?? "bunny",
  db_token: site?.dbToken ?? "",
  db_url: site?.dbUrl ?? "",
  hosting_id: site?.hostingId ?? "",
  hosting_provider: site?.hostingProvider ?? "bunny",
  name: site?.name ?? "",
  site_url: site?.siteUrl ?? "",
  updates: site?.updates ?? DEFAULT_UPDATE_TIER,
});

export const adminBuiltSiteNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  errorAdminPage(t("built_sites.add_site_title"), "/admin/built-sites")(
    session,
    error,
  )(
    <NewResourceForm
      action="/admin/built-sites"
      fieldsHtml={renderFields(getBuiltSiteFields())}
      submitLabel={t("built_sites.create_built_site_button")}
      title={t("built_sites.add_site_title")}
    />,
  );

export const adminBuiltSiteEditPage = (
  site: BuiltSite,
  session: AdminSession,
  error?: string,
  success?: string,
  secretsView?: SiteSecretsView,
  updateState?: BuiltSiteUpdateState,
): string =>
  String(
    <AdminPage
      active="/admin/built-sites"
      session={session}
      title={t("built_sites.edit_site_title")}
    >
      <CsrfForm action={`/admin/built-sites/${site.id}/edit`}>
        <h1>{t("built_sites.edit_site_title")}</h1>
        <Flash error={error} success={success} />
        <Raw
          html={renderFields(
            getBuiltSiteFields(),
            builtSiteToFieldValues(site),
          )}
        />
        {SaveChangesButton()}
      </CsrfForm>

      <h2>{t("built_sites.renewal_title")}</h2>
      {renewalPanelFor(site)}

      <h2>{t("built_sites.secrets_title")}</h2>
      <SecretsPanel site={site} view={secretsView} />

      {updateState && (
        <>
          <h2>{t("built_sites.update_title")}</h2>
          <UpdatePanel site={site} state={updateState} />
        </>
      )}

      <h2>{t("common.delete")}</h2>
      <p class="prose">
        <ActionButton
          href={`/admin/built-sites/${site.id}/delete`}
          icon="trash-2"
          variant="secondary"
        >
          {t("built_sites.delete_this_site")}
        </ActionButton>
      </p>
    </AdminPage>,
  );

export const adminBuiltSiteDeletePage = (
  site: BuiltSite,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/built-sites/${site.id}/delete`,
    active: "/admin/built-sites",
    buttonText: t("built_sites.delete_built_site_button"),
    children: (
      <>
        <h1>{t("built_sites.delete_page_title")}</h1>
        <p>
          <Raw
            html={t("built_sites.delete_confirmation", {
              name: escapeHtml(site.name),
            })}
          />
        </p>
        <p>
          {t("built_sites.delete_confirmation_prompt", { name: site.name })}
        </p>
      </>
    ),
    danger: false,
    error,
    label: t("built_sites.delete_label"),
    name: site.name,
    session,
    title: t("built_sites.delete_page_title"),
  });
