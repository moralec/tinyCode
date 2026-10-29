import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConfig } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { docArgsFromText, parseDocArgs, readmeHeadings, runDoc } from "../../src/workflows/doc.ts";
import {
  allowedTokens, badToken, checkSection, chunksOf, codeRelated, codeRuns, diffStat, enforce, extractJson, findReadme, mapProject, mdSections, matchSection, parseLog, partMaps, parseReadmeArgs, readmeLine, readmeSections, runReadme, specifics, FILE_CHARS,
} from "../../src/workflows/docreadme.ts";

type Json = Record<string, unknown>;
const ok = (j: Json): string => JSON.stringify(j);

function project(files: Record<string, string>, git = true) {
  const d = mkdtempSync(join(tmpdir(), "tinycode-readme-"));
  for (const [f, t] of Object.entries(files)) {
    if (t === undefined) continue;
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  if (git) {
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, stdio: "ignore" });
    g("init", "-q", ".");
    g("add", "-A");
    g("commit", "-qm", "first commit");
    writeFileSync(join(d, "NOTES.txt"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "second commit with a long subject");
  }
  return { cwd: d, env: { TINYCODE_LOG: join(d, "..", "state-" + Math.random(), "calls.jsonl") } };
}

const BIG = Array.from({ length: 700 }, (_, i) => `def helper_${i}(x):\n    return x + ${i}  # padding line\n`).join("\n");
const FILES: Record<string, string> = {
  "app/server.py": "PORT = 8080\n\ndef serve():\n    return 'ok'\n",
  "app/db.py": "def save(row):\n    return row\n",
  "app/big.py": BIG,
  "lib/util.js": "export const twice = (x) => x * 2;\n",
  "start.sh": "#!/bin/sh\npython3 app/server.py\n",
  "deploy/app.service": "[Unit]\nDescription=app\nAfter=queue-box.service\n[Service]\nExecStart=/usr/bin/python3 /srv/app/server.py\nEnvironment=APP_PORT=8080\n[Install]\nWantedBy=multi-user.target\n",
  "tests/test_db.py": "def test_save():\n    pass\n",
  "README.md": "# App\n\nOld intro text about the app.\n\n## What it is\n\nAn old description with 5 numbers and src/old.py in it.\n\n## Usage\n\nRun it with start.sh.\n\n## License\n\nMIT\n",
  "DESIGN.md": "design notes that must never be read\n",
};

interface Rec {
  step: string;
  system: string;
  user: string;
  schemaName?: string;
}
/** A scripted fake chat: answers by what the call is (its system prompt), records every call. */
function fake(answer: (kind: string, user: string, n: number) => string | Error) {
  const rec: Rec[] = [];
  const counts: Record<string, number> = {};
  const names: Record<string, number> = {};
  const chat = async (step: string, messages: Message[], opts?: { schemaName?: string }): Promise<ChatResult> => {
    const system = messages[0]!.content;
    const user = messages[messages.length - 1]!.content;
    const kind = /describe one source file/.test(system) ? "file"
      : /one part of a larger source file/.test(system) ? "chunk"
      : /consecutive parts of one source file/.test(system) ? "merge"
      : /summarise one folder/.test(system) ? "folder"
      : /check a short project overview/.test(system) ? "check"
      : /Section 'What it is'/.test(system) ? "what"
      : /Section 'How you use it'/.test(system) ? "use"
      : /Section 'How it works'/.test(system) ? "how"
      : /Section 'Data'/.test(system) ? "data"
      : /Section 'Project layout'/.test(system) ? "layout"
      : /check one section of a project's README/.test(system) ? "update" : "?";
    rec.push({ step, system, user, schemaName: opts?.schemaName });
    counts[kind] = (counts[kind] ?? 0) + 1;
    names[opts?.schemaName ?? "?"] = (names[opts?.schemaName ?? "?"] ?? 0) + 1;
    const a = answer(kind, user, counts[kind]!);
    if (a instanceof Error) throw a;
    return { text: a, usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "m", fellBack: false };
  };
  return { chat, rec, counts, names };
}

const goodHow = ok({
  parts: [
    { name: "Web server", does: "Answers requests from people using the app.", where: "app/server.py, start.sh" },
    { name: "Storage", does: "Saves rows that people submit.", where: "app/db.py" },
    { name: "Helper library", does: "Many small arithmetic helpers used elsewhere.", where: "app/big.py, lib/util.js" },
  ],
  flow: "Requests reach the server, which hands rows to storage.",
});

