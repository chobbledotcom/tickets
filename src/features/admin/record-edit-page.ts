/**
 * The standard Edit / Actions page of one admin record. The record supplies
 * the read, the display name, and the page destination. The page module
 * supplies only the edit panel and its words.
 */

import type { TabDef } from "#routes/admin/entity-pages.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import type {
  AdminRecord,
  FullRowOf,
  RecordShape,
} from "#shared/rest/record.ts";
import type { NavActive } from "#templates/admin/nav.tsx";
import {
  defineEditEntityPage,
  type EditEntityPage,
  type EditPanelLoader,
} from "./entity-write-tab.ts";

/** The facts a record's page module still supplies. */
export type RecordEditPageConfig<
  Shape extends RecordShape & { row: { name: string } },
> = {
  readonly deleteDestination: AdminDestinationId;
  readonly deleteLabelKey: string;
  readonly destination: AdminDestinationId;
  readonly edit: EditPanelLoader<FullRowOf<Shape>>;
  readonly editSlug?: string;
  readonly extraTabs?: readonly TabDef<FullRowOf<Shape>>[];
  readonly navActive?: NavActive;
};

/** Build a record's Edit / Actions page from its declaration and its panel. */
export const recordEditPage = <
  Shape extends RecordShape & { row: { name: string } },
>(
  record: AdminRecord<Shape>,
  config: RecordEditPageConfig<Shape>,
): EditEntityPage<FullRowOf<Shape>> =>
  defineEditEntityPage({
    deleteDestination: config.deleteDestination,
    deleteLabelKey: config.deleteLabelKey,
    destination: config.destination,
    edit: config.edit,
    ...(config.editSlug === undefined ? {} : { editSlug: config.editSlug }),
    ...(config.extraTabs === undefined ? {} : { extraTabs: config.extraTabs }),
    load: (id, session) => record.load(id, { session }),
    navActive: config.navActive ?? adminPattern(record.list),
    recordId: (row) => row.id,
  });
