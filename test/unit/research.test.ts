import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig } from "../../src/config.ts";
import { chat as realChat, type ChatResult, type Message } from "../../src/llm.ts";
import { runPlan, unfamiliarLibrary, wantsResearch } from "../../src/workflows/plan.ts";
import { fetchText, formatResearch, htmlToText, parseResearchArgs, privateAddress, ReplayError, runResearch, urlAllowed } from "../../src/workflows/research.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { approxTokens } from "../../src/limits.ts";
import { compact, RESULT_CAP } from "../../src/tools.ts";
import { checkFacts, factsBlock, quoteCitations, quoteContext, quoteWindow, RESEARCH_SYSTEM, RESEARCH_SYSTEM_LOCAL, type ResearchResult } from "../../src/workflows/research.ts";

const TOKEN = "ghp_SECRETtoken1234567890";
const tmp = () => tmpDir("tc-res-");
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

test("urlAllowed/privateAddress: mapped, unspecified, link-local, trailing-dot and NAT64 forms are refused (security audit 2026-11-09)", () => {
  for (const u of ["http://[::ffff:127.0.0.1]:9/", "http://[::ffff:7f00:1]/", "http://[::]/", "http://[fe81::1]/", "http://[fec0::1]/", "http://localhost./", "http://169.254.169.254/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2002:7f00:1::]/", "http://198.18.0.1/", "http://0.0.0.0/"])
    assert.equal(urlAllowed(u), false, u);
  for (const u of ["https://github.com/a/b", "http://[2606:4700::1111]/", "https://8.8.8.8/"]) assert.equal(urlAllowed(u), true, u);
  assert.equal(privateAddress("10.1.2.3"), true);
  assert.equal(privateAddress("1.1.1.1"), false);
  assert.equal(privateAddress("not an ip"), true);
});

test("fetchText: every redirect hop is checked; a public name that resolves privately is refused (security audit 2026-11-09)", async () => {
  const hops = (to: string) => async (url: string) =>
    url === "https://public.example/" ? { ok: false, status: 302, headers: { get: (h: string) => (h === "location" ? to : null) }, text: async () => "" } : { ok: true, status: 200, headers: { get: () => "text/plain" }, text: async () => `page ${url}` };
  await assert.rejects(fetchText("https://public.example/", hops("http://127.0.0.1:8080/"), 200), /only public/);
  await assert.rejects(fetchText("https://public.example/", hops("http://[::ffff:127.0.0.1]/x"), 200), /only public/);
  assert.equal(await fetchText("https://public.example/", hops("/docs"), 200), "page https://public.example/docs");
  const loop = async () => ({ ok: false, status: 301, headers: { get: () => "https://public.example/" }, text: async () => "" });
  await assert.rejects(fetchText("https://public.example/", loop, 200), /redirects/);
  const ok = async () => ({ ok: true, status: 200, headers: { get: () => "text/plain" }, text: async () => "fine" });
  await assert.rejects(fetchText("https://rebind.example/", ok, 200, async () => ["127.0.0.1"]), /resolves to a private address/);
  assert.equal(await fetchText("https://good.example/", ok, 200, async () => ["93.184.216.34"]), "fine");
});

// ---------------------------------------------------------------- research.replay (design research-replay)