function standard(kind: string, user: string): string | Error {
  switch (kind) {
    case "file": return ok({ does: "Describes one file in plain words." });
    case "chunk": return ok({ does: "A run of small helper functions." });
    case "merge": return ok({ does: "A large set of arithmetic helpers." });
    case "folder": return ok({ summary: "Holds the main working parts of the application." });
    case "what": return ok({ text: "A small web application that stores rows for its users." });
    case "use": return ok({ text: "People open it in a browser, and an operator starts it from a script." });
    case "how": return goodHow;
    case "data": return ok({ text: "It keeps rows that users submit." });
    case "layout": {
      const names = [...user.matchAll(/^- (\S+) \((?:folder|file)/gm)].map((m) => m[1]!);
      return ok({ rows: names.map((n) => ({ name: n, does: "Part of the application." })) });
    }
    case "check": return ok({ unsupported: [] });
    default: return new Error("unexpected call " + kind);
  }
}

const run = async (cwd: string, env: Record<string, string>, chat: ReturnType<typeof fake>["chat"], args: string) => {
  const lines: string[] = [];
  const r = await runDoc(parseDocArgs(args), { cwd, config: mergeConfig({}), chat, report: (l) => lines.push(l), env });
  assert.equal(r.mode, "readme");
  return { r: r as Extract<typeof r, { mode: "readme" }>, lines };
};

test("specifics checker: digits, paths, dotted names, snake_case, camelCase, backticks and flags are flagged; code facts are allowed", () => {
  for (const t of ["8080", "src/a", "a.py", "snake_case", "camelCase", "`x`", "--flag"]) assert.ok(badToken(t), t);
  for (const t of ["plain", "e.g", "macOS", "word,", ""]) assert.ok(!badToken(t), t);
  assert.deepEqual(specifics("It listens on 8080 via server_main in app/x.py.", new Set(["8080"])), ["server_main", "app/x.py."].map((t) => t.replace(/\.$/, "")));
  assert.deepEqual(specifics("Port 8080 here.", new Set(["8080"])), []);
});

test("checkSection and enforce: caps, retry reasons, sentences dropped, how parts without a line dropped", () => {
  const allowed = new Set<string>();
  const long = Array.from({ length: 100 }, () => "word").join(" ") + ".";
  assert.ok(checkSection("what", { text: long }, allowed).some((p) => /cap is 90/.test(p)));
  assert.ok(checkSection("what", { text: "Uses app/db.py today." }, allowed)[0]!.includes("app/db.py"));
  assert.ok(checkSection("how", { parts: [{ name: "a", does: "b" }], flow: "" }, allowed).some((p) => /need 3 to 7/.test(p)));
  const e = enforce("what", { text: "It stores things. It runs on port 8080. It is small." }, allowed);
  assert.equal(e.ans.text, "It stores things. It is small.");
  assert.equal(e.dropped.length, 1);
  const h = enforce("how", { parts: [{ name: "Store", does: "Keeps rows." }, { name: "load_all", does: "Loads." }, { name: "Empty", does: "uses a.py" }], flow: "Data moves." }, allowed);
  assert.deepEqual((h.ans.parts as { name: string }[]).map((p) => p.name), ["Store"]);
  assert.equal(h.dropped.length, 3);
});

test("chunksOf cuts on line boundaries at 12k chars; partMaps matches by where, then fuzzily by name; mdSections/matchSection", () => {
  const cs = chunksOf(BIG);
  assert.ok(cs.length >= 2 && cs.every((c) => c.length <= FILE_CHARS) && cs.join("") === BIG);
  assert.equal(chunksOf("short\n").length, 1);
  assert.ok(partMaps({ name: "x", does: "", where: "app/db.py" }, ["app/db.py"]));
  assert.ok(partMaps({ name: "Storage database", does: "" }, ["app/database.py"]));
  assert.ok(!partMaps({ name: "Zebra stripes", does: "", where: "nope/" }, ["app/db.py"]));
  const secs = mdSections(["# T", "", "```", "# not a heading", "```", "## Usage", "x", "### Sub", "y"]);
  assert.deepEqual(secs.map((s) => s.title), ["T", "Usage", "Sub"]);
  assert.equal(matchSection("usage", secs)?.title, "Usage");
  assert.equal(matchSection("What", mdSections(["## What it is", "x"]))?.title, "What it is");
  assert.equal(matchSection("nothing here", secs), null);
  assert.deepEqual(parseLog("2026-10-29\tone\n2026-10-28\ttwo\nnoise\n").map((c) => c.subject), ["one", "two"]);
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("nope"), null);
  assert.deepEqual(parseReadmeArgs('--out site --max-files 7 --related a,b --update "X,Y" --name N'), { out: "site", maxFiles: 7, related: ["a", "b"], update: ["X", "Y"], name: "N" });
});

