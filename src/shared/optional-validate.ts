/**
 * Run an optional validator and map any error string it returns through
 * `onError`. Returns null when there is no validator, or it reports no error —
 * the shared shape behind the settings-form and REST-resource validate steps.
 */
export const mapValidationError = async <R>(
  runValidate: (() => Promise<string | null> | string | null) | undefined,
  onError: (error: string) => R,
): Promise<Awaited<R> | null> => {
  if (!runValidate) return null;
  const error = await runValidate();
  return error ? await onError(error) : null;
};
