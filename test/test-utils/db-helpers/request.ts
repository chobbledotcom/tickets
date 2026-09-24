/** Post a signed-in form and hand the resulting DB state to the caller once
 *  the request redirects (a non-redirect response means the submission was
 *  rejected, so it throws with the caller's error context). Shared by every
 *  admin create/update/delete test helper below. */
import { handleRequest } from "#routes";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockFormRequest, mockMultipartRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

async function doAuthenticatedRequest<T>(
  path: string,
  formData: TestFormValues,
  buildRequest: (path: string, data: TestFormValues, cookie: string) => Request,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> {
  const session = await getTestSession();
  const response = await handleRequest(
    buildRequest(
      path,
      { ...formData, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
  if (response.status !== 302) {
    throw new Error(`Failed to ${errorContext}: ${response.status}`);
  }
  return onSuccess();
}

/** The two helpers below, spelled out once: sign in, post the caller's form
 * data, and return whatever the caller's success read produced. */
type AuthenticatedFormRequest = <T>(
  path: string,
  formData: TestFormValues,
  onSuccess: () => Promise<T>,
  errorContext: string,
) => Promise<T>;

/** The shared post-and-read shape behind both senders below: sign in, post
 * the form the given builder packs, and read the DB state it left. */
const doAuthenticatedRequestWith =
  (
    buildRequest: (
      path: string,
      data: TestFormValues,
      cookie: string,
    ) => Request,
  ): AuthenticatedFormRequest =>
  (path, formData, onSuccess, errorContext) =>
    doAuthenticatedRequest(
      path,
      formData,
      buildRequest,
      onSuccess,
      errorContext,
    );

export const doAuthenticatedFormRequest: AuthenticatedFormRequest =
  doAuthenticatedRequestWith(mockFormRequest);

export const doAuthenticatedMultipartFormRequest: AuthenticatedFormRequest =
  doAuthenticatedRequestWith(mockMultipartRequest);
