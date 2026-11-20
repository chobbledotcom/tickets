/**
 * The admin modal shell's shared facts: the settings every modal validates at
 * construction, and the id of the `<template>` that holds the shell's markup.
 * The client module in `src/ui/client/admin/modal.ts` owns the behaviour.
 */

import * as v from "valibot";

/** The id of the inert `<template>` that carries the shell's chrome, which
 *  the admin shell renders on every admin page. */
export const ADMIN_MODAL_TEMPLATE_ID = "admin-modal";

/** The settings one modal opens with.
 *
 *  - `key` names the modal. A second open with the same key raises the modal
 *    that is already open, so one instance never shows twice.
 *  - `title` is the words the title bar shows.
 *  - `collapsedTitle` is the words the bar shows while the modal is
 *    minimised, where the full title does not fit. */
export const modalSettingsSchema = v.object({
  collapsedTitle: v.pipe(
    v.string(),
    v.nonEmpty("A modal needs a collapsed title"),
  ),
  key: v.pipe(v.string(), v.nonEmpty("A modal needs a key")),
  title: v.pipe(v.string(), v.nonEmpty("A modal needs a title")),
});

export type ModalSettings = v.InferOutput<typeof modalSettingsSchema>;
