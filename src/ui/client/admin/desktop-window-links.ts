/// <reference lib="dom" />

export interface DesktopWindowBindings {
  openWindow(url: string): Promise<void>;
}

const getDesktopBindings = (): DesktopWindowBindings | undefined =>
  (globalThis as unknown as { bindings?: DesktopWindowBindings }).bindings;

/** Route new-window links through Deno Desktop when its binding is present. */
export const initDesktopWindowLinks = (
  bindings: DesktopWindowBindings | undefined = getDesktopBindings(),
): void => {
  if (!bindings) return;
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>(
      'a[target="_blank"]',
    );
    if (!link) return;
    event.preventDefault();
    void bindings.openWindow(link.href);
  });
};
