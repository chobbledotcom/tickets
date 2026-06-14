/**
 * Header Image form for settings
 */

import { CsrfForm } from "#shared/forms.tsx";
import { formatBytes, MAX_IMAGE_SIZE } from "#shared/limits.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const HeaderImageForm = (s: SettingsPageState): JSX.Element | null =>
  s.storageEnabled ? (
    <div class="stack">
      {s.headerImageUrl && (
        <div>
          <img
            alt="Header preview"
            class="listing-image-preview"
            src={getImageProxyUrl(s.headerImageUrl)}
          />
          <CsrfForm
            action="/admin/settings/header-image/delete"
            id="settings-header-image-delete"
          >
            <SubmitButton icon="trash-2">Remove Image</SubmitButton>
          </CsrfForm>
        </div>
      )}
      <CsrfForm
        action="/admin/settings/header-image"
        enctype="multipart/form-data"
        id="settings-header-image"
      >
        <h2>Header Image</h2>
        <p>
          An optional image displayed at the top of every page. JPEG, PNG, GIF,
          or WebP — max {formatBytes(MAX_IMAGE_SIZE)}.
        </p>
        <label>
          {s.headerImageUrl ? "Replace Image" : "Upload Image"}
          <input
            accept="image/jpeg,image/png,image/gif,image/webp"
            name="header_image"
            type="file"
          />
        </label>
        <SubmitButton icon="save">Upload</SubmitButton>
      </CsrfForm>
    </div>
  ) : null;
