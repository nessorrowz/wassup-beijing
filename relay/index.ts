import { Hono } from 'hono';

/**
 * The stateless relay (PRD Section 9).
 *
 * It adds the model API key and forwards an already-redacted request. It stores
 * nothing and logs nothing: the browser is the only place user data lives
 * (NFR-5, NFR-6). The payload it receives has already passed through
 * `src/gate/gate.ts`.
 *
 * It also translates between the app's own message and tool shapes and the
 * OpenAI-compatible chat-completions format, so provider details stay next to
 * the provider key and out of the browser.
 *
 * Deployment: one serverless function. `npm run relay:dev` runs it locally.
 */
export interface RelayBindings {
  /** OpenAI-compatible chat-completions endpoint. */
  MODEL_API_URL?: string;
  /** Never reaches the browser. */
  MODEL_API_KEY?: string;
  /** Reported back so the privacy panel can label the reply. */
  MODEL_ID?: string;
  /** Model requests one client may make per minute. Defaults to DEFAULT_RATE_LIMIT. */
  RELAY_RATE_LIMIT?: string;
  /**
   * Sampling temperature sent to the provider. 0 makes the model copy long
   * figures from tool results exactly; left out, the provider's default applies.
   */
  MODEL_TEMPERATURE?: string;
}

export interface RelayMessage {
  role: string;
  content: string;
  /** Tool name, on tool results. */
  name?: string;
  /** Tool calls the assistant made in this message. */
  toolCalls?: Array<{ name: string; arguments: unknown }>;
}

export interface RelayTool {
  name: string;
  description: string;
  /** Parameter name to a short type hint: "string", "number?", "string[]". */
  parameters: Record<string, string>;
}

export interface RelayRequestBody {
  messages: RelayMessage[];
  tools?: RelayTool[];
}

/* ---------------------------------------------------- provider translation */

/**
 * The app's tool names contain dots ("earmark.create"), which the
 * chat-completions format does not allow in a function name.
 */
export function toProviderToolName(name: string): string {
  return name.replace(/\./g, '__');
}

export function fromProviderToolName(name: string): string {
  return name.replace(/__/g, '.');
}

function parameterSchema(hint: string): Record<string, unknown> {
  const base = hint.replace(/\?$/, '');
  if (base === 'number') return { type: 'integer' };
  if (base === 'string[]') return { type: 'array', items: { type: 'string' } };
  // Anything else ("string", "YYYY-MM-DD", "friendly | firm") is a string with the hint as its description.
  return base === 'string' ? { type: 'string' } : { type: 'string', description: base };
}

export function toProviderTools(tools: readonly RelayTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: toProviderToolName(tool.name),
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, hint]) => [key, parameterSchema(hint)]),
        ),
        required: Object.entries(tool.parameters)
          .filter(([, hint]) => !hint.endsWith('?'))
          .map(([key]) => key),
      },
    },
  }));
}

/**
 * A tool result as the hosted model reads it. Whole numbers of 10,000 or more
 * get thousands separators ("6.636.334"): models copy grouped digits far more
 * reliably than a bare 6636334, which glm-5.3-flash was seen to garble into
 * 6633634. The browser's number check strips separators, so the figures it
 * accepts do not change. Content that is not JSON passes through unchanged.
 */
