/**
 * Admin backup/restore page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { flashDataPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
/* jscpd:ignore-end */

export type BackupEntry = {
  filename: string;
  /** Friendly, timezone-aware datetime label, e.g. "Monday 15 January 2024 at 12:30 UTC" */
  label: string;
  /** Human-readable file size, e.g. "1MB" */
  sizeLabel: string;
  /** Raw UTC timestamp exactly as it appears in the backup's filename,
   *  e.g. "2024-01-15T12-30-00-000Z" — the backup's unambiguous identifier. */
  timestamp: string;
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

export const adminBackupPage = flashDataPage<BackupPageState>(
  "backup.page_title",
  "/admin/backup",
  (state) => (
    <>
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
            <SaveForm
              action="/admin/backup/create"
              class="no-bg"
              id="backup-create"
              submitIcon="plus"
              submitLabel={t("backup.create_button")}
            />
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
                    { header: t("backup.table_timestamp") },
                    { header: t("backup.table_size") },
                    { class: "actions", header: t("common.actions") },
                  ]}
                  rows={state.backups.map((b) => [
                    b.label,
                    <code>{b.timestamp}</code>,
                    b.sizeLabel,
                    <a href={`/admin/backup/download/${b.filename}`}>
                      {t("backup.download_link")}
                    </a>,
                  ])}
                />
              </>
            )}
          </section>
        </>
      )}
      <section>
        <div class="prose">
          <h2>{t("backup.restore_heading")}</h2>
          <Raw html={t("backup.restore_console_description")} />
        </div>
      </section>
      <GuideFooter href="/admin/guide#backups">
        {t("backup.guide_link")}
      </GuideFooter>
    </>
  ),
);
