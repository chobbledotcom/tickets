import type { FormParams } from "#lib/form-data.ts";
import type { ValidationResult } from "#lib/forms.tsx";
import { AUTH_FORM, type AuthSession, withAuth } from "#routes/auth.ts";

export type FormValidator<TValues> = {
  validate: (form: FormParams) => ValidationResult<TValues>;
};

type FormRouteConfig<TValues, TParams> = {
  form: FormValidator<TValues>;
  onInvalid: (
    error: string,
    params: TParams,
    session: AuthSession,
    form: FormParams,
  ) => Response | Promise<Response>;
  onValid: (args: {
    form: FormParams;
    params: TParams;
    session: AuthSession;
    values: TValues;
  }) => Response | Promise<Response>;
};

/** Require auth, validate a typed form, then dispatch to invalid/valid handlers. */
export const createAuthedFormRoute =
  <TValues, TParams>(config: FormRouteConfig<TValues, TParams>) =>
  (request: Request, params: TParams) =>
    withAuth(request, AUTH_FORM, (session, form) => {
      const result = config.form.validate(form);
      if (!result.valid) {
        return config.onInvalid(result.error, params, session, form);
      }
      return config.onValid({ form, params, session, values: result.values });
    });
