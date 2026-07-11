import { walkFiles } from "./walk-files.ts";

type LineCount = {
  files: number;
  lines: number;
};

type LineCountRow = LineCount & {
  extension: string;
};

type FileLineCount = {
  lines: number;
  path: string;
};

const NO_EXTENSION = "[no extension]";
const NEWLINE_BYTE = 10;

const extensionForPath = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? NO_EXTENSION : name.slice(dot);
};

const countLines = (bytes: Uint8Array): number =>
  bytes.reduce((total, byte) => total + (byte === NEWLINE_BYTE ? 1 : 0), 0);

const summarizeLineCounts = (files: FileLineCount[]): LineCountRow[] => {
  const counts = new Map<string, LineCount>();

  for (const file of files) {
    const extension = extensionForPath(file.path);
    const current = counts.get(extension) ?? { files: 0, lines: 0 };
    current.files += 1;
    current.lines += file.lines;
    counts.set(extension, current);
  }

  return [...counts]
    .map(([extension, count]) => ({ extension, ...count }))
    .sort(
      (left, right) =>
        right.lines - left.lines ||
        left.extension.localeCompare(right.extension),
    );
};

const totalLineCount = (rows: LineCountRow[]): LineCountRow =>
  rows.reduce(
    (total, row) => ({
      extension: "TOTAL",
      files: total.files + row.files,
      lines: total.lines + row.lines,
    }),
    { extension: "TOTAL", files: 0, lines: 0 },
  );

const formatRow = ({ extension, files, lines }: LineCountRow): string =>
  `${extension.padEnd(16)} ${String(files).padStart(8)} ${String(
    lines,
  ).padStart(8)}`;

const formatHeader = (): string =>
  `${"extension".padEnd(16)} ${"files".padStart(8)} ${"lines".padStart(8)}`;

const formatLineCounts = (rows: LineCountRow[]): string =>
  [
    formatHeader(),
    ...rows.map(formatRow),
    formatRow(totalLineCount(rows)),
  ].join("\n");

const collectLineCounts = async (
  roots: readonly string[],
): Promise<LineCountRow[]> => {
  const files: FileLineCount[] = [];
  for (const root of roots) {
    for await (const path of walkFiles(root)) {
      files.push({ lines: countLines(await Deno.readFile(path)), path });
    }
  }
  return summarizeLineCounts(files);
};

export const printLineCounts = async (
  roots: readonly string[],
  write: (output: string) => void,
): Promise<void> => {
  write(formatLineCounts(await collectLineCounts(roots)));
};
