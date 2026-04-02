/**
 * Admin update page template — check for and apply updates
 */

import { CsrfForm, Flash } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";
import { GITHUB_RELEASES_URL } from "#lib/update.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

export type UpdatePageState = {
  buildDate: string;
  buildCommit: string;
  latestVersion: string;
  latestVersionName: string;
  updateAvailable: boolean;
  bunnyConfigured: boolean;
};

/** Current build info section */
const CurrentVersion = ({ state }: { state: UpdatePageState }): JSX.Element => (
  <section>
    <div class="prose">
      <h2>Current Version</h2>
      <p>
        <strong>Built:</strong> {state.buildDate}
      </p>
      {state.buildCommit && (
        <p>
          <strong>Commit:</strong> <code>{state.buildCommit}</code>
        </p>
      )}
    </div>
  </section>
);

/** Check for updates form */
const CheckForUpdates = (): JSX.Element => (
  <CsrfForm action="/admin/update/check" id="update-check">
    <button type="submit">Check for Updates</button>
  </CsrfForm>
);

/** Update available section with deploy button */
const UpdateAvailable = ({
  state,
}: {
  state: UpdatePageState;
}): JSX.Element => (
  <section>
    <div class="prose">
      <h2>Update Available</h2>
      <p>
        A new version is available: <strong>{state.latestVersionName}</strong> (
        {state.latestVersion})
      </p>
    </div>
    {state.bunnyConfigured ? (
      <CsrfForm action="/admin/update" id="update-deploy" class="no-bg">
        <button type="submit">Update Now</button>
      </CsrfForm>
    ) : (
      <p>
        <em>
          Cannot update automatically: BUNNY_API_KEY and BUNNY_SCRIPT_ID
          environment variables are required.
        </em>
      </p>
    )}
  </section>
);

/** No update available section */
const UpToDate = ({
  latestVersion,
}: {
  latestVersion: string;
}): JSX.Element => (
  <section>
    <div class="prose">
      <h2>No Update Available</h2>
      <p>You are running the latest version (checked: {latestVersion}).</p>
    </div>
  </section>
);

export const adminUpdatePage = (
  session: AdminSession,
  state: UpdatePageState,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Update">
      <AdminNav session={session} active="/admin/settings" />

      <Flash error={error} success={success} />

      <h2>Software Update</h2>

      <CurrentVersion state={state} />

      {state.updateAvailable ? (
        <UpdateAvailable state={state} />
      ) : state.latestVersion ? (
        <UpToDate latestVersion={state.latestVersion} />
      ) : null}

      <CheckForUpdates />

      <p>
        <a href={GITHUB_RELEASES_URL}>Click here to read the release notes</a>
      </p>
    </Layout>,
  );
