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
  type PageCtx,
  type SlotLoader,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import type { AuthSession } from "#routes/auth.ts";
import type { FormParams } from "#shared/form-data.ts";

export interface RejectedEdit {
  error: string;
  form: FormParams;
}

interface SubmittedValueProps {
  error?: string;
  values?: Record<string, string>;
}

/** Props for a schema-rendered form's rejected submitted state. */
export const submittedValueProps = (
  rejected?: RejectedEdit,
): SubmittedValueProps =>
  rejected
    ? {
        error: rejected.error,
        values: rejected.form.toRenderValues(),
      }
    : {};

type EditPanelLoaderWith<
  Entity,
  RejectedArgs extends [rejected?: RejectedEdit],
> = (
  ...args: [entity: Entity, ctx: PageCtx, ...rejected: RejectedArgs]
) => ReturnType<SlotLoader<Entity>>;

export type EditPanelLoader<Entity> = EditPanelLoaderWith<
  Entity,
  [rejected?: RejectedEdit]
>;

type RejectedEditPanelLoader<Entity> = EditPanelLoaderWith<
  Entity,
  [rejected: RejectedEdit]
>;

export type EditErrorRenderer<Id = number> = (
  id: Id,
  session: AuthSession,
  form: FormParams,
  error: string,
) => Promise<Response>;

export interface EditEntityPage<Entity> extends EntityPage<Entity> {
  renderEditError: EditErrorRenderer;
}

/** Bind one page tab's submitted-error panel to its HTTP 400 renderer. */
export const editErrorRenderer =
  <Entity>(
    getEntityPage: () => EntityPage<Entity>,
    editSlug: string,
    edit: RejectedEditPanelLoader<Entity>,
  ): EditErrorRenderer =>
  (id, session, form, error) =>
    getEntityPage().renderPage(session, id, editSlug, {
      panel: (entity, ctx) => edit(entity, ctx, { error, form }),
      status: 400,
    });

export type PanelTab = <Entity>(
  slug: string,
  labelKey: string,
  load: SlotLoader<Entity>,
  visible?: (entity: Entity, session: AuthSession) => boolean,
) => TabDef<Entity>;

const panelTabWithIntent =
  (intent?: "view" | "write-form"): PanelTab =>
  (slug, labelKey, load, visible) => ({
    ...(intent ? { intent } : {}),
    labelKey,
    sections: [customSection(load)],
    slug,
    ...(visible ? { visible } : {}),
  });

/** A tab with one custom-rendered panel, optionally gated. */
export const panelTab: PanelTab = panelTabWithIntent();

/** A write-form tab with a single custom section, optionally gated. */
export const writeFormTab: PanelTab = panelTabWithIntent("write-form");

/** The common named-resource page: Edit first, optional extra tabs, then the
 * standard delete-only Actions tab. */
export interface EditEntityPageDef<Entity extends { id: number; name: string }>
  extends Omit<EntityPageDef<Entity>, "tabs" | "titleOf"> {
  deleteLabelKey: string;
  edit: EditPanelLoader<Entity>;
  editSlug?: string;
  extraTabs?: readonly TabDef<Entity>[];
}

export const defineEditEntityPage = <
  Entity extends { id: number; name: string },
>(
  config: EditEntityPageDef<Entity>,
): EditEntityPage<Entity> => {
  const {
    deleteLabelKey,
    edit,
    editSlug = "edit",
    extraTabs: configuredExtraTabs,
    ...page
  } = config;
  const extraTabs: readonly TabDef<Entity>[] = configuredExtraTabs ?? [];
  const entityPage = defineEntityPage({
    ...page,
    tabs: [
      writeFormTab(editSlug, "entity.tab.edit", edit),
      ...extraTabs,
      deleteActionTab<Entity>(
        deleteLabelKey,
        (entity) => `${page.basePath(entity.id)}/delete`,
      ),
    ],
    titleOf: (entity) => entity.name,
  });
  return {
    ...entityPage,
    renderEditError: editErrorRenderer(
      () => entityPage,
      editSlug,
      (entity, ctx, rejected) => edit(entity, ctx, rejected),
    ),
  };
};
