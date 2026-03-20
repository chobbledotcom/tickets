/**
 * Admin API keys page template
 */

import { map, pipe, reduce } from "#fp";
import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
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
        <CsrfForm
          action={`/admin/api-keys/${apiKey.id}/delete`}
          class="one-button"
        >
          <button type="submit" class="danger small">
            Delete
          </button>
        </CsrfForm>
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
      <AdminNav session={adminSession} active="/admin/api-keys" />

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
        <fieldset>
          <legend>Create API key</legend>
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
        </fieldset>
      </CsrfForm>
    </Layout>,
  );
};
