export const isCompactWidth = (
  contentWidth: number,
  containerWidth: number,
): boolean => contentWidth <= containerWidth * 0.75;

export const isolateElementCss = (selector: string): string =>
  `body * { visibility: hidden !important; }
:is(${selector}), :is(${selector}) * { visibility: visible !important; }`;

interface ImageSize {
  height: number;
  width: number;
}

export const wasImageTrimmed = (
  source: ImageSize,
  result: ImageSize,
  padding: number,
): boolean =>
  result.width !== source.width + padding * 2 ||
  result.height !== source.height + padding * 2;