const SEARCH = "https://api.github.com/search/repositories?q=duration%20parser&sort=stars&order=desc&per_page=6";
function recording(responses: Record<string, unknown>, version: unknown = 1): string {
  const p = join(tmp(), "replay.json");
  writeFileSync(p, JSON.stringify({ version, responses }));
  return p;
}
/** globalThis.fetch replaced by a spy that fails the test: with replay set nothing may reach the network */
async function noNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => {
    throw new Error(`network used: ${String(u)}`);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("replay: a recorded GitHub search is served; an unrecorded URL is 'not recorded'; the network is never used", async () => {
  const replay = recording({ [SEARCH]: { status: 200, contentType: "application/json", body: JSON.stringify(REPOS) } });
  const s = script({ tool: "github_repos", arg: "duration parser" }, { tool: "fetch", arg: "https://example.org/nope" }, { tool: "done", arg: "" }, ANSWER);
  const r = await noNetwork(() => runResearch({ question: "duration parsers" }, { config: cfg({ replay }), chat: s.fn, env: {} }));
  assert.match(s.seen[1]!.messages.at(-1)!.content, /a\/tabulate \(900 stars/);
  assert.match(s.seen[2]!.messages.at(-1)!.content, /fetch failed: not recorded: https:\/\/example\.org\/nope/);
  assert.deepEqual(r.sources, ["https://github.com/a/tabulate", "https://github.com/b/rich"]);
});

test("replay: a recorded 301 with a location is followed by the fetch tool; no DNS query even with a lookup injected", async () => {
  const replay = recording({
    "https://example.org/old": { status: 301, location: "https://example.org/docs/", body: "" },
    "https://example.org/docs/": { status: 200, contentType: "text/html", body: "<h1>Docs</h1><p>use strict=True</p>" },
  });
  let lookups = 0;
  const s = script({ tool: "fetch", arg: "https://example.org/old" }, { tool: "done", arg: "" }, { answer: "strict=True", sources: [] });
  await noNetwork(() => runResearch({ question: "strict flag" }, { config: cfg({ replay }), chat: s.fn, env: {}, lookup: async () => (lookups++, ["93.184.216.34"]) }));
  assert.match(s.seen[1]!.messages.at(-1)!.content, /Docs\s+use strict=True/);
  assert.equal(lookups, 0);
});

test("replay fails closed: a missing file, bad JSON, version 2 or a bad entry stops before any model call", async () => {
  const bad = join(tmp(), "bad.json");
  writeFileSync(bad, "{not json");
  for (const [replay, why] of [
    [join(tmp(), "missing.json"), /ENOENT/],
    [bad, /JSON/],
    [recording({}, 2), /version must be 1/],
    [recording({ [SEARCH]: { body: "x" } }), /needs a status/],
  ] as const) {
    let chats = 0;
    await assert.rejects(
      noNetwork(() => runResearch({ question: "q" }, { config: cfg({ replay }), chat: async () => (chats++, reply("{}")), env: {} })),
      (e: unknown) => e instanceof ReplayError && why.test((e as Error).message) && (e as Error).message.startsWith(`research.replay: cannot use ${replay}`),
    );
    assert.equal(chats, 0, String(replay));
  }
});

test("replay: /plan stops with the ReplayError instead of planning without research", async () => {
  const d = tmp();
  const replay = join(d, "missing.json");
  const research = async (q: string) => (await runResearch({ question: q }, { config: cfg({ replay }), chat: async () => reply("{}"), env: {} })).answer;
  await assert.rejects(
    runPlan({ request: "add a dependency to parse durations, which library on GitHub?" } as never, { cwd: d, config: cfg({ replay }), chat: async () => reply("{}"), report: () => {}, research } as never),
    ReplayError,
  );
});

test("replay config: null and an absolute path are accepted; a relative path or a number is a ConfigError", () => {
  assert.equal(cfg().research.replay, null);
  assert.equal(cfg({ replay: "/abs/rec.json" }).research.replay, "/abs/rec.json");
  assert.throws(() => cfg({ replay: "rec.json" }), /research\.replay: must be null or an absolute path/);
  assert.throws(() => cfg({ replay: 3 }), /research\.replay/);
});

test("replay: an injected fetch still wins (the unit tests' own fakes)", async () => {
  const calls: Call[] = [];
  const s = script({ tool: "github_repos", arg: "x" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ replay: join(tmp(), "missing.json") }), chat: s.fn, fetch: fakeFetch(calls) as never, env: {} });
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- E19: local first, a failed source dropped (design research-grounding)

const enumOf = (o: unknown): string[] => (o as { schema: { properties: { tool: { enum: string[] } } } }).schema.properties.tool.enum;
const lastObs = (s: { seen: { messages: Message[] }[] }, i: number) => s.seen[i]!.messages.at(-1)!.content;
/** A fetch with a fixed answer per URL prefix: a number is that HTTP status, "net" throws like a refused connection. */
function stubFetch(calls: string[], table: [string, number | "net"][]) {
  return async (url: string) => {
    calls.push(url);
    const hit = table.find(([p]) => url.startsWith(p))?.[1] ?? 404;
    if (hit === "net") throw new Error("fetch failed: ECONNREFUSED");
    return { ok: hit >= 200 && hit < 300, status: hit, headers: { get: () => "text/plain" }, text: async () => (hit < 300 ? JSON.stringify(REPOS) : "") };
  };
}

test("E19 prompt: localFirst sends project questions to find first; off, today's text", async () => {
  for (const [localFirst, want] of [[true, RESEARCH_SYSTEM_LOCAL], [false, RESEARCH_SYSTEM]] as const) {
    const s = script({ tool: "done", arg: "" }, ANSWER);
    await runResearch({ question: "q" }, { config: cfg({ localFirst }), chat: s.fn, fetch: fakeFetch([]) as never, env: {} });
    assert.equal(s.seen[0]!.messages[0]!.content, want);
  }
  assert.match(RESEARCH_SYSTEM_LOCAL, /vendors or pins: find first\. Library or prior-art question: github_repos/);
  assert.equal(RESEARCH_SYSTEM_LOCAL.split("\n").slice(0, -1).join("\n"), RESEARCH_SYSTEM.split("\n").slice(0, -1).join("\n"));
});

test("E19 drop: a network failure on github_repos drops both GitHub tools, with one note; a dropped tool is answered without a call", async () => {
  const calls: string[] = [];
  const s = script({ tool: "github_repos", arg: "a" }, { tool: "github_code", arg: "b" }, { tool: "github_repos", arg: "c" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: s.fn, fetch: stubFetch(calls, [["https://api.github.com", "net"]]) as never, env: {} });
  assert.deepEqual(enumOf(s.seen[0]!.opts), ["github_repos", "github_code", "fetch", "find", "done"]);
  assert.deepEqual(enumOf(s.seen[1]!.opts), ["fetch", "find", "done"]);
  assert.match(lastObs(s, 1), /github_repos failed: fetch failed: ECONNREFUSED \(GitHub dropped for this run\)/);
  assert.match(lastObs(s, 2), /github_code dropped this run \(github_repos failed: fetch failed: ECONNREFUSED\); use another tool or done/);
  assert.match(lastObs(s, 3), /github_repos dropped this run/);
  assert.equal(calls.length, 1);
});

test("E19 drop: 403 on github_code drops only it; 422 and 500 drop nothing", async () => {
  const calls: string[] = [];
  const s = script({ tool: "github_code", arg: "a" }, { tool: "github_repos", arg: "b" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: s.fn, fetch: stubFetch(calls, [["https://api.github.com/search/code", 403], ["https://api.github.com/search/repositories", 200]]) as never, env: {} });
  assert.deepEqual(enumOf(s.seen[1]!.opts), ["github_repos", "fetch", "find", "done"]);
  assert.match(lastObs(s, 1), /GitHub HTTP 403.*\(github_code dropped for this run\)/);
  assert.match(lastObs(s, 2), /a\/tabulate/);
  for (const status of [422, 500]) {
    const c: string[] = [];
    const t = script({ tool: "github_repos", arg: "a" }, { tool: "github_repos", arg: "b" }, { tool: "done", arg: "" }, ANSWER);
    await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: t.fn, fetch: stubFetch(c, [["https://api.github.com", status]]) as never, env: {} });
    assert.deepEqual(enumOf(t.seen[2]!.opts), ["github_repos", "github_code", "fetch", "find", "done"], String(status));
    assert.equal(c.length, 2, String(status));
    assert.doesNotMatch(lastObs(t, 1), /dropped/);
  }
});

