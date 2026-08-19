/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import {
  ADMIN_FEATURES,
  type AdminFeatureDefinition,
  type EnabledFeatures,
} from "#shared/admin-features.ts";
import { isReadOnly } from "#shared/env.ts";
import { Flash } from "#shared/forms/flash.tsx";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { settingsPage } from "#templates/admin/settings/page-shell.tsx";
import { BackButton } from "#templates/components/actions.tsx";
import { TitledArticle } from "#templates/components/page-structure.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";
import { YesNoRadios } from "#templates/components/yes-no-radios.tsx";
import type { AdminSession, Theme } from "#types";

/* jscpd:ignore-end */

type FeatureRow = {
  enabled: boolean;
  feature: AdminFeatureDefinition;
};

const featureRows = (enabledFeatures: EnabledFeatures): FeatureRow[] =>
  ADMIN_FEATURES.map((feature) => ({
    enabled: enabledFeatures[feature.key],
    feature,
  }));

const featureColumns: TableColumn<FeatureRow>[] = [
  {
    cell: ({ feature }) => (
      <a href={`/admin/features/${feature.slug}`}>{t(feature.labelKey)}</a>
    ),
    header: translatedTableHeader("features.column.feature"),
    key: "feature",
  },
  {
    cell: ({ enabled }) =>
      t(enabled ? "features.status.enabled" : "features.status.disabled"),
    header: translatedTableHeader("features.column.status"),
    key: "status",
  },
];

const featureTable = defineTable(featureColumns);

/** The settings-page feature summary. It is deliberately not an editor: each
 * linked detail page explains one feature before offering its switch. */
export const FeaturesTable = ({
  enabledFeatures,
}: {
  enabledFeatures: EnabledFeatures;
}): JSX.Element => (
  <TitledArticle id="settings-features" title={t("features.title")}>
    <p>{t("features.intro")}</p>
    {renderTable(featureTable, featureRows(enabledFeatures))}
  </TitledArticle>
);

export const adminFeaturePage = ({
  enabled,
  error,
  feature,
  inUse,
  session,
  success,
  theme,
}: {
  enabled: boolean;
  error?: string | undefined;
  feature: AdminFeatureDefinition;
  inUse: boolean;
  session: AdminSession;
  success?: string | undefined;
  theme: Theme;
}): string =>
  settingsPage(t(feature.labelKey), "/admin/settings")(session, theme)(
    <>
      <p>
        <BackButton href="/admin/settings">
          {t("features.back_to_settings")}
        </BackButton>
      </p>
      <h1>{t(feature.labelKey)}</h1>
      <Flash error={error} success={success} />
      <p>{t(feature.descriptionKey)}</p>
      {inUse || isReadOnly() ? (
        <>
          <p>
            <strong>{t("features.status_label")}</strong>{" "}
            {t(
              enabled ? "features.status.enabled" : "features.status.disabled",
            )}
          </p>
          {inUse && (
            <>
              <p>{t("features.in_use")}</p>
              <p>{t("features.in_use_help")}</p>
            </>
          )}
        </>
      ) : (
        <SaveForm
          action={`/admin/features/${feature.slug}`}
          submitLabel={t("features.save")}
        >
          <YesNoRadios name="enabled" on={enabled} />
        </SaveForm>
      )}
    </>,
  );
