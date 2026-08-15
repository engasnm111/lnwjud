/** Minimal MCP request context needed to emit mid-call progress. */
export interface ProgressNotifyContext {
  readonly mcpReq: {
    readonly id: string | number;
    readonly _meta?: { readonly progressToken?: string | number };
    readonly notify: (notification: {
      readonly method: string;
      readonly params?: Record<string, unknown>;
    }) => Promise<void>;
  };
}

const HEARTBEAT_FIRST_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function readProgressToken(context: ProgressNotifyContext): string | number {
  const fromMeta = context.mcpReq._meta?.progressToken;
  return fromMeta !== undefined ? fromMeta : context.mcpReq.id;
}

async function sendProgress(
  context: ProgressNotifyContext,
  toolName: string,
  startedAt: number,
): Promise<void> {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  try {
    await context.mcpReq.notify({
      method: 'notifications/progress',
      params: {
        progressToken: readProgressToken(context),
        progress: elapsedSeconds,
        message: `${toolName} still running (${elapsedSeconds}s)`,
      },
    });
  } catch {
    // Best-effort: progress must never fail the tool.
  }
}

/**
 * Emits MCP progress notifications while a long tool call is in flight so
 * tunnel-client / ChatGPT see the connector is still alive.
 */
export async function withProgressHeartbeat<T>(
  context: ProgressNotifyContext | undefined,
  toolName: string,
  run: () => Promise<T>,
): Promise<T> {
  if (context === undefined || typeof context.mcpReq?.notify !== 'function') {
    return run();
  }

  const startedAt = Date.now();
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    void sendProgress(context, toolName, startedAt);
    interval = setInterval(() => {
      void sendProgress(context, toolName, startedAt);
    }, HEARTBEAT_INTERVAL_MS);
  }, HEARTBEAT_FIRST_MS);

  try {
    return await run();
  } finally {
    clearTimeout(first);
    if (interval !== undefined) clearInterval(interval);
  }
}
