/** Post a signed-in form and hand the resulting DB state to the caller once
 *  the request redirects (a non-redirect response means the submission was
 *  rejected, so it throws with the caller's error context). Shared by every
 *  admin create/update/delete test helper below. */
async function doAuthenticatedRequest<T>(
  path: string,
  formData: Record<string, string>,
  buildRequest: (
    path: string,
    data: Record<string, string>,
    cookie: string,
  ) => Request,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
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

export const doAuthenticatedFormRequest = async <T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> => {
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  return doAuthenticatedRequest(
    path,
    formData,
    mockFormRequest,
    onSuccess,
    errorContext,
  );
};

export const doAuthenticatedMultipartFormRequest = async <T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> => {
  const { mockMultipartRequest } = await import("#test-utils/mocks.ts");
  return doAuthenticatedRequest(
    path,
    formData,
    mockMultipartRequest,
    onSuccess,
    errorContext,
  );
};
