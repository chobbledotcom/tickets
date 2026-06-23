/**
 * Shared owner-only handler for a manual money correction (decision 14).
 *
 * The listing-income and modifier-revenue adjustment forms are the same shape: an
 * owner submits a corrected figure, and the difference from the *current*
 * projection is posted as a `writeoff` adjustment leg (never external cash).
 * This curries the one differing bit — which entity, field, projection, poster,
 * and messages — out of the common parse → load → compute-delta → post → log →
 * redirect flow, so both call sites share it (no per-form boilerplate, no jscpd
 * duplication). Owner-only and CSRF/form-authed, like the other admin mutations.
 */

import { OWNER_FORM, withAuth } from "#routes/auth.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { FormParams } from "#shared/form-data.ts";

/** Configuration for one entity's money-correction handler. */
type MoneyAdjustConfig<Entity> = {
  /** Load the entity (with its projected figure) by id, or null when missing. */
  load: (id: number) => Promise<Entity | null>;
  /** The form field carrying the new value (major units). */
  field: string;
  /** The entity's current projected figure (minor units). */
  current: (entity: Entity) => number;
  /** Post a `writeoff` adjustment moving the figure from current → target. */
  adjust: (entity: Entity, current: number, target: number) => Promise<void>;
  /** Neutral activity-log message (no raw figures). */
  logMessage: (entity: Entity) => string;
  /** Flash message on success. */
  successMessage: string;
  /** Edit-page path to redirect back to. */
  editPath: (id: number) => string;
};

/** Parse a money field in major units to minor units. Blank or non-finite input
 * is rejected (null); a finite value — including a negative, which a modifier's
 * net revenue can legitimately be — converts to integer minor units. */
const parseMoneyField = (form: FormParams, field: string): number | null => {
  const raw = form.getString(field).trim();
  if (raw === "") return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? toMinorUnits(parsed) : null;
};

/**
 * Build the POST handler for one entity's money correction. Owner-only; loads the
 * entity, parses the new figure, posts the delta as a `writeoff` adjustment, logs
 * a neutral message, and redirects back to the edit page with a success flash.
 */
export const makeMoneyAdjustHandler =
  <Entity>(config: MoneyAdjustConfig<Entity>) =>
  (request: Request, id: number): Promise<Response> =>
    withAuth(request, OWNER_FORM, async (_session, form) => {
      const entity = await config.load(id);
      if (!entity) return notFoundResponse();
      const target = parseMoneyField(form, config.field);
      if (target === null) {
        return errorRedirect(config.editPath(id), "Enter a valid amount");
      }
      await config.adjust(entity, config.current(entity), target);
      await logActivity(config.logMessage(entity));
      return redirect(config.editPath(id), config.successMessage, true);
    });
