import sharp from "sharp";

export const blankWhitePng = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: {
        background: { alpha: 1, b: 255, g: 255, r: 255 },
        channels: 4,
        height: 50,
        width: 50,
      },
    })
      .png()
      .toBuffer(),
  );

// A white page with a 30x20 black box at (35, 40). The element trimmer
// returns the box plus 32 pixels of padding on every side: 94x84.
export const whitePngWithBlackBox = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: {
        background: { alpha: 1, b: 255, g: 255, r: 255 },
        channels: 4,
        height: 100,
        width: 100,
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              background: { alpha: 1, b: 0, g: 0, r: 0 },
              channels: 4,
              height: 20,
              width: 30,
            },
          })
            .png()
            .toBuffer(),
          left: 35,
          top: 40,
        },
      ])
      .png()
      .toBuffer(),
  );
