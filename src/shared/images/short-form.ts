// effects: pure
/**
 * The short-form image address (`img#7`) that the markdown editor writes.
 * The stored markdown keeps it. The server resolves it to the image's URL at
 * render time, and the rich editor resolves it through the image library.
 */

const SHORT_FORM = /^img#(\d+)$/;

/** The short-form address that names one library image. */
export const shortFormImageAddress = (id: number): string => `img#${id}`;

/** The id one short-form image address names, or undefined for any other
 * address. */
export const shortFormImageId = (href: string): number | undefined => {
  const id = SHORT_FORM.exec(href)?.[1];
  return id === undefined ? undefined : Number(id);
};
