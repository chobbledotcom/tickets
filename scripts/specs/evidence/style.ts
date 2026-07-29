import { isolateElementCss } from "#scripts/screenshots/checks.ts";

const DETERMINISTIC_CSS = `
*, *::before, *::after {
  animation: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
  transition: none !important;
}`;

export const storeEvidenceCss = async (
  declaration: { element: string },
  theme: string,
  write: (css: string) => Promise<void>,
): Promise<void> => {
  await write(
    `${theme}\n${isolateElementCss(declaration.element)}\n${DETERMINISTIC_CSS}`,
  );
};
