import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConfig } from "../../src/config.ts";
import { chat as realChat, type ChatResult, type Message } from "../../src/llm.ts";
import { runPlan, unfamiliarLibrary, wantsResearch } from "../../src/workflows/plan.ts";
import { formatResearch, htmlToText, parseResearchArgs, runResearch, urlAllowed } from "../../src/workflows/research.ts";

const TOKEN = "ghp_SECRETtoken1234567890";
const tmp = () => mkdtempSync(join(tmpdir(), "tc-res-"));
const reply = (o: unknown, usage = { prompt_tokens: 100, cached_tokens: 0, completion_tokens: 20 }): ChatResult => ({
  text: typeof o === "string" ? o : JSON.stringify(o), usage, ms: 1, lane: "small", model: "m", fellBack: false,
});

const REPOS = { items: [
  { full_name: "a/tabulate", html_url: "https://github.com/a/tabulate", stargazers_count: 900, language: "Python", description: "pretty tables" },
  { full_name: "b/rich", html_url: "https://github.com/b/rich", stargazers_count: 5000, language: "Python", description: "rich text" },
] };

interface Call { url: string; auth?: string }
function fakeFetch(calls: Call[]) {
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (url.startsWith("https://api.github.com/search/repositories")) return { ok: true, status: 200, text: async () => JSON.stringify(REPOS) };
    if (url.startsWith("https://api.github.com/search/code")) return { ok: false, status: 403, text: async () => "{}" };
    if (url.startsWith("https://github.com/a/tabulate"))
      return { ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => "<html><head><title>x</title></head><body><script>bad()</script><h1>tabulate</h1><p>Pretty-print &amp; align tables.</p>" + "word ".repeat(5000) + "</body></html>" };
    return { ok: false, status: 404, text: async () => "" };
  };
}

/** A scripted chat: each call pops the next reply (a function gets the messages). */
function script(...steps: (unknown | ((m: Message[], step: string, o: unknown) => unknown))[]) {
  const seen: { step: string; messages: Message[]; opts: unknown }[] = [];
  const fn = async (step: string, messages: Message[], opts?: unknown) => {
    seen.push({ step, messages: structuredClone(messages), opts });
    const s = steps.shift();
    if (s === undefined) throw new Error("script exhausted");
    return reply(typeof s === "function" ? (s as (m: Message[], st: string, o: unknown) => unknown)(messages, step, opts) : s);
  };
  return { fn, seen };
}
const cfg = (over: Record<string, unknown> = {}) => mergeConfig({ research: over });
const ANSWER = { answer: "tabulate is small; rich is bigger.", sources: ["https://github.com/a/tabulate", "https://github.com/b/rich", "https://made.up/x"] };

test("research: search, fetch, summarise; sources limited to URLs a tool returned; schema on the summary", async () => {
  const calls: Call[] = [];
  const s = script({ tool: "github_repos", arg: "python terminal tables" }, { tool: "fetch", arg: "https://github.com/a/tabulate" }, { tool: "done", arg: "" }, ANSWER);
  const r = await runResearch({ question: "small python table libs" }, { config: cfg(), chat: s.fn, fetch: fakeFetch(calls) as never, env: {} });
  assert.deepEqual(r.sources, ["https://github.com/a/tabulate", "https://github.com/b/rich"]);
  assert.equal(r.stopped, "done");
  assert.equal(r.steps, 2);
  assert.equal(s.seen.length, 4);
  const last = s.seen[3]!;
  assert.deepEqual((last.opts as { schema: { required: string[] } }).schema.required, ["answer", "sources"]);
  assert.equal((last.opts as { schemaName: string }).schemaName, "answer");
  // the fetched page reached the model as text, tags and script gone, and capped
  const afterFetch = s.seen[2]!.messages.at(-1)!.content;
  assert.match(afterFetch, /Pretty-print & align tables/);
  assert.doesNotMatch(afterFetch, /<p>|bad\(\)/);
  assert.ok(afterFetch.length < 3700);
  const out = formatResearch(r);
  assert.match(out, /Sources:\n- https:\/\/github.com\/a\/tabulate/);
  assert.doesNotMatch(out, /made\.up/);
});

test("research cap: steps stop at maxSteps, then exactly one summary call", async () => {
  const calls: Call[] = [];
  const steps = Array.from({ length: 20 }, (_, i) => ({ tool: "github_repos", arg: `q${i}` }));
  const s = script(...steps, ANSWER);
  const r = await runResearch({ question: "q" }, { config: cfg({ maxSteps: 3 }), chat: s.fn, fetch: fakeFetch(calls) as never, env: {} });
  assert.equal(r.steps, 3);
  assert.equal(r.stopped, "steps");
  assert.equal(calls.length, 3);
  assert.equal(s.seen.length, 4);
  assert.deepEqual(s.seen.map((x) => (x.opts as { schemaName: string }).schemaName), ["step", "step", "step", "answer"]);
});

