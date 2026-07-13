/**
 * Admin update page template — check for and apply updates
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { GITHUB_RELEASES_URL } from "#shared/update.ts";
import { flashDataPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { ProseSection } from "#templates/components/prose-section.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
/* jscpd:ignore-end */

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
  <ProseSection title={t("update.current_version")}>
    <p>
      <strong>{t("update.built")}:</strong> {state.buildDate}
    </p>
    {state.buildCommit && (
      <p>
        <strong>{t("update.commit")}:</strong> <code>{state.buildCommit}</code>
      </p>
    )}
  </ProseSection>
);

/** Check for updates form */
const CheckForUpdates = (): JSX.Element => (
  <SaveForm
    action="/admin/update/check"
    id="update-check"
    submitIcon="rotate-ccw"
    submitLabel={t("update.check_for_updates")}
  />
);

/** Update available section with deploy button */
const UpdateAvailable = ({
  state,
}: {
  state: UpdatePageState;
}): JSX.Element => (
  <ProseSection
    footer={
      state.providerConfigured ? (
        <SaveForm
          action="/admin/update"
          class="no-bg"
          id="update-deploy"
          submitIcon="rotate-ccw"
          submitLabel={t("update.update_now")}
        />
      ) : (
        <p>
          <em>{t("update.cannot_update_automatically")}</em>
        </p>
      )
    }
    title={t("update.update_available")}
  >
    <p>
      <Raw
        html={t("update.new_version", {
          tag: state.latestVersion,
          version: state.latestVersionName,
        })}
      />
    </p>
  </ProseSection>
);

/** No update available section */
const UpToDate = ({
  latestVersion,
}: {
  latestVersion: string;
}): JSX.Element => (
  <ProseSection title={t("update.no_update_available")}>
    <p>{t("update.running_latest", { version: latestVersion })}</p>
  </ProseSection>
);

export const adminUpdatePage = flashDataPage<UpdatePageState>(
  t("update.page_title"),
  "/admin/update",
  (state) => (
    <>
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

      <GuideFooter href="/admin/guide#software-updates">
        {t("update.guide_link")}
      </GuideFooter>
    </>
  ),
);
