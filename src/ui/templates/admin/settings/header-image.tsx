/**
 * Header Image form for settings
 */

import { t } from "#i18n";
import { IMAGE_UPLOAD_ACCEPT } from "#shared/images/formats.ts";
import { formatBytes, MAX_IMAGE_SIZE } from "#shared/limits.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const HeaderImageForm = (s: SettingsPageState): JSX.Element | null =>
  s.storageEnabled ? (
    <PageBlock>
      {s.headerImageUrl && (
        <div>
          <img
            alt={t("settings.header_image_preview_alt")}
            class="listing-image-preview"
            src={getImageProxyUrl(s.headerImageUrl)}
          />
          <SaveForm
            action="/admin/settings/header-image/delete"
            id="settings-header-image-delete"
            submitIcon="trash-2"
            submitLabel={t("admin.listings.remove_image")}
          />
        </div>
      )}
      <SettingsSection
        action="/admin/settings/header-image"
        description={
          <p>
            {t("settings.header_image_hint", {
              size: formatBytes(MAX_IMAGE_SIZE),
            })}
          </p>
        }
        enctype="multipart/form-data"
        submitLabel={t("common.upload")}
        title={t("settings.header_image")}
      >
        <label>
          {s.headerImageUrl
            ? t("settings.replace_image")
            : t("settings.upload_image")}
          <input accept={IMAGE_UPLOAD_ACCEPT} name="header_image" type="file" />
        </label>
      </SettingsSection>
    </PageBlock>
  ) : null;
