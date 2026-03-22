/**
 * Admin API keys page template
 */

import { map, pipe, reduce } from "#fp";
import { t } from "#i18n";
import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav, UsersSubNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

type ApiKeyDisplay = {
  id: number;
  name: string;
  created: string;
  lastUsed: string;
};

const ApiKeyRow = ({ apiKey }: { apiKey: ApiKeyDisplay }): string =>
  String(
    <tr>
      <td>{apiKey.name}</td>
      <td>{new Date(apiKey.created).toLocaleDateString()}</td>
      <td>
        {apiKey.lastUsed
          ? new Date(apiKey.lastUsed).toLocaleDateString()
          : t("api_keys.never")}
      </td>
      <td>
        <a href={`/admin/api-keys/${apiKey.id}/delete`} class="danger small">
          {t("api_keys.delete")}
        </a>
      </td>
    </tr>,
  );

/**
 * Admin API keys page
 */
export const adminApiKeysPage = (
  keys: ApiKeyDisplay[],
  adminSession: AdminSession,
  opts: { success?: string; error?: string; newKey?: string },
): string => {
  const keyRows =
    keys.length > 0
      ? pipe(
          map((k: ApiKeyDisplay) => ApiKeyRow({ apiKey: k })),
          joinStrings,
        )(keys)
      : `<tr><td colspan="4">${t("api_keys.no_keys")}</td></tr>`;

  return String(
    <Layout title={t("api_keys.title")}>
      <AdminNav session={adminSession} active="/admin/users" />
      <UsersSubNav />

      {opts.error && <div class="error">{opts.error}</div>}
      {opts.success && <div class="success">{opts.success}</div>}

      {opts.newKey && (
        <div class="warning">
          <strong>{t("api_keys.copy_notice")}</strong>
          <pre>
            <code>{opts.newKey}</code>
          </pre>
          <p>
            {t("api_keys.usage_hint")}
          </p>
        </div>
      )}

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("api_keys.col.name")}</th>
              <th>{t("api_keys.col.created")}</th>
              <th>{t("api_keys.col.last_used")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <Raw html={keyRows} />
          </tbody>
        </table>
      </div>

      <br />

      <CsrfForm action="/admin/api-keys">
        <fieldset>
          <legend>{t("api_keys.create_legend")}</legend>
          <label>
            {t("api_keys.name_label")}
            <input
              type="text"
              name="name"
              placeholder={t("api_keys.name_placeholder")}
              required
              maxLength={100}
            />
          </label>
          <button type="submit">{t("api_keys.create_submit")}</button>
        </fieldset>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin API key delete confirmation page
 */
export const adminDeleteApiKeyPage = (
  apiKey: { id: number; name: string },
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Delete: ${apiKey.name}`}>
      <AdminNav session={session} active="/admin/users" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            {t("api_keys.delete_warning")}
          </p>
        </aside>
      </article>

      <p>
        {t("api_keys.delete_confirm", { name: apiKey.name })}
      </p>

      <CsrfForm action={`/admin/api-keys/${apiKey.id}/delete`}>
        <label for="confirm_identifier">{t("api_keys.delete_label")}</label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={apiKey.name}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          {t("api_keys.delete_submit")}
        </button>
      </CsrfForm>
    </Layout>,
  );
