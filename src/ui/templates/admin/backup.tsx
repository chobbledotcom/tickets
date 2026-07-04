/**
 * Admin backup/restore page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { CsrfForm } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { GuideLink, SubmitButton } from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { ErrorAlert } from "#templates/components/error-alert.tsx";
/* jscpd:ignore-end */

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
  flashAdminPage(t("backup.page_title"))(session, error, success)(
    <>
      <div class="prose">
        <h1>{t("backup.heading")}</h1>
        <p class="actions">
          <GuideLink href="/admin/guide#backups">
            {t("backup.guide_link")}
          </GuideLink>
        </p>
      </div>

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
                <DataTable
                  columns={[
                    { header: t("common.created") },
                    { header: t("backup.table_size") },
                    { class: "actions", header: t("common.actions") },
                  ]}
                  rows={state.backups.map((b) => [
                    b.label,
                    b.sizeLabel,
                    <a href={`/admin/backup/download/${b.filename}`}>
                      {t("backup.download_link")}
                    </a>,
                  ])}
                />
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
    </>,
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
  ConfirmPage({
    action: "/admin/backup/restore/confirm",
    active: "/admin/settings",
    buttonText: t("backup.restore_button"),
    children: (
      <>
        <h1>{t("backup.confirm_restore_heading")}</h1>
        {schemaMismatch && (
          <ErrorAlert message={t("backup.schema_mismatch_warning")} />
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
      </>
    ),
    error,
    hiddenFields: { backup_filename: filename },
    id: "backup-restore-confirm",
    label: t("backup.confirmation_label"),
    name: RESTORE_CONFIRM_PHRASE,
    session,
    title: t("backup.confirm_restore_title"),
  });
