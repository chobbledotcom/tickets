import { htmlResponse, redirect } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms.tsx";
import { type ValidationResult, validateForm } from "#shared/forms.tsx";
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";

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
    : { error: result.error, ok: false };
};

export const selectedRecalculationFields = <T extends string>(
  form: FormParams,
  allowed: readonly T[],
): T[] => {
  const selected = new Set(form.getAll(RECALCULATE_FIELD_NAME));
  return allowed.filter((field) => selected.has(field));
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
  fields: readonly T[];
  /** Re-render the recalculate page with the "choose a field" error. */
  renderChoose: () => Response | Promise<Response>;
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