test("E19 drop: GitHub's body not JSON drops nothing", async () => {
  const c: string[] = [];
  const bad = async (url: string) => (c.push(url), { ok: true, status: 200, text: async () => "<html>" });
  const t = script({ tool: "github_repos", arg: "a" }, { tool: "github_repos", arg: "b" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: t.fn, fetch: bad as never, env: {} });
  assert.equal(c.length, 2);
  assert.doesNotMatch(lastObs(t, 1), /dropped/);
});

test("E19 drop: fetch network failure and 429 drop the host (no later fetch there); 404, redirects and a refused URL drop nothing", async () => {
  for (const [first, drops] of [["net", true], [429, true], [404, false]] as const) {
    const calls: string[] = [];
    const s = script({ tool: "fetch", arg: "https://docs.example.org/a" }, { tool: "fetch", arg: "https://docs.example.org/b" }, { tool: "fetch", arg: "https://other.example.org/c" }, { tool: "done", arg: "" }, ANSWER);
    await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: s.fn, fetch: stubFetch(calls, [["https://docs.example.org", first], ["https://other.example.org", 200]]) as never, env: {} });
    assert.equal(calls.filter((u) => u.includes("docs.example.org")).length, drops ? 1 : 2, String(first));
    assert.equal(calls.filter((u) => u.includes("other.example.org")).length, 1, "another host still works");
    if (drops) assert.match(lastObs(s, 2), /fetch dropped this run for docs\.example\.org/);
    assert.deepEqual(enumOf(s.seen[3]!.opts), ["github_repos", "github_code", "fetch", "find", "done"], "fetch stays in the enum");
  }
  // too many redirects, and a refused private URL: the model's choice, not the host's fault
  const calls: string[] = [];
  const loop = async (url: string) => (calls.push(url), { ok: false, status: 302, headers: { get: (n: string) => (n === "location" ? url + "x" : null) }, text: async () => "" });
  const s = script({ tool: "fetch", arg: "https://r.example.org/" }, { tool: "fetch", arg: "https://r.example.org/other" }, { tool: "fetch", arg: "http://127.0.0.1/" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: s.fn, fetch: loop as never, env: {} });
  assert.match(lastObs(s, 1), /more than 4 redirects/);
  assert.doesNotMatch(lastObs(s, 1), /dropped/);
  assert.equal(calls.filter((u) => u.startsWith("https://r.example.org/other")).length, 5, "the second URL on the same host is fetched");
  assert.match(lastObs(s, 3), /only public http/);
  assert.doesNotMatch(lastObs(s, 3), /dropped/);
});

