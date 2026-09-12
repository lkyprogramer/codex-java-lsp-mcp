// input: console.error writes from the daemon.
// output: The same line with an ISO-8601 prefix, once per process.
// pos: HTTP/stdio entrypoints; never log source text.

let installed = false;

export function installConsoleTimestamps(): void {
  if (installed) return;
  installed = true;
  const write = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    write(new Date().toISOString(), ...args);
  };
}

export function logToolFailure(tool: string, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codex-java-lsp] tool failed tool=${tool}${code ? ` code=${code}` : ""} ${message}`);
}
