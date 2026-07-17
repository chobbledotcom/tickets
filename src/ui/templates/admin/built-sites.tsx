import { t } from "#i18n";
import { type BuiltSite, DEFAULT_UPDATE_TIER } from "#shared/db/built-sites.ts";
import type { FormRenderValuesFor } from "#shared/forms/definition.ts";
import { booleanToCheckbox } from "#shared/forms/values.ts";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { editPanel, flashFormPage } from "#templates/admin/admin-page.tsx";
import {
  BuiltSitesGuideFooter,
  BuiltSitesListActions,
  BuiltSitesListBody,
} from "#templates/admin/built-sites/list-parts.tsx";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";
import { AdminListPage } from "#templates/admin/list-page.tsx";
import { NewResourceForm } from "#templates/components/new-resource-form.tsx";
import { saveFormComponent } from "#templates/components/save-form.tsx";
import { getBuiltSiteForm } from "#templates/fields/admin.ts";

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
      fieldsHtml={getBuiltSiteForm().render()}
      submitLabel={t("built_sites.create_built_site_button")}
      title={t("built_sites.add_site_title")}
    />
  ),
);

type BuiltSiteRenderValues = FormRenderValuesFor<
  ReturnType<typeof getBuiltSiteForm>["fields"]
>;

const BuiltSiteSaveForm = saveFormComponent<{
  action: string;
  children: JSX.Element;
}>(({ children }) => ({
  children,
  submitLabel: t("common.save_changes"),
}));

/** The entity page's ordinary Edit tab, including rejected submitted values. */
interface BuiltSiteEditPanelProps {
  error?: string | undefined;
  site: BuiltSite;
  values?: BuiltSiteRenderValues;
}

export const BuiltSiteEditPanel = ({
  error,
  site,
  values,
}: BuiltSiteEditPanelProps): JSX.Element =>
  editPanel(error)(
    <BuiltSiteSaveForm action={`/admin/built-sites/${site.id}/edit`}>
      <Raw
        html={getBuiltSiteForm().render(values ?? builtSiteToFieldValues(site))}
      />
    </BuiltSiteSaveForm>,
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
