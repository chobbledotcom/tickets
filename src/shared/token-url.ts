/** Share links: the absolute link a share token opens on this site. */

import { getEffectiveDomain } from "#shared/config.ts";
import { encodedAfter } from "#shared/encoded-after.ts";

/** The absolute link a token opens under `prefix`. */
export const tokenUrl =
  (prefix: string) =>
  (token: string): string =>
    `https://${getEffectiveDomain()}${encodedAfter(prefix)(token)}`;
