export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

export interface TempPath extends Disposable {
  dispose(): void;
  path: string;
}

const tempPath = (path: string, recursive: boolean): TempPath => {
  const state = { active: true };
  const dispose = (): void => {
    if (!state.active) return;
    state.active = false;
    Deno.removeSync(path, { recursive });
  };
  return { dispose, path, [Symbol.dispose]: dispose };
};

export const tempDir = (options?: Deno.MakeTempOptions): TempPath =>
  tempPath(Deno.makeTempDirSync(options), true);

export const tempFile = (options?: Deno.MakeTempOptions): TempPath =>
  tempPath(Deno.makeTempFileSync(options), false);

export const withTempDir = async <Result>(
  run: (path: string) => Result | Promise<Result>,
  options?: Deno.MakeTempOptions,
): Promise<Result> => {
  using dir = tempDir(options);
  return await run(dir.path);
};

export const withTempFile = async <Result>(
  run: (path: string) => Result | Promise<Result>,
  options?: Deno.MakeTempOptions,
): Promise<Result> => {
  using file = tempFile(options);
  return await run(file.path);
};