test("E19 drop: replay with the empty recording drops both GitHub tools after one 'not recorded'", async () => {
  const replay = recording({});
  const s = script({ tool: "github_repos", arg: "spanparse" }, { tool: "github_repos", arg: "spanparse python" }, { tool: "find", arg: "spanparse unknown unit" }, { tool: "done", arg: "" }, ANSWER);
  await noNetwork(() => runResearch({ question: "q" }, { config: cfg({ replay, localFirst: true }), chat: s.fn, find: async () => "vendor/spanparse/__init__.py:22", env: {} }));
  assert.match(lastObs(s, 1), /github_repos failed: not recorded: https:\/\/api\.github\.com\/search\/repositories\?q=spanparse.* \(GitHub dropped for this run\)/);
  for (const i of [1, 2, 3]) assert.ok(!enumOf(s.seen[i]!.opts).some((t) => t.startsWith("github")), String(i));
  assert.match(lastObs(s, 2), /github_repos dropped this run \(github_repos failed: not recorded/);
});

test("E19 nudge: a bad reply lists only the live tools", async () => {
  const s = script({ tool: "github_repos", arg: "a" }, "not json", { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: s.fn, fetch: stubFetch([], [["https://api.github.com", "net"]]) as never, env: {} });
  assert.match(lastObs(s, 2), /one of fetch, find, done>/);
});

test("E19 off (default): a failed source is not dropped, the schema and nudge are today's", async () => {
  const calls: string[] = [];
  const s = script({ tool: "github_repos", arg: "a" }, { tool: "github_repos", arg: "b" }, "not json", { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg(), chat: s.fn, fetch: stubFetch(calls, [["https://api.github.com", "net"]]) as never, env: {} });
  assert.equal(calls.length, 2);
  assert.equal(lastObs(s, 1), "Result:\ngithub_repos failed: fetch failed: ECONNREFUSED\nSteps left: 7.");
  for (const x of s.seen.slice(0, 4)) assert.deepEqual(enumOf(x.opts), ["github_repos", "github_code", "fetch", "find", "done"]);
  assert.match(lastObs(s, 3), /one of github_repos, github_code, fetch, find, done>/);
});

// ---------------------------------------------------------------- E20: quoted citations, checked facts (design research-grounding)

const LONG = "x".repeat(260) + " raises RetryBudgetExceeded when the deadline is hit " + "y".repeat(200);
/** A git repo with tracked files and an untracked .env; returns its path. */
function quoteRepo(extra: Record<string, string> = {}): string {
  const d = tmp();
  mkdirSync(join(d, "pkg"));
  const files: Record<string, string> = {
    "a.py": "import os\n\ndef run(x):\n    return x\n\n\n\n\n\nEND = 1\n",
    "crlf.py": "first = 1\r\nsecond = 2\r\n",
    "pkg/b.py": "VALUE = 3\n",
    "long.md": `${LONG}\n`,
    "guide.md": "## timeout_s\nTime limit of one single attempt.\nIt never limits the call as a whole.\n\n## deadline_s\nCaps the whole call: all attempts and sleeps.\n",
    ...extra,
  };
  for (const [p, t] of Object.entries(files)) writeFileSync(join(d, p), t);
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["add", "."], { cwd: d });
  writeFileSync(join(d, ".env"), "SECRET=1\n");
  return d;
}