test("code-only facts: units, start scripts, own ports, related projects by calls (not mentions), git log", () => {
  const { cwd } = project(FILES);
  const map = mapProject(cwd);
  assert.ok(!map.files.some((f) => f.path === "node_modules"));
  const runs = codeRuns(map, "box", "app");
  assert.equal(runs.starts[0]!.how, "systemd unit");
  assert.deepEqual([runs.starts[0]!.name, runs.starts[0]!.runs, runs.starts[0]!.address, runs.starts[0]!.when], ["app.service", "server.py", "8080", "at boot or login"]);
  assert.ok(runs.starts.some((s) => s.how === "script" && s.name === "start.sh"));
  assert.deepEqual(runs.addresses.map((a) => a.address), ["8080"]);
  const rel = codeRelated("app", map, ["queue-box", "ghost-project"]);
  assert.deepEqual(rel.map((r) => [r.name, r.how, r.src]), [["queue-box", "systemd dependency", "deploy/app.service:3"]]);
  assert.ok(allowedTokens("app", runs, rel).has("8080"));
});

test("/doc readme: calls per file, folder and section; fixed template; embedded JSON; design docs never read", async () => {
  const { cwd, env } = project(FILES);
  const f = fake(standard);
  const { r, lines } = await run(cwd, env, f.chat, "readme");
  assert.equal(r.ok, true, lines.join("\n"));
  // files: server.py, db.py, util.js, start.sh, app.service (small: 1 call each); big.py is chunked then merged; tests, md, NOTES.txt are skipped
  const chunks = f.counts.chunk!;
  assert.ok(chunks >= 2 && chunks <= 12);
  assert.deepEqual([f.counts.file, f.counts.merge, f.counts.folder], [5, 1, 3], JSON.stringify(f.counts)); // files: the unit counts too; folders: app, deploy, lib
  assert.deepEqual([f.counts.what, f.counts.use, f.counts.how, f.counts.data, f.counts.layout, f.counts.check], [1, 1, 1, 1, 1, 1]);
  assert.equal(f.names.retry ?? 0, 0);
  assert.equal(r.calls, f.rec.length);
  assert.ok(f.rec.every((x) => x.step === "doc"));
  assert.ok(!f.rec.some((x) => /must never be read/.test(x.user)), "design docs are never model input");
  assert.ok(!f.rec.some((x) => x.user.includes("def helper_5(x)") && /^Folder:|Project:/.test(x.user)), "section and folder calls see summaries, not raw code");
  const html = readFileSync(join(cwd, "docs/overview.html"), "utf8");
  for (const id of ["what", "use", "how", "data", "runs", "layout", "related", "changes"]) assert.ok(html.includes(`<section id="${id}">`), id);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html));
  const data = JSON.parse(html.match(/<script type="application\/json" id="overview-data">\s*([\s\S]*?)\s*<\/script>/)![1]!);
  assert.equal(data.sections.what.text, "A small web application that stores rows for its users.");
  assert.deepEqual(data.sections.runs.addresses.map((a: { address: string }) => a.address), ["8080"]);
  assert.deepEqual(data.sections.changes.map((c: { subject: string }) => c.subject), ["second commit with a long subject", "first commit"]);
  assert.ok(data.files.length >= 5 && data.key_files.length >= 1);
  assert.ok(html.includes("app.service") && html.includes("Where it runs"));
});

test("/doc readme: the specifics check retries once with the tokens named, then drops the sentence; failures never abort", async () => {
  const { cwd, env } = project(FILES);
  const f = fake((kind, user, n) => {
    if (kind === "what") return n === 1 ? ok({ text: "It runs on port 9999 and reads src/old.py." }) : ok({ text: "A small web application for its users." });
    if (kind === "use") return ok({ text: "People open it. It calls save_row every minute. Operators start it." });
    if (kind === "data") return new Error("connection refused");
    return standard(kind, user);
  });
  const { r, lines } = await run(cwd, env, f.chat, "readme");
  assert.equal(r.ok, true);
  const retry = f.rec.filter((x) => /Fix these and answer again/.test(x.user));
  const whatRetry = retry.find((x) => /port 9999/.test(x.user))!;
  assert.ok(/names specific tokens: 9999, src\/old\.py/.test(whatRetry.user), whatRetry.user.slice(-300));
  // `use` fails the check twice (same answer), so the sentence with the identifier is dropped and reported
  assert.equal(f.counts.use, 2); // first answer + one retry, never a third call
  assert.equal(f.names.retry, 3, JSON.stringify(f.names)); // what, use, data (data had no usable answer)
  const data = JSON.parse(readFileSync(join(cwd, "docs/overview.html"), "utf8").match(/id="overview-data">\s*([\s\S]*?)\s*<\/script>/)![1]!);
  assert.equal(data.sections.what.text, "A small web application for its users.");
  assert.equal(data.sections.use.text, "People open it. Operators start it.");
  assert.equal(data.sections.data.text, "");
  assert.ok(r.dropped.some((d) => d.includes("save_row")));
  assert.ok(lines.some((l) => /connection refused/.test(l)));
  assert.ok(readFileSync(join(cwd, "docs/overview.html"), "utf8").includes("Not enough material to say."));
});

