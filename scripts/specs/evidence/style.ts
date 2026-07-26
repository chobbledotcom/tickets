import { isolateElementCss } from "#scripts/screenshots/checks.ts";

const DETERMINISTIC_CSS = `
*, *::before, *::after {
  animation: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
  transition: none !important;
}`;

export const storeEvidenceCss = async (
  declaration: { css?: string | undefined; element: string },
  write: (css: string) => Promise<void>,
): Promise<void> => {
  await write(
    `${declaration.css ?? ""}\n${isolateElementCss(
      declaration.element,
    )}\n${DETERMINISTIC_CSS}`,
  );
};