test("E20 quotes: path:line gets its line; a range 3 lines; unparsable left; CRLF; outside, absolute, untracked not quoted; a \\ path resolves", () => {
  const d = quoteRepo();
  const ctx = quoteContext(d, ["py"]);
  const out = quoteCitations(["answer text", "- a.py:3", "- a.py:3-9", "- crlf.py:2", "- see a.py line 3", "- a.py", "- ../a.py:1", `- ${join(d, "a.py")}:1`, "- .env:1", "- pkg\\b.py:1"].join("\n"), ctx);
  const lines = out.split("\n");
  assert.equal(lines[0], "answer text");
  assert.equal(lines[1], "- a.py:3: def run(x):");
  assert.deepEqual(lines.slice(2, 5), ["- a.py:3 (quoted above)", "- a.py:4: return x", "- a.py:5: "]);
  assert.equal(lines[5], "- crlf.py:2: second = 2");
  assert.deepEqual(lines.slice(6, 11), ["- see a.py line 3", "- a.py", "- ../a.py:1", `- ${join(d, "a.py")}:1`, "- .env:1"]);
  assert.equal(lines[11], "- pkg/b.py:1: VALUE = 3");
  assert.ok(ctx.shown.has("a.py:3") && ctx.shown.has("a.py:5") && !ctx.shown.has("a.py:6") && ctx.shown.has("pkg/b.py:1"));
  assert.equal(quoteCitations("- long.md:1", ctx), `- long.md:1: ${LONG.slice(0, 240)}`);
});

test("E20 facts: quote at its line kept; elsewhere dropped and counted; line+2 kept, line+3 dropped; far from shown lines dropped", () => {
  const d = quoteRepo();
  const ctx = quoteContext(d, ["py"]);
  quoteCitations("- guide.md:2\n- a.py:3", ctx);
  const fact = (cite: string, quote: string) => ({ claim: "c", cite, quote });
  const r = checkFacts([fact("guide.md:2", "time limit of one single attempt"), fact("guide.md:2", "caps the whole call: all attempts"), fact("guide.md:2", "`It never limits the call as a whole.`"), fact("guide.md:3", "Caps the whole call")], ctx, new Set(), []);
  assert.deepEqual(r.facts.map((f) => f.quote), ["time limit of one single attempt", "it never limits the call as a whole."]);
  assert.equal(r.dropped, 2);
  assert.equal(r.facts[1]!.window, "Time limit of one single attempt. It never limits the call as a whole.");
  // a.py:3 was shown; a.py:10 is 7 lines away: dropped although the quote is there
  const far = checkFacts([fact("a.py:10", "END = 1"), fact("a.py:3", "def run(x)"), fact("a.py:3", "short"), fact(".env:1", "SECRET=1")], ctx, new Set(), []);
  assert.deepEqual(far.facts.map((f) => f.cite), ["a.py:3"]);
  assert.equal(far.dropped, 3);
});

