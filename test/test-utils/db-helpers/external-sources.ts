import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { externalSourceRecord } from "#shared/records/external-sources.ts";
import { writtenRow } from "#test-utils/record-commands.ts";
import { withTestSession } from "#test-utils/session.ts";

/** Add a source through its record. The create reads the sealed row back, so
 * it runs in an admin session. A settings write resets the loaded owner keys,
 * so the helper loads them as a request does. */
export const createTestExternalSource = (
  name: string,
  urlPattern = "https://example.com/{external_id}",
) =>
  withTestSession(async () => {
    await settings.loadKeys([
      CONFIG_KEYS.PUBLIC_KEY,
      CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
    ]);
    return writtenRow(externalSourceRecord.create({ name, urlPattern }));
  });
