/**
 * Header Image form for settings
 */

import { t } from "#i18n";
import { CsrfForm } from "#shared/forms.tsx";
import { formatBytes, MAX_IMAGE_SIZE } from "#shared/limits.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const HeaderImageForm = (s: SettingsPageState): JSX.Element | null =>
  s.storageEnabled ? (
    <div class="stack">
      {s.headerImageUrl && (
        <div>
          <img
            alt={t("settings.header_image_preview_alt")}
            class="listing-image-preview"
            src={getImageProxyUrl(s.headerImageUrl)}
          />
          <CsrfForm
            action="/admin/settings/header-image/delete"
            id="settings-header-image-delete"
          >
            <SubmitButton icon="trash-2">
              {t("admin.listings.remove_image")}
            </SubmitButton>
          </CsrfForm>
        </div>
      )}
      <SettingsSection
        action="/admin/settings/header-image"
        description={
          <p>
            An optional image displayed at the top of every page. JPEG, PNG,
            GIF, or WebP — max {formatBytes(MAX_IMAGE_SIZE)}.
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
          <input
            accept="image/jpeg,image/png,image/gif,image/webp"
            name="header_image"
            type="file"
          />
        </label>
      </SettingsSection>
    </div>
  ) : null;
