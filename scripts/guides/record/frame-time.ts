/** The video time of a screencast frame. Chrome stamps each frame when it
 * paints, and a stamp can be a few milliseconds older than the frame before
 * it. A frame never sits before the one that came first, so the timeline stays
 * in time order. */
export const frameTimeMs = (
  wallMs: number,
  startWallMs: number,
  previousMs: number,
): number => Math.max(previousMs, Math.round(wallMs - startWallMs));
