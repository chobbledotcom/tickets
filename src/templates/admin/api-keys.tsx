/**
 * Admin API keys page template
 */

import { map, pipe, reduce } from "#fp";
import type { EndpointDoc } from "#lib/admin-api-example.ts";
import { ConfirmForm, CsrfForm } from "#lib/forms.tsx";
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
          : "Never"}
      </td>
      <td>
        <a href={`/admin/api-keys/${apiKey.id}/delete`} class="danger small">
          Delete
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
      : '<tr><td colspan="4">No API keys</td></tr>';

  return String(
    <Layout title="API Keys">
      <AdminNav session={adminSession} active="/admin/users" />
      <UsersSubNav />

      {opts.error && <div class="error">{opts.error}</div>}
      {opts.success && <div class="success">{opts.success}</div>}

      {opts.newKey && (
        <div class="warning">
          <strong>Copy your API key now — it won't be shown again:</strong>
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
              <th>Name</th>
              <th>Created</th>
              <th>Last used</th>
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
        <h2>Create API key</h2>
        <label>
          Name
          <input
            type="text"
            name="name"
            placeholder="e.g. CI Pipeline"
            required
            maxLength={100}
          />
        </label>
        <button type="submit">Create key</button>
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
): string =>
  String(
    <Layout title={`Delete: ${apiKey.name}`}>
      <AdminNav session={session} active="/admin/users" />

      <ConfirmForm
        action={`/admin/api-keys/${apiKey.id}/delete`}
        name={apiKey.name}
        label="API key name"
        prompt="To delete this API key, type its name"
        buttonText="Delete API Key"
      >
        <article>
          <aside>
            <p>
              <strong>Warning:</strong> This will permanently delete this API
              key. Any integrations using it will stop working immediately.
            </p>
          </aside>
        </article>
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
    <Layout title="API Documentation">
      <AdminNav session={session} active="/admin/users" />
      <UsersSubNav />

      <div class="stack-md column">
        <h3>Authentication</h3>
        <p>
          Admin API endpoints require authentication via API key or session
          cookie:
        </p>
        <pre>
          <code>Authorization: Bearer YOUR_API_KEY</code>
        </pre>
        <p>
          Public API endpoints require no authentication. All responses are
          JSON.
        </p>
      </div>

      <div class="stack-md column">
        <h3>Public API</h3>
        <p>No API key required. All endpoints support CORS.</p>
        <Raw html={EndpointList({ endpoints: publicEndpoints })} />
      </div>

      <div class="stack-md column">
        <h3>Admin API</h3>
        <p>
          Requires <code>Authorization: Bearer YOUR_API_KEY</code> header.
        </p>
        <Raw html={EndpointList({ endpoints: adminEndpoints })} />
      </div>
    </Layout>,
  );