test("research cap: the token budget stops the tool loop; the summary still runs", async () => {
  const s = script(
    ...Array.from({ length: 10 }, (_, i) => () => ({ tool: "github_repos", arg: `q${i}` })),
    ANSWER,
  );
  const big = async (step: string, m: Message[], o?: unknown) => {
    const r = await s.fn(step, m, o);
    return { ...r, usage: { prompt_tokens: 900, cached_tokens: 0, completion_tokens: 100 } };
  };
  const r = await runResearch({ question: "q" }, { config: cfg({ maxTokens: 2500, maxSteps: 8 }), chat: big, fetch: fakeFetch([]) as never, env: {} });
  assert.equal(r.stopped, "tokens");
  assert.equal(r.steps, 3);
  assert.equal(s.seen.length, 4);
  assert.equal(r.tokens, 4000);
});

test("research: a repeated call is refused (a nudge, not a stop); bad JSON twice goes to the summary", async () => {
  const calls: Call[] = [];
  const s = script({ tool: "github_repos", arg: "x" }, { tool: "github_repos", arg: "x" }, "not json", "still not", ANSWER);
  const r = await runResearch({ question: "q" }, { config: cfg(), chat: s.fn, fetch: fakeFetch(calls) as never, env: {} });
  assert.equal(calls.length, 1);
  assert.match(s.seen[2]!.messages.at(-1)!.content, /already made that call/);
  assert.equal(r.stopped, "invalid");
});

test("research: tool failures become observations; private and non-http URLs are never fetched", async () => {
  const calls: Call[] = [];
  const s = script({ tool: "github_code", arg: "x" }, { tool: "fetch", arg: "http://127.0.0.1:8080/v1" }, { tool: "fetch", arg: "file:///etc/passwd" }, { tool: "find", arg: "where" }, { tool: "done", arg: "" }, { answer: "none", sources: [] });
  const r = await runResearch({ question: "q" }, { config: cfg(), chat: s.fn, fetch: fakeFetch(calls) as never, env: {} });
  assert.match(s.seen[1]!.messages.at(-1)!.content, /GitHub HTTP 403.*GITHUB_TOKEN/);
  assert.match(s.seen[2]!.messages.at(-1)!.content, /only public http/);
  assert.match(s.seen[4]!.messages.at(-1)!.content, /find is not available/);
  assert.equal(calls.filter((c) => !c.url.startsWith("https://api.github.com")).length, 0);
  assert.deepEqual(r.sources, []);
  assert.ok(!urlAllowed("http://localhost/x") && !urlAllowed("http://192.168.1.4/") && !urlAllowed("http://10.8.8.8:8080/") && urlAllowed("https://github.com/x"));
});

test("research: the local find tool is the injected branch", async () => {
  const s = script({ tool: "find", arg: "where is main?" }, { tool: "done", arg: "" }, { answer: "ok", sources: [] });
  await runResearch({ question: "q" }, { config: cfg(), chat: s.fn, fetch: fakeFetch([]) as never, find: async (q) => `src/app.py:3 (${q})`, env: {} });
  assert.match(s.seen[1]!.messages.at(-1)!.content, /src\/app\.py:3 \(where is main\?\)/);
});

test("research: the answer is cut to answerWords; an empty question prints usage and calls nothing", async () => {
  const s = script({ tool: "done", arg: "" }, { answer: "w ".repeat(500), sources: [] });
  const r = await runResearch({ question: "q" }, { config: cfg({ answerWords: 50 }), chat: s.fn, fetch: fakeFetch([]) as never, env: {} });
  assert.ok(r.answer.split(/\s+/).length <= 52);
  const lines: string[] = [];
  const e = await runResearch(parseResearchArgs("  "), { config: cfg(), chat: async () => { throw new Error("no"); }, report: (l) => lines.push(l), env: {} });
  assert.equal(e.answer, "");
  assert.match(lines[0]!, /usage: \/research/);
});

