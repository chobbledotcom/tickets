/**
 * Shared owner-only handler for a manual money correction (decision 14).
 *
 * The listing-income and modifier-revenue adjustment forms are the same shape:
 * an owner submits a corrected figure, and the difference from the *current*
 * projection posts as a `writeoff` adjustment leg, never external cash. This
 * curries the one differing bit — entity, field, poster, and messages — out of
 * the common parse → load → post → log → redirect flow, so both call sites
 * share it. Owner-only and CSRF/form-authed, like the other admin mutations.
 *
 * The entity is loaded only to confirm it exists and to label the log. The
 * SUBMITTED target goes straight to `adjust`, which recomputes the delta from
 * the current projection read INSIDE its own write transaction. A double-submit
 * is therefore idempotent for a given target: the second recompute already sees
 * the first's adjustment and posts a zero-delta no-op.
 */

import { logActivity } from "#db/activity-log.ts";
import { formGuard, OWNER_FORM } from "#routes/auth.ts";
import { createIdEntityHandler } from "#routes/entity.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { parseSignedMinorUnits } from "#shared/validation/money.ts";

/** Configuration for one entity's money-correction handler. */
type MoneyAdjustConfig<Entity> = {
  /** Load the entity by id (existence check + log label), or null when missing. */
  load: (id: number) => Promise<Entity | null>;
  /** The form field carrying the new value (major units). */
  field: string;
  /** Post a `writeoff` adjustment moving the figure to `target`, recomputing the
   *  delta from the current projection inside its own write transaction. */
  adjust: (entity: Entity, target: number) => Promise<void>;
  /** Neutral activity-log message (no raw figures). */
  logMessage: (entity: Entity) => string;
  /** Flash message on success. */
  successMessage: string;
  /** Edit-page path to redirect back to. */
  editPath: (id: number) => string;
};

/** Build one owner-only money-correction handler on the shared entity route. */
export const makeMoneyAdjustHandler = <Entity>(
  config: MoneyAdjustConfig<Entity>,
): ((request: Request, id: number) => Promise<Response>) => {
  const route = createIdEntityHandler<Entity>(config.load)(
    formGuard(OWNER_FORM),
  )(async (entity, _session, form, _request, { id }) => {
    const target = parseSignedMinorUnits(form.getString(config.field));
    if (target === null) {
      return errorRedirect(config.editPath(id), "Enter a valid amount");
    }
    await config.adjust(entity, target);
    await logActivity(config.logMessage(entity));
    return redirect(config.editPath(id), config.successMessage, true);
  });
  return (request, id) => route(request, { id });
};
