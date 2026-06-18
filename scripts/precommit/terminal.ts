export interface TerminalState {
  ci: boolean;
  stdin: boolean;
  stdout: boolean;
}

export const currentTerminalState = (): TerminalState => ({
  ci: Boolean(Deno.env.get("CI")),
  stdin: Deno.stdin.isTerminal(),
  stdout: Deno.stdout.isTerminal(),
});

export const canPrompt = ({ ci, stdin, stdout }: TerminalState): boolean =>
  stdin && stdout && !ci;

export const canShowProgress = ({ ci, stdout }: TerminalState): boolean =>
  stdout && !ci;
