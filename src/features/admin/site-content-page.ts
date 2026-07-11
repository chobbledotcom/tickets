/**
 * The shared tabbed entity page for Site content editors (Pages, News). Both
 * are Site-gated (owner + editor) and share the same Edit / Images / Actions
 * shape; a caller supplies its entity's specifics and (for Pages) an extra tab
 * or two slotted between Edit and Images. Keeps the two editors from drifting.
 */

import {
  type ActionDef,
  defineEntityPage,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { requireSiteOr } from "#routes/auth.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type { ImageUseItemType } from "#shared/types.ts";
import { contentGuideFooter } from "#templates/admin/site-content.tsx";
import { loadItemImagesPanel } from "./item-images.ts";

/** The Edit (and Items) tabs mutate the entity, so they hide in read-only mode
 * — their POSTs bounce to /read-only there, so a bare-URL default must not
 * resolve onto an un-editable form. */
const imagesVisible = (): boolean => isStorageEnabled();

/** One Site content editor's page definition. `E` is the stored entity (it
 * carries its own numeric `id`); `extraTabs` slot in between Edit and Images
 * (Pages uses this for its Items manager). */
export interface SiteContentPageDef<E extends { id: number }> {
  basePath: (id: number) => string;
  /** The locale key for the delete action on the Actions tab. */
  deleteLabelKey: string;
  /** The Edit tab's fields form. */
  editPanel: (entity: E) => JSX.Element;
  extraTabs?: readonly TabDef<E>[];
  /** A guide section anchor (e.g. "public-site") linked in the page's guide
   * footer, so the operator can jump to the relevant help. */
  guideAnchor: string;
  /** The image-use type for this entity's Images tab. */
  itemType: ImageUseItemType;
  load: (id: number) => Promise<E | null>;
  navActive: string;
  titleOf: (entity: E) => string;
}

export const defineSiteContentPage = <E extends { id: number }>(
  def: SiteContentPageDef<E>,
): EntityPage<E> => {
  const editTab: TabDef<E> = {
    intent: "write-form",
    labelKey: "entity.tab.edit",
    sections: [
      {
        kind: "custom",
        load: (entity) => Promise.resolve(def.editPanel(entity)),
      },
    ],
    slug: "edit",
  };
  const imagesTab: TabDef<E> = {
    intent: "write-form",
    labelKey: "entity.tab.images",
    sections: [
      {
        kind: "custom",
        load: (entity) =>
          loadItemImagesPanel(def.itemType, entity.id, def.basePath(entity.id)),
      },
    ],
    slug: "images",
    visible: imagesVisible,
  };
  const deleteAction: ActionDef<E> = {
    danger: true,
    href: (entity) => `${def.basePath(entity.id)}/delete`,
    icon: "trash-2",
    intent: "write-form",
    labelKey: def.deleteLabelKey,
  };
  const actionsTab: TabDef<E> = {
    intent: "write-form",
    labelKey: "entity.tab.actions",
    sections: [
      {
        actions: [deleteAction],
        kind: "actions",
        titleKey: "entity.tab.actions",
      },
    ],
    slug: "actions",
    // Delete is the only action, and the delete confirmation GET is itself
    // blocked in read-only mode (READ_ONLY_GET_PATTERNS) — so hide the whole
    // tab rather than render a link that immediately bounces to /read-only.
  };
  return defineEntityPage({
    basePath: def.basePath,
    guard: requireSiteOr,
    guideFooter: (_entity, ctx) =>
      Promise.resolve(
        contentGuideFooter(def.guideAnchor, ctx.session.adminLevel),
      ),
    load: def.load,
    navActive: def.navActive,
    tabs: [editTab, ...(def.extraTabs ?? []), imagesTab, actionsTab],
    titleOf: def.titleOf,
  });
};
