/**
 * The shared tabbed entity page for Site content editors (Pages, News). Both
 * are Site-gated (owner + editor) and share the same Edit / Images / Actions
 * shape; a caller supplies its entity's specifics and (for Pages) an extra tab
 * or two slotted between Edit and Images. Keeps the two editors from drifting.
 */

/* jscpd:ignore-start */
import {
  defineEntityPage,
  deleteActionTab,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminRecordPath } from "#shared/admin-surface.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type { ImageUseItemType } from "#shared/types.ts";
import { contentGuideFooter } from "#templates/admin/site-content.tsx";
import { writeFormTab } from "./entity-write-tab.ts";
import { loadItemImagesPanel } from "./item-images.ts";

/* jscpd:ignore-end */

/** The Edit (and Items) tabs mutate the entity, so they hide in read-only mode
 * — their POSTs bounce to /read-only there, so a bare-URL default must not
 * resolve onto an un-editable form. */
const imagesVisible = (): boolean => isStorageEnabled();

/** One Site content editor's page definition. `E` is the stored entity (it
 * carries its own numeric `id`); `extraTabs` slot in between Edit and Images
 * (Pages uses this for its Items manager). */
export interface SiteContentPageDef<E extends { id: number }> {
  /** The locale key for the delete action on the Actions tab. */
  deleteLabelKey: string;
  destination: AdminDestinationId;
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
  const editTab = writeFormTab<E>("edit", "entity.tab.edit", (entity) =>
    Promise.resolve(def.editPanel(entity)),
  );
  const imagesTab = writeFormTab<E>(
    "images",
    "entity.tab.images",
    (entity) =>
      loadItemImagesPanel(
        def.itemType,
        entity.id,
        adminRecordPath(def.destination, entity.id),
      ),
    imagesVisible,
  );
  // Delete is the only action, and the delete confirmation GET is itself
  // blocked in read-only mode (READ_ONLY_GET_PATTERNS), so the shared helper
  // makes the whole tab write-only.
  const actionsTab = deleteActionTab<E>(
    def.deleteLabelKey,
    (entity) => `${adminRecordPath(def.destination, entity.id)}/delete`,
  );
  return defineEntityPage({
    destination: def.destination,
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