test("research: GITHUB_TOKEN goes only to api.github.com and is never in the log, trace, report, prompts or answer", async () => {
  const dir = tmp();
  const logFile = join(dir, "calls.jsonl");
  const env = { GITHUB_TOKEN: TOKEN, TINYCODE_LOG: logFile };
  const calls: Call[] = [];
  const reports: string[] = [];
  const leaky = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    // a server that echoes the credential back in its error text, to test redaction
    if (url.includes("/search/code")) return { ok: false, status: 500, text: async () => TOKEN };
    return fakeFetch([])(url, init);
  };
  // the real chat() with an injected transport, so the real call log is written
  const messagesSeen: string[] = [];
  const transport = async (req: { body: unknown }) => {
    const body = req.body as { messages: Message[]; response_format: { json_schema: { name: string } } };
    messagesSeen.push(JSON.stringify(body));
    const name = body.response_format.json_schema.name;
    const turn = messagesSeen.length;
    const content = name === "answer" ? ANSWER : turn === 1 ? { tool: "github_repos", arg: "tables" } : turn === 2 ? { tool: "github_code", arg: `${TOKEN}` } : turn === 3 ? { tool: "fetch", arg: "https://github.com/a/tabulate" } : { tool: "done", arg: "" };
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
  };
  const chat = (step: string, m: Message[], o?: object) => realChat(step, m, { ...o, transport, config: cfg() && mergeConfig({}), env });
  const r = await runResearch({ question: "tables" }, { config: mergeConfig({}), chat, fetch: leaky as never, report: (l) => reports.push(l), env });
  assert.ok(calls.length >= 3);
  for (const c of calls) {
    if (c.url.startsWith("https://api.github.com/")) assert.equal(c.auth, `Bearer ${TOKEN}`);
    else assert.equal(c.auth, undefined, `token leaked to ${c.url}`);
  }
  const everything = [readFileSync(logFile, "utf8"), JSON.stringify(r), reports.join("\n"), messagesSeen.join("\n"), formatResearch(r)].join("\n");
  assert.ok(!everything.includes(TOKEN), "token found in logs/prompts/output");
  assert.ok(!everything.includes("SECRETtoken"));
  assert.equal(readFileSync(logFile, "utf8").trim().split("\n").length, messagesSeen.length);
});

test("htmlToText: drops scripts/styles/tags, decodes entities, keeps breaks", () => {
  const t = htmlToText("<style>a{}</style><h1>Hi</h1><p>a &lt;b&gt; &amp; c</p><ul><li>one</li><li>two</li></ul><!-- c -->");
  assert.equal(t, "Hi\n\na <b> & c\n\none\n\ntwo");
});

test("plan: wantsResearch fires on prior art or an unfamiliar library; known libs and plain requests do not", () => {
  const d = tmp();
  writeFileSync(join(d, "requirements.txt"), "flask\nrich==13\n");
  assert.ok(wantsResearch("is there a library for parsing cron strings? build a CLI", d));
  assert.ok(wantsResearch("a dashboard using the textual library", d));
  assert.equal(unfamiliarLibrary("a dashboard using the textual library", d), "textual");
  assert.ok(!wantsResearch("print tables using the rich library", d));
  assert.ok(!wantsResearch("a CLI habit tracker with add, check and list, JSON storage, pytest", d));
  assert.ok(!wantsResearch("use the standard library to parse dates", d));
});

const GOOD_PLAN = { spec: "s", stack: "py", tasks: [1, 2, 3].map((i) => ({ id: i, title: `t${i}`, files: [`a${i}.py`], test: `test ${i}` })) };

test("plan: one research call, its answer (only the answer) enters the plan prompt; a failure plans without it", async () => {
  const d = tmp();
  let asked = 0;
  const seen: Message[][] = [];
  const chat = async (_s: string, m: Message[]) => { seen.push(structuredClone(m)); return reply(GOOD_PLAN); };
  const research = async (q: string) => { asked++; assert.match(q, /textual/); return "Use textual.\n\nSources:\n- https://github.com/Textualize/textual"; };
  const r = await runPlan({ request: "a dashboard using the textual library" }, { cwd: d, config: mergeConfig({}), chat, report: () => {}, research });
  assert.equal(asked, 1);
  assert.equal(r.researched, true);
  assert.match(seen[0]![1]!.content, /Research notes[\s\S]*Use textual[\s\S]*Request: a dashboard/);
  // not needed: never called
  const r2 = await runPlan({ request: "a habit tracker CLI with json storage" }, { cwd: tmp(), config: mergeConfig({}), chat, report: () => {}, research });
  assert.equal(asked, 1);
  assert.equal(r2.researched, false);
  // failing research: reported, plan still made
  const lines: string[] = [];
  const r3 = await runPlan({ request: "prior art for a habit tracker" }, { cwd: tmp(), config: mergeConfig({}), chat, report: (l) => lines.push(l), research: async () => { throw new Error("offline"); } });
  assert.ok(r3.plan);
  assert.equal(r3.researched, false);
  assert.ok(lines.some((l) => /research skipped: offline/.test(l)));
});
