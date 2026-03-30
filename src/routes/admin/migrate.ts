/**
 * Admin database migration route — migrates attendees from per-field
 * encryption to consolidated PII blob + plaintext status columns.
 * Accessible to owners and managers. Processes in manual batches of 100.
 */

import {
  getMigrationProgress,
  MIGRATE_BATCH_SIZE,
  migrateAttendeeBatch,
} from "#lib/db/attendees.ts";
import { settings } from "#lib/db/settings.ts";
import { requirePrivateKey } from "#routes/admin/utils.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  AUTH_FORM,
  type AuthSession,
  htmlResponse,
  redirect,
  redirectResponse,
  requireSessionOr,
  withAuth,
} from "#routes/utils.ts";
import { adminMigratePage } from "#templates/admin/migrate.tsx";

/** Run handler only when migration is incomplete; redirect to dashboard otherwise */
const whenNotMigrated =
  (handler: (session: AuthSession) => Promise<Response>) =>
  (session: AuthSession): Response | Promise<Response> => {
    if (settings.attendeeBlobMigrated) return redirectResponse("/admin/");
    return handler(session);
  };

/**
 * Handle GET /admin/migrate — show migration status page
 */
const handleMigrateGet: TypedRouteHandler<"GET /admin/migrate"> = (request) =>
  requireSessionOr(
    request,
    whenNotMigrated(async (session) => {
      const progress = await getMigrationProgress();
      // Auto-complete: fresh DBs and fully-migrated DBs have 0 remaining
      if (progress.remaining === 0) {
        await settings.update.attendeeBlobMigrated();
        return redirectResponse("/admin/");
      }
      return htmlResponse(
        adminMigratePage(session, {
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
  withAuth(
    request,
    AUTH_FORM,
    whenNotMigrated(async (session) => {
      const privateKey = await requirePrivateKey(session);
      const result = await migrateAttendeeBatch(privateKey);
      if (result.remaining === 0) {
        await settings.update.attendeeBlobMigrated();
        return redirect(
          "/admin/",
          "Migration complete. All attendee records have been upgraded.",
          true,
        );
      }
      return redirectResponse("/admin/migrate");
    }),
  );

/** Migration routes */
export const migrateRoutes = defineRoutes({
  "GET /admin/migrate": handleMigrateGet,
  "POST /admin/migrate": handleMigratePost,
});
