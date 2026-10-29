import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConfig } from "../../src/config.ts";
import { chat, LlmError, type Transport, type TransportRequest } from "../../src/llm.ts";
import { formatStats, readCalls } from "../../src/log.ts";

const cfg = mergeConfig({
  lanes: { alt: { baseUrl: "http://alt.invalid/v1/", model: "alt-model", apiKeyEnv: "ALT_KEY" } },
  steps: { route: { fallback: "alt" } },
});
const ok = (content: string, extra = {}) => ({
  status: 200,
  json: {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } },
    ...extra,
  },
});
function env() {
  const log = join(mkdtempSync(join(tmpdir(), "tinycode-llm-")), "calls.jsonl");
  return { log, env: { TINYCODE_LOG: log, ALT_KEY: "secret-value" } as Record<string, string> };
}
const msgs = [{ role: "user" as const, content: "hi" }];

test("request body: temperature 0, max_tokens from limits, thinking off, json_schema", async () => {
  const e = env();
  let seen: TransportRequest | undefined;
  const transport: Transport = async (r) => ((seen = r), ok("{}"));
  await chat("pick", msgs, { config: cfg, transport, env: e.env, schema: { type: "object" } });
  const b = seen!.body as Record<string, any>;
  assert.equal(b.temperature, 0);
  assert.equal(b.max_tokens, 300);
  assert.equal(b.model, "tinycode-model");
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  assert.equal(b.response_format.type, "json_schema");
  assert.equal(seen!.url, "http://127.0.0.1:8080/v1/chat/completions");
  await chat("route", msgs, { config: cfg, transport, env: e.env, maxTokens: 16 });
  assert.equal((seen!.body as any).max_tokens, 16);
  assert.equal((seen!.body as any).response_format, undefined);
});

test("fallback lane on ECONNREFUSED and on HTTP 503; its key comes from the env", async () => {
  for (const first of [
    () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    () => Promise.resolve({ status: 503, json: { error: "busy" } }),
  ]) {
    const e = env();
    const calls: TransportRequest[] = [];
    const transport: Transport = async (r) => {
      calls.push(r);
      return calls.length === 1 ? first() : ok("from alt");
    };
    const r = await chat("route", msgs, { config: cfg, transport, env: e.env, workflow: "route" });
    assert.equal(r.text, "from alt");
    assert.equal(r.lane, "alt");
    assert.equal(r.fellBack, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "http://alt.invalid/v1/chat/completions");
    assert.equal(calls[1].headers.Authorization, "Bearer secret-value");
    assert.equal((calls[1].body as any).model, "alt-model");
    const log = readCalls(e.env);
    assert.equal(log.length, 2);
    assert.notEqual(log[0].status, 200);
    assert.equal(log[1].status, 200);
    assert.ok(!readFileSync(e.log, "utf8").includes("secret-value"));
  }
});

test("no fallback on HTTP 200 with bad JSON, nor on 4xx", async () => {
  const e = env();
  let n = 0;
  const bad: Transport = async () => (n++, ok("not json {"));
  const r = await chat("route", msgs, { config: cfg, transport: bad, env: e.env, schema: { type: "object" } });
  assert.equal(r.text, "not json {");
  assert.equal(r.fellBack, false);
  assert.equal(n, 1);
  const four: Transport = async () => (n++, { status: 400, json: {} });
  await assert.rejects(chat("route", msgs, { config: cfg, transport: four, env: e.env }), (x: LlmError) => x.status === 400);
  assert.equal(n, 2);
});

test("transport failure without a fallback lane throws", async () => {
  const e = env();
  const down: Transport = async () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
  await assert.rejects(chat("pick", msgs, { config: cfg, transport: down, env: e.env }), /ECONNREFUSED/);
});

test("log line has every field; stats show per-step calls and cache-hit %", async () => {
  const e = env();
  await chat("hunk", msgs, { config: cfg, transport: async () => ok("x"), env: e.env, workflow: "review" });
  await chat("hunk", msgs, { config: cfg, transport: async () => ok("y"), env: e.env });
  const [rec] = readCalls(e.env);
  assert.deepEqual(Object.keys(rec).sort(), [
    "cached_tokens", "completion_tokens", "lane", "model", "ms", "prompt_tokens", "session", "status", "step", "ts", "workflow",
  ]);
  assert.equal(rec.step, "hunk");
  assert.equal(rec.workflow, "review");
  assert.equal(rec.lane, "small");
  assert.equal(rec.model, "tinycode-model");
  assert.equal(rec.prompt_tokens, 100);
  assert.equal(rec.cached_tokens, 60);
  assert.equal(rec.completion_tokens, 5);
  assert.equal(rec.status, 200);
  assert.match(formatStats(readCalls(e.env)), /hunk\s+2\s+200\s+60%/);
});