test("E20 facts: a URL fact is kept when its quote is in a page with that URL, dropped when the URL was never seen", () => {
  const page = { urls: new Set(["https://ex.org/docs"]), text: "Docs. The strict flag rejects unknown units since 1.3." };
  const seen = new Set(["https://ex.org/docs"]);
  const r = checkFacts([{ claim: "strict", cite: "https://ex.org/docs", quote: "rejects unknown units" }, { claim: "made up", cite: "https://ex.org/other", quote: "rejects unknown units" }], null, seen, [page]);
  assert.deepEqual(r.facts.map((f) => f.cite), ["https://ex.org/docs"]);
  assert.equal(r.dropped, 1);
});

test("E20 run: find results quoted inside the branch, facts checked, the facts block first; a cut summary keeps no facts and no raw JSON", async () => {
  const d = quoteRepo();
  const reports: string[] = [];
  const summary = { answer: "Use deadline_s.", sources: [], facts: [{ claim: "timeout_s is one attempt", cite: "guide.md:2", quote: "Time limit of one single attempt" }, { claim: "wrong", cite: "guide.md:2", quote: "caps the whole call as a whole" }] };
  const s = script({ tool: "find", arg: "timeout" }, { tool: "done", arg: "" }, summary);
  const r = await runResearch({ question: "q" }, { config: cfg({ grounded: true }), chat: s.fn, fetch: fakeFetch([]) as never, find: async () => "timeout_s limits one attempt\n- guide.md:2\n- guide.md:3", cwd: d, report: (l) => reports.push(l), env: {} });
  assert.equal(lastObs(s, 1), "Result:\ntimeout_s limits one attempt\n- guide.md:2: Time limit of one single attempt.\n- guide.md:3: It never limits the call as a whole.\nSteps left: 7.");
  assert.equal(r.facts.length, 1);
  assert.equal(r.dropped, 1);
  assert.deepEqual(reports, [], "no per-step lines with grounded");
  const opts = s.seen[2]!.opts as { schema: { required: string[] }; maxTokens: number };
  assert.deepEqual(opts.schema.required, ["answer", "sources", "facts"]);
  assert.equal(opts.maxTokens, 300 + 4 * 130);
  assert.match(s.seen[2]!.messages.at(-1)!.content, /Max 100 words[\s\S]*"facts": 1-4 key facts/);
  assert.equal(formatResearch(r), "Facts (quoted, read from the files):\n- timeout_s is one attempt — guide.md:2: Time limit of one single attempt. It never limits the call as a whole.\n1 fact dropped: its quote is not at the cited place.\n\nUse deadline_s.");
  // cut at length: the answer recovered, no facts, no JSON
  const cut = script({ tool: "done", arg: "" }, '{"answer": "Use deadline_s, it caps', );
  const cutChat = async (st: string, m: Message[], o?: unknown) => ({ ...(await cut.fn(st, m, o)), finish: "length" });
  const rc = await runResearch({ question: "q" }, { config: cfg({ grounded: true }), chat: cutChat, fetch: fakeFetch([]) as never, cwd: d, env: {} });
  assert.equal(rc.answer, "Use deadline_s, it caps");
  assert.deepEqual(rc.facts, []);
  const junk = script({ tool: "done", arg: "" }, '{"sources": [');
  const rj = await runResearch({ question: "q" }, { config: cfg({ grounded: true }), chat: junk.fn, fetch: fakeFetch([]) as never, cwd: d, env: {} });
  assert.equal(rj.answer, "");
});

test("E20: a quoted tracked line carrying GITHUB_TOKEN is redacted in the branch and in the facts", async () => {
  const d = quoteRepo({ "conf.py": `TOKEN = "${TOKEN}"  # the deploy token\n` });
  const s = script({ tool: "find", arg: "token" }, { tool: "done", arg: "" }, { answer: "see conf", sources: [], facts: [{ claim: "token set", cite: "conf.py:1", quote: "the deploy token" }] });
  const r = await runResearch({ question: "q" }, { config: cfg({ grounded: true }), chat: s.fn, fetch: fakeFetch([]) as never, find: async () => "- conf.py:1", cwd: d, env: { GITHUB_TOKEN: TOKEN } });
  const everything = JSON.stringify(s.seen.map((x) => x.messages)) + JSON.stringify(r) + formatResearch(r);
  assert.ok(!everything.includes(TOKEN));
  assert.match(lastObs(s, 1), /conf\.py:1: TOKEN = "\*\*\*"/);
  assert.equal(r.facts.length, 1);
  assert.match(r.facts[0]!.window, /\*\*\*/);
});

