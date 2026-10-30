// The LLM client: one `chat(step, messages)` over OpenAI-compatible endpoints. The step names its lane
// (config.steps); a transport failure (connection error, timeout, HTTP >= 500) retries once on the step's
// fallback lane. A wrong answer is never retried here. Every attempt appends a line to the call log.
import { loadConfig, type Config, type Lane } from "./config.ts";
import { logCall } from "./log.ts";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface Usage {
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
}
export interface ChatResult {
  text: string;
  usage: Usage;
  ms: number;
  /** the lane that answered */
  lane: string;
  model: string;
  /** true when the fallback lane answered */
  fellBack: boolean;
  /** the server's finish_reason ("stop", "length", ...), when it sent one */
  finish?: string;
}
export interface TransportRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}
export interface TransportResponse {
  status: number;
  json: unknown;
}
/** Injectable so unit tests never touch the network. Throws on connection errors and timeouts. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface ChatOptions {
  schema?: object;
  schemaName?: string;
  /** overrides limits.maxTokens[step] */
  maxTokens?: number;
  /** overrides the lane's seed for this call (the ladder's second quick try samples with seed + 1) */
  seed?: number;
  workflow?: string | null;
  config?: Config;
  transport?: Transport;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export class LlmError extends Error {
  status: number | string;
  constructor(message: string, status: number | string) {
    super(message);
    this.status = status;
  }
}

export const SESSION = `${Date.now().toString(36)}-${process.pid}`;

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

function errCode(e: unknown): string {
  const x = e as { code?: string; cause?: { code?: string }; name?: string };
  return x.code ?? x.cause?.code ?? x.name ?? "ERROR";
}

interface Attempt {
  result?: ChatResult;
  /** transport-level failure: eligible for the fallback lane */
  transportFailure?: LlmError;
}

async function attempt(
  step: string,
  laneName: string,
  lane: Lane,
  messages: Message[],
  opts: ChatOptions,
  cfg: Config,
  fellBack: boolean,
): Promise<Attempt> {
  const env = opts.env ?? process.env;
  const maxTokens = opts.maxTokens ?? cfg.limits.maxTokens[step];
  const body: Record<string, unknown> = {
    model: lane.model,
    messages,
    temperature: lane.temperature ?? 0,
    chat_template_kwargs: { enable_thinking: false },
  };
  const seed = opts.seed ?? lane.seed;
  if (seed !== undefined) body.seed = seed;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (opts.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: opts.schemaName ?? step, schema: opts.schema },
    };
  }
  const key = lane.apiKeyEnv ? env[lane.apiKeyEnv] : undefined;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key || "none"}` };
  const transport = opts.transport ?? fetchTransport;
  const t0 = Date.now();
  const record = (status: number | string, usage: Usage) =>
    logCall(
      {
        ts: new Date().toISOString(),
        session: SESSION,
        workflow: opts.workflow ?? null,
        step,
        lane: laneName,
        model: lane.model,
        ...usage,
        ms: Date.now() - t0,
        status,
      },
      env,
    );
  const none: Usage = { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 };
  let res: TransportResponse;
  try {
    res = await transport({
      url: lane.baseUrl.replace(/\/+$/, "") + "/chat/completions",
      headers,
      body,
      timeoutMs: opts.timeoutMs ?? 900_000,
    });
  } catch (e) {
    const code = errCode(e);
    record(code, none);
    return { transportFailure: new LlmError(`${laneName}: ${code}: ${(e as Error).message}`, code) };
  }
  const j = (res.json ?? {}) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number } | null;
    };
  };
  const usage: Usage = {
    prompt_tokens: j.usage?.prompt_tokens ?? 0,
    cached_tokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completion_tokens: j.usage?.completion_tokens ?? 0,
  };
  record(res.status, usage);
  if (res.status >= 500) return { transportFailure: new LlmError(`${laneName}: HTTP ${res.status}`, res.status) };
  if (res.status < 200 || res.status >= 300) throw new LlmError(`${laneName}: HTTP ${res.status}`, res.status);
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== "string" && content !== null && content !== undefined) {
    throw new LlmError(`${laneName}: malformed response (no message content)`, res.status);
  }
  const finish = j.choices?.[0]?.finish_reason;
  return {
    result: { text: content ?? "", usage, ms: Date.now() - t0, lane: laneName, model: lane.model, fellBack, ...(typeof finish === "string" ? { finish } : {}) },
  };
}

export async function chat(step: string, messages: Message[], opts: ChatOptions = {}): Promise<ChatResult> {
  const cfg = opts.config ?? loadConfig(opts.env ?? process.env);
  const st = cfg.steps[step as keyof Config["steps"]];
  if (!st) throw new LlmError(`unknown step ${JSON.stringify(step)}`, "CONFIG");
  const lane = cfg.lanes[st.lane];
  if (!lane) throw new LlmError(`step ${step}: lane "${st.lane}" is not configured`, "CONFIG");
  const first = await attempt(step, st.lane, lane, messages, opts, cfg, false);
  if (first.result) return first.result;
  const fb = st.fallback ? cfg.lanes[st.fallback] : null;
  if (!st.fallback || !fb) throw first.transportFailure as LlmError;
  const second = await attempt(step, st.fallback, fb, messages, opts, cfg, true);
  if (second.result) return second.result;
  throw new LlmError(
    `${(first.transportFailure as LlmError).message}; fallback ${(second.transportFailure as LlmError).message}`,
    (second.transportFailure as LlmError).status,
  );
}
