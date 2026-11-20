// effects: pure
/** Pixel positions for a window. Oversized windows keep the top and right
 * edges reachable, where the title bar and its controls sit. */

/** A point in pixels from the viewport's top-left corner. */
export type Point = { left: number; top: number };

/** A width and a height in pixels. */
export type ModalSize = { height: number; width: number };

/** The nearest point to `point` that keeps the modal on the screen. */
export const clampModalPosition = (
  point: Point,
  size: ModalSize,
  viewport: ModalSize,
): Point => ({
  left: Math.min(Math.max(point.left, 0), viewport.width - size.width),
  top: Math.max(0, Math.min(point.top, viewport.height - size.height)),
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
