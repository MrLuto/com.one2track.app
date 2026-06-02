import { randomBytes } from "node:crypto";

const DEBUG_ENABLED_SETTING_KEY = "debug_enabled";
const DEBUG_CID_SETTING_KEY = "debug_cid";
const DEBUG_ENDPOINT = "https://gas.byluto.nl/lc/";
const MAX_MESSAGE_LENGTH = 1_500;
const MAX_BUFFERED_ENTRIES = 250;

export type DebugLevel = "info" | "warn" | "error";

export type DebugContext = {
  accountId?: string;
  deviceName?: string;
  trackerUuid?: string;
  username?: string;
  [key: string]: unknown;
};

type HttpClient = (url: string, options: Record<string, unknown>) => Promise<{ statusCode: number }>;

type DebugLoggerHomeyHost = {
  manifest: {
    id: string;
  };
  settings: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  };
};

type DebugEntry = {
  timestamp: string;
  level: DebugLevel;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
  data: unknown;
};

type BufferedEntry = {
  payload: string;
};

export function generateDebugCid(): string {
  return randomBytes(8).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldRedact(key: string): boolean {
  return /password|token|cookie|authorization|secret|authenticity|csrf/i.test(key);
}

function truncateString(value: string, maxLength = 400): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...<truncated>`;
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncateString(value.stack ?? "", 1_200),
      cause: sanitizeValue((value as Error & { cause?: unknown }).cause, seen),
    };
  }

  if (typeof value === "string") {
    return truncateString(value, 1_200);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  if (!isPlainObject(value)) {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = shouldRedact(key) ? "[redacted]" : sanitizeValue(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}

function chunkMessage(message: string): string[] {
  if (message.length <= MAX_MESSAGE_LENGTH) {
    return [message];
  }

  const parts: string[] = [];
  for (let index = 0; index < message.length; index += MAX_MESSAGE_LENGTH) {
    parts.push(message.slice(index, index + MAX_MESSAGE_LENGTH));
  }

  return parts.map((part, index) => `[${index + 1}/${parts.length}] ${part}`);
}

export class DebugLogger {
  private queue: Promise<void> = Promise.resolve();
  private httpPromise: Promise<HttpClient> | null = null;
  private readonly bufferedEntries: BufferedEntry[] = [];

  constructor(
    private readonly homey: DebugLoggerHomeyHost,
    private readonly localLog: (...args: unknown[]) => void,
    private readonly localError: (...args: unknown[]) => void,
  ) {}

  isEnabled(): boolean {
    return this.homey.settings.get(DEBUG_ENABLED_SETTING_KEY) === true;
  }

  info(source: string, message: string, data?: unknown, context?: DebugContext): void {
    this.write("info", source, message, data, context);
  }

  warn(source: string, message: string, data?: unknown, context?: DebugContext): void {
    this.write("warn", source, message, data, context);
  }

  error(source: string, message: string, data?: unknown, context?: DebugContext): void {
    this.write("error", source, message, data, context);
  }

  forceInfo(source: string, message: string, data?: unknown, context?: DebugContext): void {
    this.write("info", source, message, data, context, true);
  }

  flushBuffered(reason = "manual"): void {
    const entries = this.bufferedEntries.splice(0, this.bufferedEntries.length);
    if (entries.length === 0) {
      return;
    }

    this.queue = this.queue
      .then(async () => {
        await this.sendEntry(undefined, JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          source: "debug-buffer",
          message: "Flushing buffered debug entries",
          context: null,
          data: {
            reason,
            count: entries.length,
          },
        }));

        for (const entry of entries) {
          await this.sendEntry(undefined, entry.payload);
        }
      })
      .catch((error) => {
        this.localError("[debug:remote] could not flush buffered debug logs", error);
      });
  }

  private write(
    level: DebugLevel,
    source: string,
    message: string,
    data?: unknown,
    context?: DebugContext,
    forceRemote = false,
  ): void {
    const enabled = this.isEnabled();
    const entry: DebugEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      context: context ? (sanitizeValue(context) as Record<string, unknown>) : null,
      data: sanitizeValue(data),
    };

    if (enabled || level === "error") {
      if (level === "error") {
        this.localError(`[debug:${source}] ${message}`, entry.data ?? "");
      } else {
        this.localLog(`[debug:${source}] ${message}`, entry.data ?? "");
      }
    }

    const payload = JSON.stringify(entry);

    if (!enabled && !forceRemote) {
      this.bufferEntry(payload);
      return;
    }

    this.queue = this.queue
      .then(async () => {
        await this.sendEntry(undefined, payload);
      })
      .catch((error) => {
        this.localError("[debug:remote] could not forward debug log", error);
      });
  }

  private bufferEntry(payload: string): void {
    this.bufferedEntries.push({ payload });
    if (this.bufferedEntries.length > MAX_BUFFERED_ENTRIES) {
      this.bufferedEntries.splice(0, this.bufferedEntries.length - MAX_BUFFERED_ENTRIES);
    }
  }

  private async sendRemote(cid: string, message: string): Promise<void> {
    const http = await this.getHttpClient();
    const status = await http(DEBUG_ENDPOINT, {
      method: "GET",
      retry: { limit: 0 },
      searchParams: {
        uid: this.homey.manifest.id,
        cid,
        message,
      },
      throwHttpErrors: false,
      timeout: {
        request: 5_000,
      },
    });

    if (status.statusCode >= 400) {
      throw new Error(`Debug endpoint returned ${status.statusCode}`);
    }
  }

  private async sendEntry(_cid: string | undefined, payload: string): Promise<void> {
    const resolvedCid = this.getConfiguredCid();
    for (const part of chunkMessage(payload)) {
      await this.sendRemote(resolvedCid, part);
    }
  }

  private getConfiguredCid(): string {
    const configuredCid = this.homey.settings.get(DEBUG_CID_SETTING_KEY);
    if (typeof configuredCid === "string" && configuredCid.trim() !== "") {
      return configuredCid.trim();
    }

    const generatedCid = generateDebugCid();
    this.homey.settings.set(DEBUG_CID_SETTING_KEY, generatedCid);
    return generatedCid;
  }

  private async getHttpClient(): Promise<HttpClient> {
    if (!this.httpPromise) {
      this.httpPromise = import("got").then(({ default: got }) => got);
    }

    return this.httpPromise;
  }
}

export const debugSettings = {
  cidKey: DEBUG_CID_SETTING_KEY,
  enabledKey: DEBUG_ENABLED_SETTING_KEY,
};
