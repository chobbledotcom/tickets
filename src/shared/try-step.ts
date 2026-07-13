/**
 * Run a step that already reports success or failure as an `ok` outcome, and
 * turn a thrown exception into that same failure shape instead of crashing:
 * `{ ok: false, error: "<label>: <message>" }`. For steps that call out to
 * external services (provider APIs, release downloads), where a network or
 * parse failure is a normal outcome the caller shows to the operator.
 */
export const tryStep = async <Value extends { ok: boolean }>(
  label: string,
  step: () => Promise<Value>,
): Promise<Value | { ok: false; error: string }> => {
  try {
    return await step();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `${label}: ${message}`, ok: false };
  }
};
