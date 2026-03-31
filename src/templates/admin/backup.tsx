/**
 * Admin backup/restore page template
 */

import { CsrfForm, renderError, renderSuccess } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

export type BackupEntry = {
  filename: string;
  timestamp: string;
};

export type BackupPageState = {
  backups: BackupEntry[];
  encryptionKey: string;
  isRemote: boolean;
  storageEnabled: boolean;
};

export const adminBackupPage = (
  session: AdminSession,
  state: BackupPageState,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Database Backup">
      <AdminNav session={session} active="/admin/backup" />
      <h1>Database Backup &amp; Restore</h1>
      <Raw html={renderError(error)} />
      <Raw html={renderSuccess(success)} />

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
            <CsrfForm action="/admin/backup/create" id="backup-create">
              <button type="submit">Create Backup Now</button>
            </CsrfForm>
          </section>

          <section>
            <h2>Existing Backups</h2>
            {state.backups.length === 0
              ? (
                <p>
                  <em>No backups found.</em>
                </p>
              )
              : (
                <table>
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.backups.map((b) => (
                      <tr>
                        <td>{b.timestamp}</td>
                        <td>
                          <a href={`/admin/backup/download/${b.filename}`}>
                            Download
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>

          <section>
            <h2>Restore from Backup</h2>
            <p>
              <strong>Warning:</strong>{" "}
              Restoring will delete all current data and replace it with the
              backup contents. This cannot be undone.
            </p>
            <CsrfForm
              action="/admin/backup/restore"
              id="backup-restore"
              enctype="multipart/form-data"
            >
              <label>
                Backup file (.zip)
                <input type="file" name="backup_file" accept=".zip" required />
              </label>
              <button type="submit">Upload &amp; Review</button>
            </CsrfForm>
          </section>
        </>
      )}
    </Layout>,
  );

export const RESTORE_CONFIRM_PHRASE = "RESTORE DATABASE";

export const adminRestoreConfirmPage = (
  session: AdminSession,
  filename: string,
  lineCount: number,
  error?: string,
): string =>
  String(
    <Layout title="Confirm Restore">
      <AdminNav session={session} active="/admin/backup" />
      <Breadcrumb href="/admin/backup" label="Backup" />
      <h1>Confirm Database Restore</h1>
      {renderError(error)}

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

      <CsrfForm
        action="/admin/backup/restore/confirm"
        id="backup-restore-confirm"
      >
        <input type="hidden" name="backup_filename" value={filename} />
        <label>
          Confirmation phrase
          <input
            type="text"
            name="confirm_identifier"
            placeholder={RESTORE_CONFIRM_PHRASE}
            required
          />
        </label>
        <button type="submit">Restore Database</button>
      </CsrfForm>
    </Layout>,
  );
