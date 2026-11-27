/** Turn the rendered PNG sequence into an MP4 a person can watch. A missing
 * ffmpeg is a loud failure, not a silent empty video. */

import { join } from "@std/path";
import { frameFileName } from "./frame-name.ts";

const decoder = new TextDecoder();

export interface EncodeInput {
  fps: number;
  framesDir: string;
  outputPath: string;
}

export const ffmpegExecutable = (): string =>
  Deno.env.get("FFMPEG_EXECUTABLE") ?? "ffmpeg";

export const encodeFrames = async ({
  fps,
  framesDir,
  outputPath,
}: EncodeInput): Promise<void> => {
  const command = new Deno.Command(ffmpegExecutable(), {
    args: [
      "-y",
      "-framerate",
      String(fps),
      "-start_number",
      "1",
      "-i",
      join(framesDir, "frame-%05d.png"),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    stderr: "piped",
    stdin: "null",
    stdout: "null",
  });
  const result = await command.output();
  if (result.code === 0) return;
  throw new Error(
    `ffmpeg failed with code ${result.code}: ${decoder.decode(result.stderr).trim()}`,
  );
};

export const copyPosterFrame = async (
  framesDir: string,
  outputPath: string,
  frameCount: number,
): Promise<void> => {
  const index = Math.max(1, Math.ceil(frameCount / 4));
  await Deno.copyFile(join(framesDir, frameFileName(index, "png")), outputPath);
};
