/**
 * The shared tabbed entity page for Site content editors (Pages, News). Both
 * are Site-gated (owner + editor) and share the same Edit / Images / Actions
 * shape. A caller supplies its entity's specifics and (for Pages) an extra
 * tab or two slotted between Edit and Images. Keeps the two editors from
 * drifting.
 */

import type { TabDef } from "#routes/admin/entity-pages.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminRecordPath } from "#shared/admin-surface.ts";
import type { SubmittedValueProps } from "#shared/form-data.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { contentGuideFooter } from "#templates/admin/site-content.tsx";
import type { ImageUseItemType } from "#types";
import {
  defineEditEntityPage,
  type EditEntityPage,
  submittedValueProps,
  writeFormTab,
} from "./entity-write-tab.ts";
import { loadItemImagesPanel } from "./item-images.ts";

/** The Edit (and Items) tabs mutate the entity, so they hide in read-only
 * mode. Their POSTs bounce to /read-only there, so a bare-URL default must
 * not resolve onto an un-editable form. */
const imagesVisible = (): boolean => isStorageEnabled();

/** One Site content editor's page definition. `E` is the stored entity (it
 * carries its own numeric `id`). `extraTabs` slot in between Edit and Images
 * (Pages uses this for its Items manager). */
export interface SiteContentPageDef<E extends { id: number; name: string }> {
  /** The write route the delete action leads to. */
  deleteDestination: AdminDestinationId;
  /** The locale key for the delete action on the Actions tab. */
  deleteLabelKey: string;
  destination: AdminDestinationId;
  /** The Edit tab's fields form. */
  editPanel: (entity: E, submitted?: SubmittedValueProps) => JSX.Element;
  extraTabs?: readonly TabDef<E>[];
  /** The image-use type for this entity's Images tab. */
  itemType: ImageUseItemType;
  load: (id: number) => Promise<E | null>;
  navActive: string;
}

export const defineSiteContentPage = <E extends { id: number; name: string }>(
  def: SiteContentPageDef<E>,
): EditEntityPage<E> => {
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
  return defineEditEntityPage<E>({
    deleteDestination: def.deleteDestination,
    deleteLabelKey: def.deleteLabelKey,
    destination: def.destination,
    edit: (entity, _ctx, rejected) =>
      Promise.resolve(def.editPanel(entity, submittedValueProps(rejected))),
    extraTabs: [...(def.extraTabs ?? []), imagesTab],
    guideFooter: (_entity, ctx) =>
      Promise.resolve(
        contentGuideFooter("public-site", ctx.session.adminLevel),
      ),
    load: def.load,
    navActive: def.navActive,
    recordId: (entity) => entity.id,
  });
};
