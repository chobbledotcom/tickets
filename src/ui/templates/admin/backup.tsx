/**
 * Admin backup/restore page template
 */

import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import { GuideLink } from "#templates/components/actions.tsx";
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
        {count === 1 ? "There is 1 backup" : `There are ${count} backups`},
        shown newest first. Up to {maxBackups} are kept —{" "}
        {remaining > 0
          ? `${remaining} more can be created before the oldest is purged.`
          : `the next will purge the oldest (${oldest}).`}
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
    <Layout title="Database Backup">
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />
      <h1>Database Backup &amp; Restore</h1>
      <p class="actions">
        <GuideLink href="/admin/guide#backups">Backup guide</GuideLink>
      </p>
      <Flash error={error} success={success} />

      {!state.isRemote && (
        <p>
          <em>
            Backup and restore is designed for remote databases (libsql://). You
            are currently using a local database.
          </em>
        </p>
      )}

      {!state.storageEnabled && (
        <p>
          <em>
            Storage is not configured. Backups require Bunny CDN or local
            storage to be enabled.
          </em>
        </p>
      )}

      <section>
        <h2>Encryption Key</h2>
        <p>
          You will need this key to restore a backup to a different site. Store
          it securely — it cannot be recovered.
        </p>
        <pre>
          <code>{state.encryptionKey}</code>
        </pre>
      </section>

      {state.storageEnabled && (
        <>
          <section>
            <h2>Create Backup</h2>
            <p>
              Creates a .zip archive containing a .sql file for each database
              table. Backups are not encrypted (the sensitive contents are
              already encrypted at the field level).
            </p>
            <CsrfForm
              action="/admin/backup/create"
              class="no-bg"
              id="backup-create"
            >
              <button type="submit">Create Backup Now</button>
            </CsrfForm>
          </section>

          <section>
            <h2>Existing Backups</h2>
            {state.backups.length === 0 ? (
              <p>
                <em>No backups found.</em>
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
                      <th>Created</th>
                      <th>Size</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.backups.map((b) => (
                      <tr>
                        <td>{b.label}</td>
                        <td>{b.sizeLabel}</td>
                        <td>
                          <a href={`/admin/backup/download/${b.filename}`}>
                            Download
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
            <h2>Restore from Backup</h2>
            <p>
              <strong>Warning:</strong> Restoring will delete all current data
              and replace it with the backup contents. This cannot be undone.
            </p>
            <CsrfForm
              action="/admin/backup/restore"
              enctype="multipart/form-data"
              id="backup-restore"
            >
              <label>
                Backup file (.zip)
                <input accept=".zip" name="backup_file" required type="file" />
              </label>
              <button type="submit">Upload &amp; Review</button>
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
    <Layout title="Confirm Restore">
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />

      <ConfirmForm
        action="/admin/backup/restore/confirm"
        buttonText="Restore Database"
        hiddenFields={{ backup_filename: filename }}
        id="backup-restore-confirm"
        label="Confirmation phrase"
        name={RESTORE_CONFIRM_PHRASE}
      >
        <h1>Confirm Database Restore</h1>
        <Flash error={error} />

        {schemaMismatch && (
          <div class="error" role="alert">
            <strong>Schema mismatch:</strong> This backup was created with a
            different database schema version. The restore will apply current
            migrations after importing data, but some data may be incompatible.
          </div>
        )}
        <p>
          You are about to restore from an uploaded backup containing{" "}
          <strong>{lineCount}</strong> SQL statements. This will:
        </p>
        <ul>
          <li>Drop all existing tables</li>
          <li>Recreate the database schema</li>
          <li>Import all data from the backup</li>
        </ul>
        <p>
          <strong>This action cannot be undone.</strong> Type{" "}
          <code>{RESTORE_CONFIRM_PHRASE}</code> below to confirm.
        </p>
      </ConfirmForm>
    </Layout>,
  );
