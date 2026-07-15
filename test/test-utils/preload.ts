/** Shared setup installed before each test module by the standard runners. */
import "#test-utils/fast-expect.ts";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";

// Unit tests often render templates directly rather than entering through a
// route loader. Give those tests the complete catalog before their imports run.
await ensureMessageGroups(MESSAGE_GROUPS);
