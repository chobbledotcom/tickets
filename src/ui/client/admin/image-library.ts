/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { closeAdminModal, openAdminModal } from "#src/ui/client/admin/modal.ts";
import { forEachMatch } from "#src/ui/client/dom.ts";

const dataValue = (
  element: HTMLElement,
  name: "imageEditId" | "imageEditName" | "modalLoading",
): string => {
  const value = element.dataset[name];
  if (value === undefined) throw new Error(`Missing data attribute: ${name}`);
  return value;
};

const isPlainClick = (event: MouseEvent): boolean =>
  event.button === 0 &&
  event.detail > 0 &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

const loadEdit = async (
  key: string,
  content: HTMLElement,
  page: URL,
): Promise<void> => {
  const form = new URL(page);
  form.searchParams.set("modal", "1");
  try {
    const response = await fetch(`${form.pathname}${form.search}`, {
      headers: { accept: "text/html" },
    });
    if (!response.ok || response.redirected) {
      throw new Error("The image edit request did not return the form");
    }
    content.innerHTML = await response.text();
  } catch {
    // A failed load uses the full page, unless the operator closed the window.
    if (content.isConnected) {
      closeAdminModal(key);
      window.location.assign(`${page.pathname}${page.search}`);
    }
  }
};

export const initImageLibrary = (): void => {
  const grid = document.querySelector<HTMLElement>("[data-image-library]");
  if (grid === null) return;
  const loading = dataValue(grid, "modalLoading");
  forEachMatch<HTMLAnchorElement>("a[data-image-edit-id]", (link) => {
    link.addEventListener("click", (event) => {
      if (!isPlainClick(event)) return;
      event.preventDefault();
      const name = dataValue(link, "imageEditName");
      const content = document.createElement("div");
      content.textContent = loading;
      const key = `image-edit:${dataValue(link, "imageEditId")}`;
      const modal = openAdminModal(
        {
          collapsedTitle: name,
          key,
          title: name,
        },
        content,
      );
      // A repeated open raises the existing window without a new request.
      if (modal !== content) return;
      void loadEdit(key, content, new URL(link.href));
    });
  });
};
