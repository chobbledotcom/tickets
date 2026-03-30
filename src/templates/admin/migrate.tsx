/**
 * Admin migration page template — attendee storage optimization
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

type MigratePageState = {
  total: number;
  remaining: number;
  batchSize: number;
};

/**
 * Admin migration page — in-progress view only.
 * When migration is complete or has nothing to do, the route redirects to /admin/.
 */
export const adminMigratePage = (
  session: AdminSession,
  state: MigratePageState,
): string =>
  String(
    <Layout title="Database Migration">
      <AdminNav session={session} active="" />
      <section>
        <div>
          <h2>Database Migration</h2>
          <p>
            We're restructuring the database to improve performance. Attendee
            data will be consolidated into a more efficient format, reducing
            storage by approximately 68%.
          </p>
          <p>
            This requires decrypting and re-encrypting each attendee record.
            Press the button below to process a batch of {state.batchSize}{" "}
            records at a time.
          </p>
        </div>

        <div id="migrate-status">
          <p>
            <strong>
              {state.total - state.remaining} / {state.total}
            </strong>{" "}
            records migrated ({state.remaining} remaining)
          </p>
          {state.total > 0 && (
            <progress value={state.total - state.remaining} max={state.total} />
          )}
        </div>

        <CsrfForm action="/admin/migrate" id="migrate-form" class="inline">
          <button type="submit" id="migrate-btn">
            Process next batch
          </button>
        </CsrfForm>

        <p id="migrate-error" class="error" hidden />
        <p id="migrate-log" />
      </section>
    </Layout>,
  );