test("/doc readme: the self-check flags unsupported sentences (listed on the page data, never rewritten)", async () => {
  const { cwd, env } = project(FILES);
  const f = fake((kind, user) => {
    if (kind === "check") {
      const n = Number(user.match(/^(\d+)\. \[what\]/m)![1]);
      return ok({ unsupported: [{ n, why: "the notes do not mention users" }, { n: 999, why: "out of range" }] });
    }
    return standard(kind, user);
  });
  const { r } = await run(cwd, env, f.chat, "readme");
  assert.deepEqual(r.flagged, ["A small web application that stores rows for its users."]);
  const html = readFileSync(join(cwd, "docs/overview.html"), "utf8");
  assert.ok(html.includes("A small web application that stores rows for its users."));
  const data = JSON.parse(html.match(/id="overview-data">\s*([\s\S]*?)\s*<\/script>/)![1]!);
  assert.equal(data.self_check.length, 1);
  assert.equal(data.self_check[0].why, "the notes do not mention users");
});

test("/doc readme: model text is HTML-escaped and can neither inject a script nor a placeholder; --out and --max-files work", async () => {
  const { cwd, env } = project(FILES);
  const f = fake((kind, user) => (kind === "what" ? ok({ text: "Handles <b>bold input and {{TITLE}} safely." }) : kind === "file" ? ok({ does: "Evil </script><b>x</b> line." }) : standard(kind, user)));
  const { r } = await run(cwd, env, f.chat, "readme --out site --max-files 2");
  assert.equal(f.counts.file! + (f.counts.chunk ?? 0) + (f.counts.merge ?? 0) >= 2, true);
  assert.ok(f.counts.file! + (f.counts.merge ?? 0) <= 3);
  assert.equal(r.output, join(cwd, "site", "overview.html"));
  const html = readFileSync(r.output!, "utf8");
  assert.ok(!html.replace(/<script type="application\/json"[\s\S]*$/, "").includes("<b>bold"), "no raw tag in the visible page");
  assert.ok(html.includes("Handles &lt;b&gt;bold input"));
  assert.ok(html.includes("Evil <\\/script>"), "the embedded JSON escapes </");
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1, "only the template's own closing tag");
  assert.ok(html.includes("{{TITLE}} safely"), "a placeholder in model text is kept as text");
});

test("/doc readme --update: only the named sections change (spliced, rest byte-identical), one call each", async () => {
  const { cwd, env } = project(FILES);
  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const f = fake((kind, user) => (kind === "update" ? ok({ verdict: "revise", reason: "out of date", edits: user.includes("'Usage'") ? [{ search: "Run it with start.sh.", replace: "Start it from start.sh." }] : [{ search: "An old description", replace: "A small web application" }] }) : standard(kind, user)));
  const { r, lines } = await run(cwd, env, f.chat, 'readme --update "what,Usage"');
  assert.equal(r.ok, true, lines.join("\n"));
  assert.deepEqual(r.updated, ["What it is", "Usage"]);
  assert.equal(f.counts.update, 2);
  assert.equal(f.counts.what ?? 0, 0, "no overview sections are written in update mode");
  const after = readFileSync(join(cwd, "README.md"), "utf8");
  assert.equal(after, "# App\n\nOld intro text about the app.\n\n## What it is\n\nA small web application with 5 numbers and src/old.py in it.\n\n## Usage\n\nStart it from start.sh.\n\n## License\n\nMIT\n");
  assert.ok(after.startsWith("# App\n\nOld intro text about the app.\n") && after.endsWith("## License\n\nMIT\n"));
  assert.notEqual(after, before);
  // the old section text was shown to the call as background
  assert.ok(f.rec.find((x) => x.schemaName === "update")!.user.includes("An old description with 5 numbers"));
});