test("E20 window: centred on a quote past character 240 of a long line, with ... where cut", () => {
  const w = quoteWindow(LONG, "raises retrybudgetexceeded", 240)!;
  assert.ok(w.length <= 240);
  assert.ok(w.startsWith("...") && w.endsWith("..."));
  assert.match(w, /raises RetryBudgetExceeded when the deadline is hit/);
  assert.equal(quoteWindow("short line", "short", 240), "short line");
  assert.equal(quoteWindow("short line", "absent", 240), null);
});

test("E20 size: a 4-fact block is at most 330 tokens; the worst-case tool text fits RESULT_CAP with the facts intact", () => {
  const facts = Array.from({ length: 4 }, (_, i) => ({ claim: "c".repeat(80), cite: `vendor/retryline/docs/guide-${i}.md:467`.padEnd(60, "x"), quote: "q", window: "w".repeat(240) }));
  // checkFacts sizes the window to the line; emulate its cut on these maximal claims and cites
  const sized = facts.map((f) => ({ ...f, window: f.window.slice(0, 300 - 7 - f.claim.length - f.cite.length) }));
  const block = factsBlock({ facts: sized, dropped: 3 });
  assert.ok(approxTokens(block.length) <= 330, String(approxTokens(block.length)));
  // a typical fact keeps its full 240-character window
  const typical = Array.from({ length: 4 }, () => ({ claim: "the option", cite: "vendor/retryline/core.py:39", quote: "q", window: "w".repeat(240) }));
  assert.ok(approxTokens(factsBlock({ facts: typical, dropped: 1 }).length) <= 330);
  const r: ResearchResult = { answer: Array.from({ length: 100 }, () => "wordy").join(" ") + " ...", sources: Array.from({ length: 6 }, (_, i) => `https://github.com/owner-${i}/a-rather-long-repository-name-${i}`), steps: 8, tokens: 0, stopped: "steps", trace: [], facts: sized, dropped: 3 };
  const text = `research done: answered in 8 step(s) (steps), 6 source(s)\n${formatResearch(r)}\n(8 steps, 29000 tokens, steps)`;
  const shown = compact(text);
  assert.ok(shown.length <= RESULT_CAP);
  assert.ok(shown.includes(block), "the facts block is never what compact cuts");
  // the same with checkFacts on a real file: windows and lines within budget
  const d = quoteRepo();
  const ctx = quoteContext(d, ["py"]);
  quoteCitations("- long.md:1", ctx);
  const real = checkFacts(Array.from({ length: 4 }, () => ({ claim: "k".repeat(200), cite: "long.md:1", quote: "raises RetryBudgetExceeded" })), ctx, new Set(), []);
  assert.equal(real.facts.length, 4);
  for (const f of real.facts) assert.ok(`- ${f.claim} — ${f.cite}: ${f.window}`.length <= 300);
  assert.ok(approxTokens(factsBlock(real).length) <= 330);
});

test("E20 token cap: with grounded the loop runs to 1.5x maxTokens", async () => {
  for (const [grounded, steps] of [[false, 3], [true, 4]] as const) {
    const s = script(...Array.from({ length: 10 }, (_, i) => ({ tool: "github_repos", arg: `q${i}` })), { answer: "a", sources: [], facts: [] });
    const big = async (st: string, m: Message[], o?: unknown) => ({ ...(await s.fn(st, m, o)), usage: { prompt_tokens: 900, cached_tokens: 0, completion_tokens: 100 } });
    const r = await runResearch({ question: "q" }, { config: cfg({ maxTokens: 2500, maxSteps: 8, grounded }), chat: big, fetch: fakeFetch([]) as never, env: {} });
    assert.equal(r.stopped, "tokens");
    assert.equal(r.steps, steps, String(grounded));
  }
});

