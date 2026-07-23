export interface Rgb {
  b: number;
  g: number;
  r: number;
}

export const parseRgb = (color: string): Rgb => {
  const channels = color.match(/\d+/g)?.slice(0, 3).map(Number);
  if (channels?.length !== 3) {
    throw new Error(`Could not read screenshot background colour: ${color}`);
  }
  return { b: channels[2]!, g: channels[1]!, r: channels[0]! };
};
