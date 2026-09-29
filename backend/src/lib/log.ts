export function log(msg: string, data?: Record<string, unknown>): void {
  console.log(`[cr] ${msg}${data ? ` ${JSON.stringify(data)}` : ""}`);
}

export function errorMessage(err: unknown, fallback = "Erreur interne du serveur"): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
}
