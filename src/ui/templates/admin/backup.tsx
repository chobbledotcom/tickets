/**
 * Admin backup/restore page template
 */

import { t } from "#i18n";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideLink, SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

export type BackupEntry = {
  filename: string;
  /** Friendly, timezone-aware datetime label, e.g. "Monday 15 January 2024 at 12:30 UTC" */
  label: string;
  /** Human-readable file size, e.g. "1MB" */
  sizeLabel: string;
};

export type BackupPageState = {
  backups: BackupEntry[];
  encryptionKey: string;
  isRemote: boolean;
  /** Maximum backups retained before the oldest is purged */
  maxBackups: number;
  storageEnabled: boolean;
};

/** Summary note: how many backups exist and when the oldest will be purged. */
const RetentionNote = ({
  backups,
  maxBackups,
}: {
  backups: BackupEntry[];
  maxBackups: number;
}): JSX.Element => {
  const count = backups.length;
  const remaining = maxBackups - count;
  const oldest = backups[count - 1]!.label;
  return (
    <div class="prose">
      <p>
        {t("backup.retention_count", { count })}
        {t("backup.retention_kept", { maxBackups })}
        {remaining > 0
          ? t("backup.retention_remaining", { remaining })
          : t("backup.retention_purge", { oldest })}
      </p>
    </div>
  );
};

export const adminBackupPage = (
  session: AdminSession,
  state: BackupPageState,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title={t("backup.page_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <div class="prose">
        <h1>{t("backup.heading")}</h1>
        <p class="actions">
          <GuideLink href="/admin/guide#backups">
            {t("backup.guide_link")}
          </GuideLink>
        </p>
      </div>
      <Flash error={error} success={success} />

      {!state.isRemote && (
        <p>
          <em>{t("backup.local_database_warning")}</em>
        </p>
      )}

      {!state.storageEnabled && (
        <p>
          <em>{t("backup.storage_not_configured")}</em>
        </p>
      )}

      <section>
        <div class="prose">
          <h2>{t("backup.encryption_key_heading")}</h2>
          <p>{t("backup.encryption_key_description")}</p>
        </div>
        <pre>
          <code>{state.encryptionKey}</code>
        </pre>
      </section>

      {state.storageEnabled && (
        <>
          <section>
            <div class="prose">
              <h2>{t("backup.create_backup_heading")}</h2>
              <p>{t("backup.create_backup_description")}</p>
            </div>
            <CsrfForm
              action="/admin/backup/create"
              class="no-bg"
              id="backup-create"
            >
              <SubmitButton icon="plus">
                {t("backup.create_button")}
              </SubmitButton>
            </CsrfForm>
          </section>

          <section>
            <h2>{t("backup.existing_backups_heading")}</h2>
            {state.backups.length === 0 ? (
              <p>
                <em>{t("backup.no_backups_found")}</em>
              </p>
            ) : (
              <>
                <RetentionNote
                  backups={state.backups}
                  maxBackups={state.maxBackups}
                />
                <table>
                  <thead>
                    <tr>
                      <th>{t("common.created")}</th>
                      <th>{t("backup.table_size")}</th>
                      <th>{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.backups.map((b) => (
                      <tr>
                        <td>{b.label}</td>
                        <td>{b.sizeLabel}</td>
                        <td>
                          <a href={`/admin/backup/download/${b.filename}`}>
                            {t("backup.download_link")}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section>
            <div class="prose">
              <h2>{t("backup.restore_heading")}</h2>
              <p>
                <Raw html={t("backup.restore_warning")} />
              </p>
            </div>
            <CsrfForm
              action="/admin/backup/restore"
              enctype="multipart/form-data"
              id="backup-restore"
            >
              <label>
                {t("backup.backup_file_label")}
                <input accept=".zip" name="backup_file" required type="file" />
              </label>
              <SubmitButton icon="rotate-ccw">
                {t("backup.upload_button")}
              </SubmitButton>
            </CsrfForm>
          </section>
        </>
      )}
    </Layout>,
  );

export const RESTORE_CONFIRM_PHRASE =
  "This will restore my whole database to an earlier state. Existing info will be lost. I understand that this is dangerous.";

export const adminRestoreConfirmPage = (
  session: AdminSession,
  filename: string,
  lineCount: number,
  error?: string,
  schemaMismatch?: boolean,
): string =>
  String(
    <Layout title={t("backup.confirm_restore_title")}>
      <AdminNav active="/admin/settings" session={session} />
      <ConfirmForm
        action="/admin/backup/restore/confirm"
        buttonText={t("backup.restore_button")}
        hiddenFields={{ backup_filename: filename }}
        id="backup-restore-confirm"
        label={t("backup.confirmation_label")}
        name={RESTORE_CONFIRM_PHRASE}
      >
        <h1>{t("backup.confirm_restore_heading")}</h1>
        <Flash error={error} />

        {schemaMismatch && (
          <div class="error" role="alert">
            <Raw html={t("backup.schema_mismatch_warning")} />
          </div>
        )}
        <p>
          <Raw html={t("backup.restore_confirmation_intro", { lineCount })} />
        </p>
        <ul>
          <li>{t("backup.restore_step_drop_tables")}</li>
          <li>{t("backup.restore_step_recreate_schema")}</li>
          <li>{t("backup.restore_step_import_data")}</li>
        </ul>
        <p>
          <Raw html={t("backup.restore_cannot_undo")} />{" "}
          <code>{RESTORE_CONFIRM_PHRASE}</code> {t("backup.restore_type_below")}
        </p>
      </ConfirmForm>
    </Layout>,
  );
