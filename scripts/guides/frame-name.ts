/** The name of one frame in a recorded or rendered sequence. */
export const frameFileName = (index: number, extension: string): string =>
  `frame-${String(index).padStart(5, "0")}.${extension}`;
