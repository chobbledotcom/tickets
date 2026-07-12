/**
 * The standard shape of an entity page's editing tabs: a write-form tab
 * holding one custom section whose loader builds the tab's form. Shared by
 * the attendee and listing entity pages so a tab definition is one mechanism,
 * not a per-page literal.
 */

import {
  customSection,
  type SlotLoader,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import type { AuthSession } from "#routes/auth.ts";

/** A write-form tab with a single custom section, optionally gated. */
export const writeFormTab = <Entity>(
  slug: string,
  labelKey: string,
  load: SlotLoader<Entity>,
  visible?: (entity: Entity, session: AuthSession) => boolean,
): TabDef<Entity> => ({
  intent: "write-form",
  labelKey,
  sections: [customSection(load)],
  slug,
  ...(visible ? { visible } : {}),
});