test("/doc readme --update refuses unknown headings and a missing README; a section with no usable answer is kept", async () => {
  const { cwd, env } = project(FILES);
  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const none = fake(() => new Error("must not be called"));
  const unknown = await run(cwd, env, none.chat, 'readme --update "Nonexistent"');
  assert.equal(unknown.r.reason, "no-section");
  assert.ok(unknown.lines.some((l) => l.includes("What it is | Usage | License")));
  assert.equal((await run(project({ "a.py": "x=1\n" }).cwd, env, none.chat, "readme --update Usage")).r.reason, "no-readme");
  assert.equal(none.rec.length, 0);
  const dead = fake((kind, user) => (kind === "update" ? new Error("down") : standard(kind, user)));
  const r = await run(cwd, env, dead.chat, "readme --update License");
  assert.equal(r.r.ok, false);
  assert.deepEqual(r.r.notChecked, ["License"]);
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before);
});

test("/doc readme on a non-git folder and an empty folder", async () => {
  const p = project({ "a.py": "def a():\n    return 1\n", "b/c.py": "def c():\n    return 2\n" }, false);
  const f = fake(standard);
  const { r } = await run(p.cwd, p.env, f.chat, "readme");
  assert.equal(r.ok, true);
  const data = JSON.parse(readFileSync(join(p.cwd, "docs/overview.html"), "utf8").match(/id="overview-data">\s*([\s\S]*?)\s*<\/script>/)![1]!);
  assert.deepEqual(data.sections.changes, []);
  const e = await run(project({}, false).cwd, p.env, fake(standard).chat, "readme");
  assert.equal(e.r.reason, "empty");
});

// ---------------------------------------------------------------- README sections, HTML, detection, intent

const ALLCAP_HTML = `<!doctype html>
<html><head><title>App</title><style>h2 { color: red }</style></head>
<body>
<h1>App</h1>
<p class="lead">Intro that is not a section.</p>
<h2>What it is</h2>
<p>An old description of the <b>app</b> with   odd   spacing.</p>
<h2>Usage</h2>
<ul><li>Run start.sh</li></ul>
<h2>License</h2>
<p>MIT</p>
</body></html>
`;

const verdicts = (revise: Record<string, { search: string; replace: string }[]>, extra?: (title: string) => Json | null) => (kind: string, user: string) => {
  if (kind !== "update") return standard(kind, user);
  const title = user.match(/Section '([^']+)'/)![1]!;
  const x = extra?.(title);
  if (x) return ok(x);
  return revise[title] !== undefined ? ok({ verdict: "revise", reason: "the code differs", edits: revise[title] }) : ok({ verdict: "ok", reason: "still true" });
};

test("findReadme: README.md, README.html, readme.html, docs/readme.html, docs/README.html, README.rst, README.txt, in that order", () => {
  const order = ["README.md", "README.html", "readme.html", "docs/readme.html", "docs/README.html", "README.rst", "README.txt"];
  for (let k = 0; k < order.length; k++) {
    const files: Record<string, string> = { "a.py": "x=1\n" };
    for (const n of order.slice(k)) files[n] = "x\n";
    const { cwd } = project(files, false);
    const f = findReadme(cwd)!;
    assert.equal(f.rel, order[k], `first of ${order.slice(k).join(",")}`);
    assert.equal(f.kind, order[k]!.endsWith(".html") ? "html" : order[k]!.endsWith(".rst") ? "rst" : order[k]!.endsWith(".txt") ? "txt" : "md");
  }
  assert.equal(findReadme(project({ "a.py": "x=1\n" }, false).cwd), null);
  assert.equal(readmeLine(null).startsWith("no README (looked for README.md, README.html"), true);
});

test("/doc readme on a repo with only README.html reports it and reads its text as background", async () => {
  const { cwd, env } = project({ ...FILES, "README.md": undefined as never, "README.html": ALLCAP_HTML }, false);
  const f = fake(standard);
  const { r, lines } = await run(cwd, env, f.chat, "readme");
  assert.equal(r.ok, true);
  assert.ok(lines.includes("README found: README.html (html)"), lines.join("\n"));
  const what = f.rec.find((x) => /Section 'What it is'/.test(x.system))!;
  assert.ok(what.user.includes("An old description of the app"), "the HTML's visible text is the background");
  assert.ok(!what.user.includes("<b>") && !what.user.includes("color: red"));
});

