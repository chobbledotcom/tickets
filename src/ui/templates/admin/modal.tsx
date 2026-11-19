/**
 * The admin modal shell's inert markup, rendered once on each admin page as a
 * `<template>`. The client module in `src/ui/client/admin/modal.ts` clones it
 * for each modal it opens. The two controls carry the words a screen reader
 * reads. The title bar takes its words from the modal's settings.
 */

import { t } from "#i18n";
import { ADMIN_MODAL_TEMPLATE_ID } from "#shared/admin-modal.ts";
import { Icon } from "#templates/components/actions.tsx";

export const AdminModalTemplate = (): JSX.Element => (
  <template id={ADMIN_MODAL_TEMPLATE_ID}>
    <dialog class="admin-modal" tabindex="-1">
      <div class="admin-modal-bar">
        <span class="admin-modal-title"></span>
        <span class="admin-modal-controls">
          <button
            aria-label={t("modal.minimise")}
            class="admin-modal-minimise"
            type="button"
          >
            <Icon name="minus" />
          </button>
          <button
            aria-label={t("modal.close")}
            class="admin-modal-close"
            type="button"
          >
            <Icon name="x" />
          </button>
        </span>
      </div>
      <div class="admin-modal-body"></div>
    </dialog>
  </template>
);
