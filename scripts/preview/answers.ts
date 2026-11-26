/** Read the answer of a JSON API. */

import * as v from "valibot";
import { formatBunnyError } from "#scripts/deploy-edge-lib.ts";
import type { FetchTextResult } from "#scripts/fetch-text.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The value of an answer whose body must match a schema. A refused call
 * names its status and its message. A body that does not match fails too, so
 * a changed answer shows in the job log instead of passing on a guess. */
export const parseAnswer = <Value>(
  response: FetchTextResult,
  label: string,
  schema: v.GenericSchema<unknown, Value>,
): Result<Value> => {
  if (!response.ok) return errorResult(formatBunnyError(label, response));
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), schema),
    response.text,
  );
  return parsed.success
    ? okResult(parsed.output)
    : errorResult(`${label} gave an answer this script cannot read.`);
};