test("/doc readme --update on a Markdown README checks every section: only the changed one is touched, the rest byte-identical", async () => {
  const { cwd, env } = project(FILES);
  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const f = fake(verdicts({ Usage: [{ search: "Run it with start.sh.", replace: "Start it from start.sh, or from the service." }] }));
  const { r, lines } = await run(cwd, env, f.chat, "readme --update all");
  assert.equal(r.ok, true, lines.join("\n"));
  assert.deepEqual(r.updated, ["Usage"]);
  assert.equal(f.counts.update, 4, "one call per section with text: App, What it is, Usage, License");
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before.replace("Run it with start.sh.", "Start it from start.sh, or from the service."));
  assert.ok(lines.some((l) => l.startsWith("  ~ updated: Usage")));
  assert.ok(lines.some((l) => l.startsWith("  = kept: License")));
  assert.ok(lines.some((l) => /updated README.md: .*3 kept; \+\d+ -\d+ lines/.test(l)));
});

test("/doc readme --update on an HTML README: only the inner content of changed blocks is replaced, markup elsewhere is untouched", async () => {
  const { cwd, env } = project({ ...FILES, "README.md": undefined as never, "README.html": ALLCAP_HTML });
  const f = fake(verdicts({ Usage: [{ search: "<li>Run start.sh</li>", replace: "<li>Run start.sh</li><li>or from the service</li>" }] }));
  const { r, lines } = await run(cwd, env, f.chat, "readme --update all");
  assert.equal(r.ok, true, lines.join("\n"));
  assert.deepEqual(r.updated, ["Usage"]);
  const after = readFileSync(join(cwd, "README.html"), "utf8");
  assert.equal(
    after,
    ALLCAP_HTML.replace("<li>Run start.sh</li>", "<li>Run start.sh</li><li>or from the service</li>"),
  );
  // HTML is edited as source: the call saw the section's markup and edits it in place
  const call = f.rec.find((x) => x.schemaName === "update" && x.user.includes("Section 'What it is'"))!;
  assert.ok(call.user.includes("<p>An old description of the <b>app</b> with   odd   spacing.</p>"));
});

test("HTML sections: <section> elements win over bare headings; h1 is not a section; text is decoded", () => {
  const html = '<h1>T</h1><section id="a"><h2>One &amp; two</h2><p>x &lt; y</p></section><section id="b"><h3>Two</h3><p>z</p></section>';
  const secs = readmeSections(html, "html");
  assert.deepEqual(secs.map((x) => [x.title, x.text]), [["One & two", "x < y"], ["Two", "z"]]);
  assert.equal(html.slice(secs[0]!.start, secs[0]!.end), "<p>x &lt; y</p>");
  const bare = readmeSections(ALLCAP_HTML, "html");
  assert.deepEqual(bare.map((x) => x.title), ["What it is", "Usage", "License"]);
});

test("revised README text: no new numbers, paths or identifiers unless they are in the code facts or were already in the section", async () => {
  const { cwd, env } = project(FILES);
  const f = fake(verdicts({}, (title) => (title === "What it is" ? { verdict: "revise", reason: "r", edits: [{ search: "An old description", replace: "A short description" }, { search: "in it.", replace: "in it. It listens on port 9999 and reads src/new_thing.py." }] } : null)));
  const { r } = await run(cwd, env, f.chat, 'readme --update "What it is"');
  assert.equal(r.ok, true);
  const after = readFileSync(join(cwd, "README.md"), "utf8");
  assert.ok(after.includes("## What it is\n\nA short description with 5 numbers and src/old.py in it.\n\n## Usage"), after);
  assert.ok(!after.includes("9999") && !after.includes("new_thing"));
  assert.equal(r.dropped.length, 1);
  assert.ok(r.flagged.some((x) => /dropped/.test(x)));
  assert.equal(f.counts.update, 2, "one retry for the specifics, then the check drops the offending edit");
});

test("/doc readme --update asks first when routed (ask): declined = no call, file untouched; yes = runs", async () => {
  const { cwd, env } = project(FILES);
  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const questions: string[] = [];
  const none = fake(() => new Error("must not be called"));
  const lines: string[] = [];
  const base = { cwd, config: mergeConfig({}), report: (l: string) => lines.push(l), env };
  const a = { ...parseReadmeArgs('--update all'), ask: true };
  const no = await runReadme(a, { ...base, chat: none.chat, confirm: async (q) => (questions.push(q), false) });
  assert.equal(no.reason, "declined");
  assert.equal(none.rec.length, 0);
  assert.equal(questions[0], "Found README.md with 4 sections; check each against the code and update the ones that are out of date?");
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before);
  const f = fake(verdicts({}));
  const yes = await runReadme(a, { ...base, chat: f.chat, confirm: async () => true });
  assert.equal(yes.ok, true);
  assert.equal(yes.reason, "up-to-date");
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before);
});

