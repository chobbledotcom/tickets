import { t } from "#i18n";
import { type BuiltSite, DEFAULT_UPDATE_TIER } from "#shared/db/built-sites.ts";
import { booleanToCheckbox, CsrfForm, renderFields } from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { SiteSecretsView } from "#shared/site-secrets.ts";
import type { BuiltSiteUpdateState } from "#shared/site-update.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
/* jscpd:ignore-start */
import {
  FormHeader,
  flashFormPage,
  renderAdminPage,
} from "#templates/admin/admin-page.tsx";
/* jscpd:ignore-end */
import {
  BuiltSitesGuideFooter,
  BuiltSitesListActions,
  BuiltSitesListBody,
} from "#templates/admin/built-sites/list-parts.tsx";
import {
  renewalPanelFor,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";
import { AdminListPage } from "#templates/admin/list-page.tsx";
import {
  ActionButton,
  SaveChangesButton,
} from "#templates/components/actions.tsx";
import { NewResourceForm } from "#templates/components/new-resource-form.tsx";
import { getBuiltSiteFields } from "#templates/fields/admin.ts";

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
        <BuiltSitesGuideFooter />
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

export const adminBuiltSiteNewPage = flashFormPage(
  "built_sites.add_site_title",
  "/admin/built-sites",
  () => (
    <NewResourceForm
      action="/admin/built-sites"
      fieldsHtml={renderFields(getBuiltSiteFields())}
      submitLabel={t("built_sites.create_built_site_button")}
      title={t("built_sites.add_site_title")}
    />
  ),
);

export const adminBuiltSiteEditPage = (
  site: BuiltSite,
  session: AdminSession,
  error?: string,
  success?: string,
  secretsView?: SiteSecretsView,
  updateState?: BuiltSiteUpdateState,
): string =>
  renderAdminPage(
    "/admin/built-sites",
    session,
    t("built_sites.edit_site_title"),
    <>
      <CsrfForm action={`/admin/built-sites/${site.id}/edit`}>
        <FormHeader
          error={error}
          success={success}
          title={t("built_sites.edit_site_title")}
        />
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
    </>,
  );

export const adminBuiltSiteDeletePage = entityDeletePage((site: BuiltSite) => ({
  action: `/admin/built-sites/${site.id}/delete`,
  active: "/admin/built-sites",
  buttonText: t("built_sites.delete_built_site_button"),
  confirm: {
    args: { name: escapeHtml(site.name) },
    key: "built_sites.delete_confirmation",
  },
  danger: false,
  heading: t("built_sites.delete_page_title"),
  label: t("built_sites.delete_label"),
  name: site.name,
  prompt: {
    args: { name: site.name },
    key: "built_sites.delete_confirmation_prompt",
  },
  title: t("built_sites.delete_page_title"),
}));
