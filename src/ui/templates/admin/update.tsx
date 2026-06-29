/**
 * Admin update page template — check for and apply updates
 */

import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { GITHUB_RELEASES_URL } from "#shared/update.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

export type UpdatePageState = {
  buildDate: string;
  buildCommit: string;
  latestVersion: string;
  latestVersionName: string;
  updateAvailable: boolean;
  providerConfigured: boolean;
};

/** Current build info section */
const CurrentVersion = ({ state }: { state: UpdatePageState }): JSX.Element => (
  <section>
    <div class="prose">
      <h2>{t("update.current_version")}</h2>
      <p>
        <strong>{t("update.built")}:</strong> {state.buildDate}
      </p>
      {state.buildCommit && (
        <p>
          <strong>{t("update.commit")}:</strong>{" "}
          <code>{state.buildCommit}</code>
        </p>
      )}
    </div>
  </section>
);

/** Check for updates form */
const CheckForUpdates = (): JSX.Element => (
  <CsrfForm action="/admin/update/check" id="update-check">
    <SubmitButton icon="rotate-ccw">
      {t("update.check_for_updates")}
    </SubmitButton>
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
      <h2>{t("update.update_available")}</h2>
      <p>
        <Raw
          html={t("update.new_version", {
            tag: state.latestVersion,
            version: state.latestVersionName,
          })}
        />
      </p>
    </div>
    {state.providerConfigured ? (
      <CsrfForm action="/admin/update" class="no-bg" id="update-deploy">
        <SubmitButton icon="rotate-ccw">{t("update.update_now")}</SubmitButton>
      </CsrfForm>
    ) : (
      <p>
        <em>{t("update.cannot_update_automatically")}</em>
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
      <h2>{t("update.no_update_available")}</h2>
      <p>{t("update.running_latest", { version: latestVersion })}</p>
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
    <Layout title={t("update.page_title")}>
      <AdminNav active="/admin/settings" session={session} />

      <Flash
        {...(error !== undefined ? { error } : {})}
        {...(success !== undefined ? { success } : {})}
      />

      <h2>{t("update.software_update")}</h2>

      <CurrentVersion state={state} />

      {state.updateAvailable ? (
        <UpdateAvailable state={state} />
      ) : state.latestVersion ? (
        <UpToDate latestVersion={state.latestVersion} />
      ) : null}

      <CheckForUpdates />

      <p>
        <a href={GITHUB_RELEASES_URL}>{t("update.release_notes_link")}</a>
      </p>
    </Layout>,
  );