test("no README: the routed request offers README.md from the overview content; declined writes nothing; yes writes README.md only", async () => {
  const noReadme = { ...FILES, "README.md": undefined as never };
  const { cwd, env } = project(noReadme);
  const base = { cwd, config: mergeConfig({}), report: () => {}, env };
  const a = { ...parseReadmeArgs(""), create: true, ask: true };
  const f0 = fake(() => new Error("must not be called"));
  const no = await runReadme(a, { ...base, chat: f0.chat, confirm: async () => false });
  assert.equal(no.reason, "declined");
  assert.equal(f0.rec.length, 0);
  assert.equal(findReadme(cwd), null);
  const f = fake(standard);
  const yes = await runReadme(a, { ...base, chat: f.chat, confirm: async () => true });
  assert.equal(yes.ok, true);
  const md = readFileSync(join(cwd, "README.md"), "utf8");
  assert.ok(md.startsWith("# ") && md.includes("A small web application that stores rows for its users.") && md.includes("## How it works") && md.includes("- **Web server**"), md);
  assert.equal(yes.output, join(cwd, "README.md"));
  assert.throws(() => readFileSync(join(cwd, "docs/overview.html")), "the page is not written when creating README.md");
});

test("routing by intent: update/fix/refresh the README -> check sections (after asking); overview / document this project -> the page; no README -> create", () => {
  const md = { rel: "README.md", kind: "md" as const };
  const html = { rel: "README.html", kind: "html" as const };
  for (const t of ["update the README to match the current code", "fix the readme", "refresh the README"])
    for (const found of [md, html]) {
      const a = docArgsFromText(t, [], found);
      assert.equal(a.mode, "readme");
      assert.deepEqual([a.readme.update, a.readme.ask, a.readme.create], [["all"], true, undefined], t);
    }
  assert.deepEqual(docArgsFromText("update the usage section of the readme", ["Usage", "License"], html).readme.update, ["Usage"]);
  for (const t of ["write an overview of this project", "document this project", "refresh the overview page"]) {
    const a = docArgsFromText(t, [], md);
    assert.deepEqual([a.mode, a.readme.update, a.readme.ask, a.readme.create], ["readme", null, undefined, undefined], t);
  }
  const none = docArgsFromText("write a README for this", [], null);
  assert.deepEqual([none.readme.create, none.readme.ask, none.readme.update], [true, true, null]);
  assert.equal(docArgsFromText("add docstrings to the readme parser", [], md).mode, "comments");
  // older callers (no README lookup) keep the earlier behaviour
  assert.equal(docArgsFromText("update the readme", []).readme.update, null);
});

test("readmeHeadings reads Markdown and HTML READMEs", () => {
  assert.deepEqual(readmeHeadings(project(FILES, false).cwd), ["App", "What it is", "Usage", "License"]);
  assert.deepEqual(readmeHeadings(project({ "README.html": ALLCAP_HTML }, false).cwd), ["What it is", "Usage", "License"]);
});

test("diffStat and spliceSections", () => {
  assert.deepEqual(diffStat("a\nb\nc\n", "a\nB\nB2\nc\n"), { added: 2, removed: 1 });
  assert.deepEqual(diffStat("a\n", "a\n"), { added: 0, removed: 0 });
});

