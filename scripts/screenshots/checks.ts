export const isCompactWidth = (
  contentWidth: number,
  containerWidth: number,
): boolean => contentWidth <= containerWidth * 0.75;

export const isolateElementCss = (selector: string): string =>
  `body * { visibility: hidden !important; }
:is(${selector}), :is(${selector}) * { visibility: visible !important; }`;
