// The only way the extension logs (DESIGN.md §8, AGENTS.md global rules).
// Never outputs PDF text, request/response bodies, secret values or the APP-ID:
//   1. registered secrets (the APP-ID) are replaced wherever they appear
//   2. strings that look like secrets are replaced (AWS, GitHub, JWT, PEM, long tokens)
//   3. fields whose name suggests sensitive content are replaced entirely
//   4. long strings are reduced to their length (so text and bodies never get through)
//   5. nested data is cut off below a fixed depth; functions and binary data are summarised

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Where log lines go. Default: the browser console. Tests pass a fake. */
export type LogSink = (level: LogLevel, line: string, fields?: Record<string, unknown>) => void;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const REDACTED = '[redacted]';
/** Strings longer than this are replaced by "[text, N chars]". */
export const MAX_STRING_LENGTH = 200;
/** Objects nested deeper than this are replaced by "[object]". */
export const MAX_DEPTH = 3;

/** Field names whose values are always redacted, whatever they contain (case-insensitive). */
const SENSITIVE_KEYS = new Set(
  [
    'text', 'pagetext', 'pages', 'body', 'prompt', 'entity', 'entities', 'sanitized_entity',
    'appid', 'app_id', 'app-id', 'apikey', 'api_key', 'secret', 'secrets', 'password',
    'token', 'authorization', 'base64', 'bytes', 'data', 'modified_text', 'violating_findings',
  ],
);

/** Patterns of secret-looking values. Order matters: PEM blocks first. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g, // PEM blocks (also unterminated)
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key IDs
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]+/g, // JWTs
  /[A-Za-z0-9+/_=-]{40,}/g, // long opaque tokens / base64 / hex
];

const registeredSecrets = new Set<string>();

/**
 * Registers a value (e.g. the APP-ID) that must never appear in any log line.
 * Values shorter than 4 characters are ignored (too short to redact safely).
 */
export function registerSecret(value: string): void {
  if (value.length >= 4) registeredSecrets.add(value);
}

/** For tests only. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** Redacts secrets inside a string and shortens long strings. */
export function sanitizeString(value: string): string {
  let out = value;
  for (const secret of registeredSecrets) out = out.split(secret).join(REDACTED);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.length > MAX_STRING_LENGTH ? `[text, ${value.length} chars]` : out;
}

/** Returns a log-safe copy of any value. Never throws. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return sanitizeString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
    default:
      break;
  }
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeString(value.message) };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[binary, ${(value as ArrayBuffer | ArrayBufferView).byteLength} bytes]`;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return `[blob, ${value.size} bytes]`;
  }
  if (depth >= MAX_DEPTH) return '[object]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => sanitize(item, depth + 1));
    return value.length > 20 ? [...items, `[+${value.length - 20} more]`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : sanitize(item, depth + 1);
  }
  return out;
}

const consoleSink: LogSink = (level, line, fields) => {
  // The one place in the extension allowed to use console.
  if (fields === undefined) console[level](line);
  else console[level](line, fields);
};

/**
 * Creates a logger for one part of the extension, e.g. createLogger('offscreen', { dev: __DEV__ }).
 * debug() lines are only written in dev builds.
 */
export function createLogger(context: string, options: { dev?: boolean; sink?: LogSink } = {}): Logger {
  const { dev = false, sink = consoleSink } = options;
  const prefix = `[PSS:${context}]`;

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (level === 'debug' && !dev) return;
    try {
      const line = `${prefix} ${sanitizeString(message)}`;
      if (fields === undefined) sink(level, line);
      else sink(level, line, sanitize(fields) as Record<string, unknown>);
    } catch {
      // Logging must never break the extension.
    }
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