test("progress end to end: /doc readme --update on HTML shows one checklist item per section, files and folders counts, then clears", async () => {
  const { createProgress } = await import("../../src/progress.ts");
  const { README_UPDATE_PHASES } = await import("../../src/workflows/docreadme.ts");
  const { cwd, env } = project({ ...FILES, "README.md": undefined as never, "README.html": ALLCAP_HTML });
  const status: string[] = [];
  const lists: string[][] = [];
  const msgs: string[] = [];
  const pg = createProgress({ workflow: "doc readme", phases: README_UPDATE_PHASES, noLog: true, sink: { interactive: true, status: (x) => x && status.push(x), widget: (x) => x && lists.push(x), message: (x) => msgs.push(x), err: () => {} } });
  const f = fake(verdicts({ Usage: [{ search: "<li>Run start.sh</li>", replace: "<li>Run start.sh from the folder</li>" }] }));
  const chat = pg.chat(async (...a: Parameters<typeof f.chat>) => {
    const r = await f.chat(...a);
    pg.count({ prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 });
    return r;
  });
  const lines: string[] = [];
  const r = await runDoc(parseDocArgs("readme --update all"), { cwd, config: mergeConfig({}), chat, report: (l) => lines.push(l), env, progress: pg });
  assert.equal(r.mode, "readme");
  assert.ok(status.some((s) => /· summarising files 1\/\d+ ·/.test(s)), "file counter");
  assert.ok(status.some((s) => /· summarising folders 1\/\d+ ·/.test(s)), "folder counter");
  const sectionList = lists.find((l) => l.some((x) => x.includes('check "Usage"')))!;
  assert.ok(sectionList, "a checklist item per section");
  const last = lists.at(-1)!;
  assert.deepEqual(last.map((x) => x.replace(/\x1b\[\d+m/g, "").slice(2)).filter((x) => x.startsWith("check")), ['check "What it is"', 'check "Usage"', 'check "License"']);
  assert.equal(last.length, 6);
  pg.done({ text: "updated Usage" });
  assert.match(msgs[0]!, /\ndoc readme done: updated Usage, changed README.html, \d+ calls, \d+ tokens, /);
});

// ---------------------------------------------------------------- S19: section edits, deletion guard, not checked

const ENT_HTML = `<!doctype html>
<html><body>
<h1>App</h1>
<h2>What it is</h2>
<p>An old description &mdash; with a dash &amp; an ampersand, kept as written by the author of the page.</p>
<h2>License</h2>
<p>MIT</p>
</body></html>
`;

test("S19 section edit path: the model sends SEARCH/REPLACE edits, applied inside the section; the call is shown the source", async () => {
  const { cwd, env } = project({ ...FILES, "README.md": undefined as never, "README.html": ENT_HTML });
  const f = fake(verdicts({ "What it is": [{ search: "An old description", replace: "A current description" }] }));
  const { r } = await run(cwd, env, f.chat, 'readme --update "What it is"');
  assert.equal(r.ok, true);
  assert.deepEqual(r.updated, ["What it is"]);
  const call = f.rec.find((x) => x.schemaName === "update")!;
  assert.ok(call.user.includes("&mdash;"), "the source is shown with its entities");
  assert.ok(/"edits"|SEARCH\/REPLACE/.test(call.system), "the system prompt asks for edits");
});

test("S19 HTML is edited as source: entities and markup are never re-escaped", async () => {
  const { cwd, env } = project({ ...FILES, "README.md": undefined as never, "README.html": ENT_HTML });
  const f = fake(verdicts({ "What it is": [{ search: "An old description", replace: "A current description" }] }));
  await run(cwd, env, f.chat, 'readme --update "What it is"');
  const after = readFileSync(join(cwd, "README.html"), "utf8");
  assert.equal(after, ENT_HTML.replace("An old description", "A current description"));
  assert.ok(after.includes("&mdash;") && !after.includes("&amp;mdash;") && !after.includes("&amp;amp;"));
});

test("S19 deletion guard: an update that removes more than 20% of a section is refused and reported; the file is untouched", async () => {
  const { cwd, env } = project(FILES);
  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const f = fake(verdicts({ "What it is": [{ search: "An old description with 5 numbers and src/old.py in it.", replace: "A web app." }] }));
  const { r, lines } = await run(cwd, env, f.chat, 'readme --update "What it is"');
  assert.deepEqual(r.refused, ["What it is"]);
  assert.deepEqual(r.updated, []);
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before);
  assert.ok(lines.some((l) => /refused: What it is \(would remove \d+% of the section/.test(l)), lines.join("\n"));
  assert.ok(r.flagged.some((x) => /update refused, it would remove \d+%/.test(x)));
});

test("S19 sectionShrink and applySectionEdits", async () => {
  const { sectionShrink, applySectionEdits, sectionEdits } = await import("../../src/workflows/docreadme.ts");
  assert.equal(sectionShrink("aaaaaaaaaa", "aaaaaaaa"), 0.2);
  assert.equal(sectionShrink("aa", "aaaa"), 0);
  const r = applySectionEdits("one two three", [{ search: "two", replace: "2x" }, { search: "nope", replace: "x" }]);
  assert.equal(r.text, "one 2x three");
  assert.equal(r.missed.length, 1);
  assert.deepEqual(sectionEdits({ edits: [{ search: "", replace: "a" }, { search: "a", replace: "b" }, "x"] }), [{ search: "a", replace: "b" }]);
});

test("S19 a section whose call fails gets one retry, then shows as \"not checked\"", async () => {
  const { cwd, env } = project(FILES);
  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const f = fake((kind, user) => {
    if (kind !== "update") return standard(kind, user);
    return user.includes("Section 'License'") ? "not json at all" : ok({ verdict: "ok", reason: "fine" });
  });
  const { r, lines } = await run(cwd, env, f.chat, "readme --update all");
  assert.deepEqual(r.notChecked, ["License"]);
  assert.equal(f.counts.update, 5, "4 sections + exactly one retry");
  assert.ok(lines.some((l) => l.startsWith("  ? not checked: License")), lines.join("\n"));
  assert.ok(lines.some((l) => /^not checked \(1\): License/.test(l)));
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), before);
});