test("E20 off (default): no quoting, today's summary schema and size, formatResearch byte for byte", async () => {
  const d = quoteRepo();
  const reports: string[] = [];
  const s = script({ tool: "find", arg: "x" }, { tool: "done", arg: "" }, { ...ANSWER, facts: [{ claim: "c", cite: "a.py:3", quote: "def run(x)" }] });
  const r = await runResearch({ question: "q" }, { config: cfg(), chat: s.fn, fetch: fakeFetch([]) as never, find: async () => "- a.py:3", cwd: d, report: (l) => reports.push(l), env: {} });
  assert.equal(lastObs(s, 1), "Result:\n- a.py:3\nSteps left: 7.");
  const opts = s.seen[2]!.opts as { schema: { required: string[] }; maxTokens: number };
  assert.deepEqual(opts.schema.required, ["answer", "sources"]);
  assert.equal(opts.maxTokens, 500);
  assert.deepEqual(r.facts, []);
  assert.equal(r.dropped, 0);
  assert.deepEqual(reports, ["research 1/8: find"]);
  assert.equal(formatResearch(r), "tabulate is small; rich is bigger.");
});

// E19 cost (research-3, window 3 2026-11-12): the loop called `find` with a file path ("ISSUES/0212.md") four times;
// each was a ~1.3k-token branch call that answered "not present" (find greps contents, its outline was cut). With
// localFirst on, a find argument that names one tracked file returns that file's numbered lines, with no branch call.
test("E19: find with a tracked file path (exact or a unique suffix) reads the file, no branch call", async () => {
  const cwd = tmpDir("tc-research-findpath-");
  mkdirSync(join(cwd, "vendor/tablekit/ISSUES"), { recursive: true });
  writeFileSync(join(cwd, "vendor/tablekit/ISSUES/0212.md"), "# 0212 column width -1\nfixed in 2.4.1\n");
  writeFileSync(join(cwd, "vendor/tablekit/ISSUES/0219.md"), "# 0219 other\n");
  writeFileSync(join(cwd, "README.md"), "readme\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  let branchCalls = 0;
  const find = async () => { branchCalls++; return "branch answer"; };
  const s = script({ tool: "find", arg: "ISSUES/0212.md" }, { tool: "find", arg: "vendor/tablekit/ISSUES/0219.md" }, { tool: "find", arg: "where is the width check" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: s.fn, fetch: fakeFetch([]) as never, env: {}, cwd, find });
  assert.match(lastObs(s, 1), /vendor\/tablekit\/ISSUES\/0212\.md/);
  assert.match(lastObs(s, 1), /1: # 0212 column width -1\n2: fixed in 2\.4\.1/);
  assert.match(lastObs(s, 2), /2?1: # 0219 other/);
  assert.equal(branchCalls, 1, "only the question went to the branch");
  // off: unchanged, every find goes to the branch
  let off = 0;
  const t = script({ tool: "find", arg: "ISSUES/0212.md" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: false }), chat: t.fn, fetch: fakeFetch([]) as never, env: {}, cwd, find: async () => { off++; return "x"; } });
  assert.equal(off, 1);
});

test("E19: an ambiguous suffix (two files) or no match still goes to the branch", async () => {
  const cwd = tmpDir("tc-research-findpath2-");
  mkdirSync(join(cwd, "a"), { recursive: true });
  mkdirSync(join(cwd, "b"), { recursive: true });
  writeFileSync(join(cwd, "a/notes.md"), "a\n");
  writeFileSync(join(cwd, "b/notes.md"), "b\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  let n = 0;
  const s = script({ tool: "find", arg: "notes.md" }, { tool: "find", arg: "missing.md" }, { tool: "done", arg: "" }, ANSWER);
  await runResearch({ question: "q" }, { config: cfg({ localFirst: true }), chat: s.fn, fetch: fakeFetch([]) as never, env: {}, cwd, find: async () => { n++; return "branch"; } });
  assert.equal(n, 2);
});
