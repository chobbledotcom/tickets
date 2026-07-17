/**
 * The standard shape of an entity page's editing tabs: a write-form tab
 * holding one custom section whose loader builds the tab's form. Shared by
 * the attendee and listing entity pages so a tab definition is one mechanism,
 * not a per-page literal.
 */

import {
  customSection,
  defineEntityPage,
  deleteActionTab,
  type EntityPage,
  type EntityPageDef,
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

/** The common named-resource page: Edit first, optional extra tabs, then the
 * standard delete-only Actions tab. */
export interface EditEntityPageDef<Entity extends { id: number; name: string }>
  extends Omit<EntityPageDef<Entity>, "tabs" | "titleOf"> {
  deleteLabelKey: string;
  edit: SlotLoader<Entity>;
  editSlug?: string;
  extraTabs?: readonly TabDef<Entity>[];
}

export const defineEditEntityPage = <
  Entity extends { id: number; name: string },
>(
  config: EditEntityPageDef<Entity>,
): EntityPage<Entity> => {
  const {
    deleteLabelKey,
    edit,
    editSlug = "edit",
    extraTabs = [],
    ...page
  } = config;
  return defineEntityPage({
    ...page,
    tabs: [
      writeFormTab(editSlug, "entity.tab.edit", edit),
      ...extraTabs,
      deleteActionTab(
        deleteLabelKey,
        (entity) => `${page.basePath(entity.id)}/delete`,
      ),
    ],
    titleOf: (entity) => entity.name,
  });
};
