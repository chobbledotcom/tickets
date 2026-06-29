/**
 * Admin API keys page template
 */

import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { apiKeyForm } from "#routes/admin/api-keys.ts";
import type { EndpointDoc } from "#shared/admin-api-example.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { DeleteSection, SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

type ApiKeyDisplay = {
  id: number;
  name: string;
  created: string;
  lastUsed: string;
};

const ApiKeyRow = ({ apiKey }: { apiKey: ApiKeyDisplay }): string =>
  String(
    <tr>
      <td>
        <a href={`/admin/api-keys/${apiKey.id}`}>{apiKey.name}</a>
      </td>
      <td>{new Date(apiKey.created).toLocaleDateString()}</td>
      <td>
        {apiKey.lastUsed
          ? new Date(apiKey.lastUsed).toLocaleDateString()
          : t("api_keys.never")}
      </td>
    </tr>,
  );

/**
 * Admin API keys page
 */
export const adminApiKeysPage = (
  keys: ApiKeyDisplay[],
  adminSession: AdminSession,
  opts: {
    success?: string | undefined;
    error?: string | undefined;
    newKey?: string | undefined;
  },
): string => {
  const keyRows =
    keys.length > 0
      ? pipe(
          map((k: ApiKeyDisplay) => ApiKeyRow({ apiKey: k })),
          joinStrings,
        )(keys)
      : `<tr><td colspan="3">${t("api_keys.no_keys")}</td></tr>`;

  return String(
    <Layout title={t("api_keys.title")}>
      <AdminNav active="/admin/users" session={adminSession} />
      <Flash error={opts.error} success={opts.success} />

      {opts.newKey && (
        <div class="warning">
          <strong>{t("api_keys.copy_notice")}</strong>
          <pre>
            <code>{opts.newKey}</code>
          </pre>
          <p>
            Use it with: <code>Authorization: Bearer YOUR_KEY</code>
          </p>
        </div>
      )}

      <p>
        <a href="/admin/api-keys/docs">Click here</a> to read the API
        documentation.
      </p>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("common.created")}</th>
              <th>{t("api_keys.col.last_used")}</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={keyRows} />
          </tbody>
        </table>
      </div>

      <br />

      <CsrfForm action="/admin/api-keys">
        <h2>{t("api_keys.create_legend")}</h2>
        <Raw html={apiKeyForm.render()} />
        <SubmitButton icon="plus">{t("api_keys.create_submit")}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Per-key management page — the destination for the name link in the API keys
 * table. API keys aren't editable, so this read-only summary exists mainly to
 * host the delete action (moved off the table and behind a typed-name
 * confirmation).
 */
export const adminApiKeyManagePage = (
  apiKey: ApiKeyDisplay,
  session: AdminSession,
  opts: { error?: string | undefined; success?: string | undefined } = {},
): string =>
  String(
    <Layout title={`${t("api_keys.title")}: ${apiKey.name}`}>
      <AdminNav active="/admin/users" session={session} />
      <h1>{apiKey.name}</h1>
      <Flash error={opts.error} success={opts.success} />
      <div class="table-scroll">
        <table class="listing-details-table">
          <tbody>
            <tr>
              <th>{t("common.created")}</th>
              <td>{new Date(apiKey.created).toLocaleDateString()}</td>
            </tr>
            <tr>
              <th>{t("api_keys.col.last_used")}</th>
              <td>
                {apiKey.lastUsed
                  ? new Date(apiKey.lastUsed).toLocaleDateString()
                  : t("api_keys.never")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <DeleteSection
        heading={t("common.delete")}
        href={`/admin/api-keys/${apiKey.id}/delete`}
      >
        {t("api_keys.delete_submit")}
      </DeleteSection>
    </Layout>,
  );

/**
 * Admin API key delete confirmation page
 */
export const adminDeleteApiKeyPage = (
  apiKey: { id: number; name: string },
  session: AdminSession,
): string =>
  String(
    <Layout title={`Delete: ${apiKey.name}`}>
      <AdminNav active="/admin/users" session={session} />

      <ConfirmForm
        action={`/admin/api-keys/${apiKey.id}/delete`}
        buttonText={t("api_keys.delete_submit")}
        label={t("api_keys.delete_label")}
        name={apiKey.name}
      >
        <p>{t("api_keys.delete_warning")}</p>
        <p>{t("api_keys.delete_confirm", { name: apiKey.name })}</p>
      </ConfirmForm>
    </Layout>,
  );

const EndpointEntry = ({ endpoint }: { endpoint: EndpointDoc }): string =>
  String(
    <details>
      <summary>
        <code>
          {endpoint.method} {endpoint.path}
        </code>{" "}
        &mdash; {endpoint.description}
      </summary>
      {endpoint.request && (
        <>
          <p>
            <strong>Request:</strong>
          </p>
          <pre>
            <code>{endpoint.request}</code>
          </pre>
        </>
      )}
      <p>
        <strong>Response:</strong>
      </p>
      <pre>
        <code>{endpoint.response}</code>
      </pre>
    </details>,
  );

const EndpointList = ({ endpoints }: { endpoints: EndpointDoc[] }): string =>
  pipe(
    map((e: EndpointDoc) => EndpointEntry({ endpoint: e })),
    joinStrings,
  )(endpoints);

/**
 * Admin API documentation page
 */
export const adminApiDocsPage = (
  session: AdminSession,
  publicEndpoints: EndpointDoc[],
  adminEndpoints: EndpointDoc[],
): string =>
  String(
    <Layout title={t("api_keys.docs_title")}>
      <AdminNav active="/admin/users" session={session} />
      <div class="stack-md column">
        <div class="prose">
          <h3>{t("api_keys.authentication")}</h3>
          <p>
            Admin API endpoints require authentication via API key or session
            cookie:
          </p>
        </div>
        <pre>
          <code>Authorization: Bearer YOUR_API_KEY</code>
        </pre>
        <p>
          Public API endpoints require no authentication. All responses are
          JSON.
        </p>
      </div>

      <div class="stack-md column">
        <div class="prose">
          <h3>{t("api_keys.public_api")}</h3>
          <p>{t("api_keys.public_api_note")}</p>
        </div>
        <Raw html={EndpointList({ endpoints: publicEndpoints })} />
      </div>

      <div class="stack-md column">
        <div class="prose">
          <h3>{t("api_keys.admin_api")}</h3>
          <p>
            Requires <code>Authorization: Bearer YOUR_API_KEY</code> header.
          </p>
        </div>
        <Raw html={EndpointList({ endpoints: adminEndpoints })} />
      </div>
    </Layout>,
  );
