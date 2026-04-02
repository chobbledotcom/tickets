/**
 * Admin builder page template — create new Tickets instances
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

export type BuiltSiteDisplay = {
  name: string;
  bunnyUrl: string;
  created: string;
};

/** Form to create a new site */
const BuilderForm = (): JSX.Element => (
  <section>
    <div class="prose">
      <h2>Create New Site</h2>
      <p>
        This will create a new Tickets instance as a Bunny edge script, copy
        host configuration, and configure the database.
      </p>
    </div>
    <CsrfForm action="/admin/builder" id="builder-form">
      <label for="site_name">
        Site Name
        <input
          type="text"
          id="site_name"
          name="site_name"
          required
          placeholder="My Event Site"
          minlength={1}
          maxlength={64}
        />
      </label>
      <label for="db_url">
        Database URL
        <input
          type="url"
          id="db_url"
          name="db_url"
          required
          placeholder="libsql://your-db.turso.io"
        />
      </label>
      <label for="db_token">
        Database Token
        <input
          type="password"
          id="db_token"
          name="db_token"
          required
          placeholder="Token for the database"
        />
      </label>
      <button type="submit">Build Site</button>
    </CsrfForm>
  </section>
);

/** Table showing previously built sites */
const BuiltSitesTable = ({
  sites,
}: {
  sites: BuiltSiteDisplay[];
}): JSX.Element =>
  sites.length === 0 ? (
    <p>
      <em>No sites have been built yet.</em>
    </p>
  ) : (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>URL</th>
          <th>Built</th>
        </tr>
      </thead>
      <tbody>
        {sites.map((site) => (
          <tr>
            <td>{site.name}</td>
            <td>
              <a href={site.bunnyUrl} target="_blank" rel="noopener">
                {site.bunnyUrl}
              </a>
            </td>
            <td>{site.created}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

export const adminBuilderPage = (
  session: AdminSession,
  sites: BuiltSiteDisplay[],
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Site Builder">
      <AdminNav session={session} active="/admin/settings" />

      {error && (
        <div class="error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div class="success" role="alert">
          {success}
        </div>
      )}

      <h2>Site Builder</h2>

      <BuilderForm />

      <section>
        <div class="prose">
          <h2>Built Sites</h2>
        </div>
        <BuiltSitesTable sites={sites} />
      </section>
    </Layout>,
  );
