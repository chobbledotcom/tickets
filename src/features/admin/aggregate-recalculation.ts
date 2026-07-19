/* jscpd:ignore-start */

import * as v from "valibot";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { readRepeatedPicklist } from "#shared/forms/repeated-picklist.ts";
import {
  type ValidationResult,
  validateForm,
} from "#shared/forms/validation.ts";
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { errorResult } from "#shared/result.ts";
import type { AdminSession } from "#shared/types.ts";

/* jscpd:ignore-end */

type AggregateParseResult<T> =
  | { input: T | null; ok: true }
  | { error: string; ok: false };

export const parseEditableAggregateForm = <TValues, TInput>(
  form: FormParams,
  fields: Field[],
  toInput: (values: TValues) => TInput,
): AggregateParseResult<TInput> => {
  if (!fields.some((field) => form.has(field.name))) {
    return { input: null, ok: true };
  }
  const result: ValidationResult<TValues> = validateForm<TValues>(form, fields);
  return result.valid
    ? { input: toInput(result.values), ok: true }
    : errorResult(result.error);
};

export const selectedRecalculationFields = <T extends string>(
  form: FormParams,
  allowed: readonly [T, ...T[]],
): T[] => {
  const selection = readRepeatedPicklist(
    v.picklist(allowed),
    form,
    RECALCULATE_FIELD_NAME,
  );
  if (selection.state === "invalid") {
    throw new Error(`Invalid recalculation field: ${selection.value}`);
  }
  return selection.state === "selected" ? selection.values : [];
};

/**
 * The shared aggregate-recalculation POST flow, identical for listings,
 * modifiers, and answers: read the selected fields, re-render the page with a
 * "choose a field" message when none are ticked, otherwise reset those
 * aggregates, log the action, and redirect to the entity's edit page. Each
 * caller supplies the parts that differ as closures over its loaded entity, so
 * the divergent auth/load wrappers stay at the call site.
 */
export const runRecalculatePost = async <T extends string>(config: {
  form: FormParams;
  fields: readonly [T, ...T[]];
  /** Re-render the recalculate page with the "choose a field" error. */
  renderChoose: ResponseHandler;
  reset: (selected: T[]) => Promise<unknown>;
  log: () => Promise<unknown>;
  successPath: string;
  successMessage: string;
}): Promise<Response> => {
  const selected = selectedRecalculationFields(config.form, config.fields);
  if (selected.length === 0) return config.renderChoose();
  await config.reset(selected);
  await config.log();
  return redirect(config.successPath, config.successMessage, true);
};

type RecalculatePage<TEntity, TSnapshot, TSession> = (
  entity: TEntity,
  snapshot: TSnapshot,
  session: TSession,
  error?: string,
  success?: string,
) => string;

export const createRecalculatePageRenderer =
  <TEntity, TSnapshot, TSession>(
    snapshot: (entity: TEntity) => Promise<TSnapshot>,
    page: RecalculatePage<TEntity, TSnapshot, TSession>,
  ) =>
  async (
    entity: TEntity,
    session: TSession,
    error?: string,
    success?: string,
  ): Promise<Response> =>
    htmlResponse(
      page(entity, await snapshot(entity), session, error, success),
      error ? 400 : 200,
    );

/**
 * Build the GET + POST route handlers for one entity's aggregate-recalculation
 * page — identical for listings and modifiers: GET loads the entity and renders
 * the page with the current flash; POST runs {@link runRecalculatePost} against
 * it. Each caller supplies its own id-keyed loader (404 when the id is missing
 * or unknown), field set, reset step, and the bits that vary by entity kind
 * (the logged line, the success redirect).
 */
export const createRecalculateHandlers = <T, F extends string, ID>(config: {
  withEntity: (
    id: ID,
  ) => (handler: ResponseHandler<[entity: T]>) => Promise<Response>;
  render: (
    entity: T,
    session: AdminSession,
    error?: string,
    success?: string,
  ) => Promise<Response>;
  fields: readonly [F, ...F[]];
  entityId: (entity: T) => number;
  reset: (entityId: number, selected: F[]) => Promise<unknown>;
  log: (entity: T) => Promise<unknown>;
  successPath: (entity: T) => string;
  successMessage: string;
  chooseMessage: string;
}): {
  get: (request: Request, id: ID) => Promise<Response>;
  post: (request: Request, id: ID) => Promise<Response>;
} => ({
  get: (request, id) =>
    requireSessionOr(request, (session) =>
      config.withEntity(id)((entity) => {
        const flash = getFlash();
        return config.render(entity, session, flash.error, flash.success);
      }),
    ),
  post: (request, id) =>
    withAuth(request, AUTH_FORM, (session, form) =>
      config.withEntity(id)((entity) =>
        runRecalculatePost({
          fields: config.fields,
          form,
          log: () => config.log(entity),
          renderChoose: () =>
            config.render(entity, session, config.chooseMessage),
          reset: (selected) => config.reset(config.entityId(entity), selected),
          successMessage: config.successMessage,
          successPath: config.successPath(entity),
        }),
      ),
    ),
});
