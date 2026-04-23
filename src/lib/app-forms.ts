import type { FormParams } from "#lib/form-data.ts";
import type { ValidationResult } from "#lib/forms.tsx";
import {
  AUTH_FORM,
  type AuthPolicy,
  type AuthSession,
  withAuth,
} from "#routes/auth.ts";
import { notFoundResponse } from "#routes/response.ts";

export type FormValidator<TValues> = {
  validate: (form: FormParams) => ValidationResult<TValues>;
};

type HandlerArgs<TValues, TParams, TContext> = {
  context: TContext;
  form: FormParams;
  params: TParams;
  session: AuthSession;
  values: TValues;
};

type InvalidArgs<TParams, TContext> = {
  context: TContext;
  error: string;
  form: FormParams;
  params: TParams;
  session: AuthSession;
};

type FormRouteConfig<TValues, TParams, TContext> = {
  /** Auth policy (default AUTH_FORM). Use OWNER_FORM for owner-only routes. */
  auth?: AuthPolicy<"form">;
  /** Load context before validation. Returning null yields a 404. */
  loadContext?: (
    params: TParams,
    session: AuthSession,
  ) => Promise<TContext | null>;
  /** Mutate the form before validation (demo overrides, secret triage, etc.). */
  preprocessForm?: (form: FormParams, context: TContext) => void;
  /** Form validator — static, or built from the loaded context. */
  form:
    | FormValidator<TValues>
    | ((context: TContext) => FormValidator<TValues>);
  onInvalid: (
    args: InvalidArgs<TParams, TContext>,
  ) => Response | Promise<Response>;
  onValid: (
    args: HandlerArgs<TValues, TParams, TContext>,
  ) => Response | Promise<Response>;
};

/** Require auth, optionally load context, validate a typed form, then dispatch. */
export const createAuthedFormRoute =
  <TValues, TParams = Record<string, never>, TContext = void>(
    config: FormRouteConfig<TValues, TParams, TContext>,
  ) =>
  (request: Request, params: TParams) =>
    withAuth<"form">(
      request,
      config.auth ?? AUTH_FORM,
      async (session, form) => {
        const loaded = config.loadContext
          ? await config.loadContext(params, session)
          : (undefined as TContext);
        if (config.loadContext && loaded === null) return notFoundResponse();

        const context = loaded as TContext;
        config.preprocessForm?.(form, context);

        const validator = typeof config.form === "function"
          ? config.form(context)
          : config.form;
        const result = validator.validate(form);

        return result.valid
          ? config.onValid({
            context,
            form,
            params,
            session,
            values: result.values,
          })
          : config.onInvalid({
            context,
            error: result.error,
            form,
            params,
            session,
          });
      },
    );
