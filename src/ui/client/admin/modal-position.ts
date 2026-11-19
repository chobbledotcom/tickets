/**
 * Where a modal sits, as pure arithmetic. Kept apart from the shell so the
 * clamp is testable without a browser.
 *
 * Two guarantees meet here. A modal that fits stays fully on the screen. A
 * modal larger than the screen keeps its title bar reachable. The bar stays
 * at the top, and its controls stay at the right edge.
 */

/** A point in pixels from the viewport's top-left corner. */
export type Point = { left: number; top: number };

/** A width and a height in pixels. */
export type ModalSize = { height: number; width: number };

const between = (value: number, low: number, high: number): number => {
  if (value < low) return low;
  if (value > high) return high;
  return value;
};

const clampedLeft = (
  left: number,
  width: number,
  viewportWidth: number,
): number => {
  if (width > viewportWidth) return viewportWidth - width;
  return between(left, 0, viewportWidth - width);
};

const clampedTop = (
  top: number,
  height: number,
  viewportHeight: number,
): number => {
  if (height > viewportHeight) return 0;
  return between(top, 0, viewportHeight - height);
};

/** The nearest point to `point` that keeps the modal on the screen. */
export const clampModalPosition = (
  point: Point,
  size: ModalSize,
  viewport: ModalSize,
): Point => ({
  left: clampedLeft(point.left, size.width, viewport.width),
  top: clampedTop(point.top, size.height, viewport.height),
});

/** The point that centres the modal, kept on the screen. */
export const centredPosition = (size: ModalSize, viewport: ModalSize): Point =>
  clampModalPosition(
    {
      left: (viewport.width - size.width) / 2,
      top: (viewport.height - size.height) / 2,
    },
    size,
    viewport,
  );
