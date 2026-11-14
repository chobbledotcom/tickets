/**
 * The standard Edit / Actions page of one admin record. The record supplies
 * the read, the display name, and the page and delete destinations. The page
 * module supplies only the edit panel and its words.
 */

import { adminPattern } from "#shared/admin-surface.ts";
import {
  type AdminRecord,
  type FullRowOf,
  type RecordShape,
  recordPageIds,
} from "#shared/rest/record.ts";
import { loadWithSession } from "#shared/rest/record-pages.ts";
import type { NavActive } from "#templates/admin/nav.tsx";
import {
  defineEditEntityPage,
  type EditEntityPage,
  type EditEntityPageDef,
} from "./entity-write-tab.ts";

/** A record whose display name is its row name. */
type NamedShape = RecordShape & { row: { name: string } };

/** The facts a record's page module still supplies. */
type RecordEditPageConfig<Shape extends NamedShape> = Omit<
  EditEntityPageDef<FullRowOf<Shape>>,
  "deleteDestination" | "destination" | "load" | "navActive" | "recordId"
> & {
  readonly navActive?: NavActive;
};

export const recordEditPage = <Shape extends NamedShape>(
  record: AdminRecord<Shape>,
  config: RecordEditPageConfig<Shape>,
): EditEntityPage<FullRowOf<Shape>> =>
  defineEditEntityPage({
    ...config,
    ...recordPageIds(record),
    load: loadWithSession(record.load),
    navActive: config.navActive ?? adminPattern(record.list),
    recordId: (row) => row.id,
  });
