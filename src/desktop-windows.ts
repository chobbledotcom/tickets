export type OpenWindow = (url: string) => void;

export interface DesktopWindow {
  bind(name: "openWindow", binding: OpenWindow): void;
  navigate(url: string): void;
}

export type DesktopWindowConstructor = new () => DesktopWindow;

const webWindowUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Cannot open desktop window for protocol: ${url.protocol}`);
  }
  return url.toString();
};

/** Bind the startup window and every child to open links in native windows. */
export const enableDesktopWindows = (
  Window: DesktopWindowConstructor,
): void => {
  const bindWindow = (window: DesktopWindow): void => {
    window.bind("openWindow", (rawUrl) => {
      const url = webWindowUrl(rawUrl);
      const child = new Window();
      bindWindow(child);
      child.navigate(url);
    });
  };

  const main = new Window();
  bindWindow(main);
};
