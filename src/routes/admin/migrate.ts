/**
 * Admin database migration route — migrates attendees from per-field
 * encryption to consolidated PII blob + plaintext status columns.
 * Owner-only access. Processes in manual batches of 100.
 */

import {
  getMigrationProgress,
  MIGRATE_BATCH_SIZE,
  migrateAttendeeBatch,
} from "#lib/db/attendees.ts";
import {
  isAttendeeBlobMigrated,
  setAttendeeBlobMigrated,
} from "#lib/db/settings.ts";
import { requirePrivateKey } from "#routes/admin/utils.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import type { AuthSession } from "#routes/utils.ts";
import {
  htmlResponse,
  redirectResponse,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import { adminMigratePage } from "#templates/admin/migrate.tsx";

/** Run handler only when migration is incomplete; return doneResponse otherwise */
const whenNotMigrated =
  (doneResponse: (session: AuthSession) => Response | Promise<Response>) =>
  (handler: (session: AuthSession) => Promise<Response>) =>
  async (session: AuthSession): Promise<Response> => {
    const migrated = await isAttendeeBlobMigrated();
    if (migrated) return doneResponse(session);
    return handler(session);
  };

/**
 * Handle GET /admin/migrate — show migration status page
 */
const handleMigrateGet: TypedRouteHandler<"GET /admin/migrate"> = (request) =>
  requireOwnerOr(
    request,
    whenNotMigrated((session) =>
      htmlResponse(adminMigratePage(session, { done: true })),
    )(async (session) => {
      const progress = await getMigrationProgress();
      return htmlResponse(
        adminMigratePage(session, {
          done: false,
          total: progress.total,
          remaining: progress.remaining,
          batchSize: MIGRATE_BATCH_SIZE,
        }),
      );
    }),
  );

/**
 * Handle POST /admin/migrate — process one batch of attendees
 */
const handleMigratePost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(
    request,
    whenNotMigrated(() => redirectResponse("/admin/migrate"))(
      async (session) => {
        const privateKey = await requirePrivateKey(session);
        const result = await migrateAttendeeBatch(privateKey);
        if (result.remaining === 0) await setAttendeeBlobMigrated();
        return redirectResponse("/admin/migrate");
      },
    ),
  );

/** Migration routes */
export const migrateRoutes = defineRoutes({
  "GET /admin/migrate": handleMigrateGet,
  "POST /admin/migrate": handleMigratePost,
});
