/**
 * The standard Edit / Actions page of one admin record. The record supplies
 * the read, the display name, and the page destination. The page module
 * supplies only the edit panel and its words.
 */

import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import type {
  AdminRecord,
  FullRowOf,
  RecordShape,
} from "#shared/rest/record.ts";
import { loadWithSession } from "#shared/rest/record-pages.ts";
import type { NavActive } from "#templates/admin/nav.tsx";
import {
  defineEditEntityPage,
  type EditEntityPage,
  type EditEntityPageDef,
  type EditPanelLoader,
} from "./entity-write-tab.ts";

/** A record whose display name is its row name. */
type NamedShape = RecordShape & { row: { name: string } };

/** The facts a record's page module still supplies. */
export type RecordEditPageConfig<Shape extends NamedShape> = Omit<
  EditEntityPageDef<FullRowOf<Shape>>,
  | "deleteDestination"
  | "deleteLabelKey"
  | "destination"
  | "edit"
  | "load"
  | "navActive"
  | "recordId"
> & {
  readonly deleteDestination: AdminDestinationId;
  readonly deleteLabelKey: string;
  readonly destination: AdminDestinationId;
  readonly edit: EditPanelLoader<FullRowOf<Shape>>;
  readonly navActive?: NavActive;
};

/** Build a record page from the facts every simple record repeats, in order. */
export const recordEditPageFor = <Shape extends NamedShape>(
  record: AdminRecord<Shape>,
  deleteDestination: AdminDestinationId,
  deleteLabelKey: string,
  destination: AdminDestinationId,
  edit: EditPanelLoader<FullRowOf<Shape>>,
  page: Omit<
    RecordEditPageConfig<Shape>,
    "deleteDestination" | "deleteLabelKey" | "destination" | "edit"
  > = {},
): EditEntityPage<FullRowOf<Shape>> =>
  recordEditPage(record, {
    deleteDestination,
    deleteLabelKey,
    destination,
    edit,
    ...page,
  });
export const recordEditPage = <Shape extends NamedShape>(
  record: AdminRecord<Shape>,
  config: RecordEditPageConfig<Shape>,
): EditEntityPage<FullRowOf<Shape>> =>
  defineEditEntityPage({
    ...config,
    load: loadWithSession(record.load),
    navActive: config.navActive ?? adminPattern(record.list),
    recordId: (row) => row.id,
  });