export function groupLargeNumbers(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  return JSON.stringify(parsed, (_key, value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) >= 10_000
      ? `${value < 0 ? '-' : ''}${String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
      : value,
  );
}

/**
 * Chat-completions messages. Each tool result must name the call it answers, so
 * calls are numbered in order and results are matched to them in order.
 */
export function toProviderMessages(messages: readonly RelayMessage[]): unknown[] {
  const output: unknown[] = [];
  const unanswered: string[] = [];
  let counter = 0;

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const calls = message.toolCalls.map((call) => {
        counter += 1;
        const id = `call_${counter}`;
        unanswered.push(id);
        return {
          id,
          type: 'function',
          function: { name: toProviderToolName(call.name), arguments: JSON.stringify(call.arguments ?? {}) },
        };
      });
      output.push({ role: 'assistant', content: message.content, tool_calls: calls });
    } else if (message.role === 'tool') {
      const id = unanswered.shift();
      // A tool result with no call to answer cannot be expressed; pass it as plain text.
      output.push(
        id
          ? { role: 'tool', tool_call_id: id, content: groupLargeNumbers(message.content) }
          : {
              role: 'user',
              content: `Tool result (${message.name ?? 'unknown'}): ${groupLargeNumbers(message.content)}`,
            },
      );
    } else {
      output.push({ role: message.role, content: message.content });
    }
  }
  return output;
}

interface ProviderToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

export function fromProviderToolCalls(raw: unknown): Array<{ name: string; arguments: unknown }> {
  if (!Array.isArray(raw)) return [];
  const calls: Array<{ name: string; arguments: unknown }> = [];
  for (const entry of raw as ProviderToolCall[]) {
    const name = entry.function?.name;
    if (typeof name !== 'string' || name === '') continue;
    let parsed: unknown = {};
    const rawArguments = entry.function?.arguments;
    if (typeof rawArguments === 'string' && rawArguments.trim() !== '') {
      try {
        parsed = JSON.parse(rawArguments);
      } catch {
        // Arguments that are not JSON are dropped; the tool then refuses the empty call.
        parsed = {};
      }
    } else if (rawArguments !== null && typeof rawArguments === 'object') {
      parsed = rawArguments;
    }
    calls.push({ name: fromProviderToolName(name), arguments: parsed });
  }
  return calls;
}

export const DEFAULT_MODEL_API_URL = 'https://api.example.invalid/v1/chat/completions';

/**
 * Read a value from the platform bindings (Cloudflare Workers style) or from the
 * process environment (Node). `process` is absent on some edge runtimes, so it is
 * never touched unless it exists.
 */
function readBinding(env: RelayBindings | undefined, key: keyof RelayBindings): string | undefined {
  if (env?.[key] !== undefined) return env[key];
  if (typeof process !== 'undefined') return process.env[key];
  return undefined;
}

/* ------------------------------------------------------------ abuse limits */

/**
 * A deployed relay is a public URL that spends the provider credit, so it caps
 * how often one client may call the model and how big a request may be. The
 * counter holds only request times per client address, in memory, for one
 * minute; it is not a log. On a serverless platform each instance counts on its
 * own, so the cap is a brake, not a hard quota.
 */
export const DEFAULT_RATE_LIMIT = 30;
/** A whole conversation with every tool result is far below this. */
export const MAX_BODY_BYTES = 256 * 1024;
const WINDOW_MS = 60_000;
const recent = new Map<string, number[]>();

export function allowRequest(client: string, limit: number, now = Date.now()): boolean {
  const since = now - WINDOW_MS;
  const times = (recent.get(client) ?? []).filter((time) => time > since);
  const allowed = times.length < limit;
  if (allowed) times.push(now);
  recent.set(client, times);
  // Forget idle clients so the map cannot grow without bound.
  if (recent.size > 10_000) {
    for (const [key, value] of recent) {
      if (value.every((time) => time <= since)) recent.delete(key);
    }
  }
  return allowed;
}

/** Tests only. */
export function resetRateLimit(): void {
  recent.clear();
}

function rateLimit(env: RelayBindings | undefined): number {
  const value = Number(readBinding(env, 'RELAY_RATE_LIMIT'));
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RATE_LIMIT;
}

/**
 * Waits before each retry. A provider can refuse a burst of requests for a moment
 * (a 429, or a 5xx from an overloaded upstream) and answer normally a second later,
 * so one user message should not fail on it.
 */
export const RETRY_DELAYS_MS = [500, 1500];

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** The provider's answer, after up to RETRY_DELAYS_MS.length retries; null if it never answered. */
async function fetchWithRetry(url: string, request: RequestInit): Promise<Response | null> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      last = await fetch(url, request);
      if (!retryable(last.status)) return last;
    } catch {
      // A network failure is retried like a 5xx.
    }
  }
  return last;
}

export const app = new Hono<{ Bindings: RelayBindings }>();

app.get('/api/health', (c) => c.json({ ok: true, configured: Boolean(readBinding(c.env, 'MODEL_API_KEY')) }));

app.post('/api/model', async (c) => {
  const apiKey = readBinding(c.env, 'MODEL_API_KEY');
  if (!apiKey) {
    return c.json(
      {
        error:
          'the relay is not configured. Set MODEL_API_KEY (and MODEL_API_URL) to enable model calls. Everything except the model keeps working without it.',
      },
      503,
    );
  }

  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) {
    return c.json({ error: 'the request is too large' }, 413);
  }

  // The hosting platform sets these; locally every caller shares one bucket.
  const client =
    c.req.header('x-real-ip') ??
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'local';
  if (!allowRequest(client, rateLimit(c.env))) {
    return c.json({ error: 'too many model requests; wait a minute and try again' }, 429);
  }

  let body: RelayRequestBody;
  try {
    body = await c.req.json<RelayRequestBody>();
  } catch {
    return c.json({ error: 'expected a JSON body with a "messages" array' }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return c.json({ error: 'expected a JSON body with a "messages" array' }, 400);
  }

  const url = readBinding(c.env, 'MODEL_API_URL') ?? DEFAULT_MODEL_API_URL;
  const temperature = Number(readBinding(c.env, 'MODEL_TEMPERATURE') ?? Number.NaN);

  const request: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: readBinding(c.env, 'MODEL_ID') ?? 'default',
      messages: toProviderMessages(body.messages),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      ...(body.tools && body.tools.length > 0 ? { tools: toProviderTools(body.tools) } : {}),
    }),
  };

  const upstream = await fetchWithRetry(url, request);
  if (upstream === null) {
    return c.json({ error: 'the model provider could not be reached' }, 502);
  }
  if (!upstream.ok) {
    return c.json({ error: `the model provider returned ${upstream.status}` }, 502);
  }

  const reply = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
  };

  return c.json({
    model: readBinding(c.env, 'MODEL_ID') ?? 'default',
    content: reply.choices?.[0]?.message?.content ?? '',
    toolCalls: fromProviderToolCalls(reply.choices?.[0]?.message?.tool_calls),
  });
});

export default app;
