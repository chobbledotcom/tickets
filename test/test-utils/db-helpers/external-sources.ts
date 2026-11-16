import { externalSourceRecord } from "#shared/records/external-sources.ts";
import { writtenRow } from "#test-utils/record-commands.ts";
import { withTestSession } from "#test-utils/session.ts";

/** Add a source through its record. The create reads the sealed row back, so
 * it runs in an admin session. */
export const createTestExternalSource = (
  name: string,
  urlPattern = "https://example.com/{external_id}",
) =>
  withTestSession(() =>
    writtenRow(externalSourceRecord.create({ name, urlPattern })),
  );
