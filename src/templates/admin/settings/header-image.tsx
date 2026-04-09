/**
 * Header Image form for settings
 */

import { CsrfForm } from "#lib/forms.tsx";
import { formatBytes, MAX_IMAGE_SIZE } from "#lib/limits.ts";
import { getImageProxyUrl } from "#lib/storage.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const HeaderImageForm = (s: SettingsPageState): JSX.Element | null =>
  s.storageEnabled ? (
    <div class="stack">
      {s.headerImageUrl && (
        <div>
          <img
            src={getImageProxyUrl(s.headerImageUrl)}
            alt="Header preview"
            class="event-image-preview"
          />
          <CsrfForm
            action="/admin/settings/header-image/delete"
            id="settings-header-image-delete"
          >
            <button type="submit">Remove Image</button>
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
            type="file"
            name="header_image"
            accept="image/jpeg,image/png,image/gif,image/webp"
          />
        </label>
        <button type="submit">Upload</button>
      </CsrfForm>
    </div>
  ) : null;
