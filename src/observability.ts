type LogLevel = "INFO" | "WARN" | "ERROR";

type StructuredLog = {
  ts: string;
  level: LogLevel;
  service: "backend-api";
  event: string;
  correlationId?: string | null;
  meta?: Record<string, unknown>;
};

export type ReportErrorInput = {
  event: string;
  message: string;
  correlationId?: string | null;
  status?: number;
  code?: string;
  operation?: string;
  meta?: Record<string, unknown>;
};

const ERROR_TRACKING_WEBHOOK_URL = process.env.ERROR_TRACKING_WEBHOOK_URL?.trim() || "";
const ERROR_TRACKING_TIMEOUT_MS = Number(process.env.ERROR_TRACKING_TIMEOUT_MS ?? 2000);
const ERROR_TRACKING_ENABLED = Boolean(ERROR_TRACKING_WEBHOOK_URL);

function serializeLog(entry: StructuredLog): string {
  return JSON.stringify(entry);
}

export function logInfo(
  event: string,
  correlationId?: string | null,
  meta?: Record<string, unknown>
) {
  const entry: StructuredLog = {
    ts: new Date().toISOString(),
    level: "INFO",
    service: "backend-api",
    event,
    correlationId: correlationId ?? null,
    ...(meta ? { meta } : {}),
  };
  console.log(serializeLog(entry));
}

export function logWarn(
  event: string,
  correlationId?: string | null,
  meta?: Record<string, unknown>
) {
  const entry: StructuredLog = {
    ts: new Date().toISOString(),
    level: "WARN",
    service: "backend-api",
    event,
    correlationId: correlationId ?? null,
    ...(meta ? { meta } : {}),
  };
  console.warn(serializeLog(entry));
}

export function logError(
  event: string,
  correlationId?: string | null,
  meta?: Record<string, unknown>
) {
  const entry: StructuredLog = {
    ts: new Date().toISOString(),
    level: "ERROR",
    service: "backend-api",
    event,
    correlationId: correlationId ?? null,
    ...(meta ? { meta } : {}),
  };
  console.error(serializeLog(entry));
}

export async function reportError(input: ReportErrorInput): Promise<void> {
  logError(input.event, input.correlationId, {
    message: input.message,
    status: input.status ?? null,
    code: input.code ?? null,
    operation: input.operation ?? null,
    ...(input.meta ?? {}),
  });

  if (!ERROR_TRACKING_ENABLED) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ERROR_TRACKING_TIMEOUT_MS);

  try {
    await fetch(ERROR_TRACKING_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: new Date().toISOString(),
        service: "backend-api",
        ...input,
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    logWarn("error_tracking_webhook_failed", input.correlationId, {
      message: e?.message ?? String(e),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function classifyGraphFailure(status: number, body: unknown): {
  code: string;
  category: "infrastructure" | "upstream" | "application";
} {
  const parsed = typeof body === "object" && body !== null ? (body as Record<string, any>) : null;
  const upstreamStatus = String(parsed?.status ?? "").toUpperCase();
  const message = String(parsed?.message ?? parsed?.error ?? "").toLowerCase();

  if (status === 503 || upstreamStatus === "WAIT" || message.includes("waking up")) {
    return { code: "GRAPH_WARMUP_WAIT", category: "infrastructure" };
  }

  if (status >= 500) {
    return { code: "GRAPH_SERVICE_UNAVAILABLE", category: "upstream" };
  }

  return { code: "GRAPH_OPERATION_FAILED", category: "application" };
}

