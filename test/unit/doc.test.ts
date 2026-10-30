import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig, type Config } from "../../src/config.ts";
import { langOf, listSymbols, sameCode, stripped } from "../../src/context/strip.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { actionable, buildIndex, heuristic } from "../../src/router.ts";
import { applyDocBlocks, batchSymbols, docArgsFromText, docTargets, makeCompile, namedHeadings, parseDocArgs, runDoc } from "../../src/workflows/doc.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const cfg = (): Config => mergeConfig({ test: { python: PY } });

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[] }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[]): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages) });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++]!, usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "m", fellBack: false };
  };
  return { chat, calls };
}
const block = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;
function mk(files: Record<string, string>) {
  const d = tmpDir("tinycode-doc-");
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  return { cwd: d, env: { TINYCODE_LOG: join(d, "..", "state-" + Math.random(), "calls.jsonl") } };
}
const read = (cwd: string, p: string) => readFileSync(join(cwd, p), "utf8");
const run = async (cwd: string, env: Record<string, string>, chat: ReturnType<typeof scripted>["chat"], args: string, extra: object = {}) => {
  const lines: string[] = [];
  const r = await runDoc(parseDocArgs(args), { cwd, config: cfg(), chat, report: (l) => lines.push(l), env, ...extra });
  return { r: r as Extract<typeof r, { mode: "comments" }>, lines };
};

const CALC = `import os


def add(a, b):
    return a + b


def clamp(x, lo, hi):
    # keep it in range
    return max(lo, min(x, hi))


class Box:
    def __init__(self, n):
        self.n = n

    def grow(self):
        return Box(self.n + 1)
`;

test("langOf: Python and JS/TS only; jsx, tsx and everything else are refused", () => {
  assert.equal(langOf("a/b.py"), "py");
  for (const f of ["a.js", "a.mjs", "a.cjs", "a.ts", "a.mts", "a.cts"]) assert.equal(langOf(f), "js", f);
  for (const f of ["a.tsx", "a.jsx", "a.rb", "a.sh", "a.go", "README.md"]) assert.equal(langOf(f), null, f);
});

test("stripped/sameCode (Python): comments, docstrings, blank lines may change; one code byte may not", () => {
  const src = '#!/usr/bin/env python3\n"""mod"""\nimport os  # trailing\n\nX = """keep\n\nme"""\n\nclass A:\n    """doc"""\n    def m(self, a,\n          b):\n        # note\n        return a + b  # t\n\ndef f(a):\n    return a\n';
  assert.equal(stripped("py", src), '#!/usr/bin/env python3\nimport os\nX = """keep\n\nme"""\nclass A:\n    def m(self, a,\n          b):\n        return a + b\ndef f(a):\n    return a');
  const ok = src.replace("def f(a):\n", 'def f(a):\n    """New doc.\n\n    More."""\n').replace("import os", "# a new comment\nimport os").replace("\nX =", "\n\n\nX =");
  assert.ok(sameCode("py", src, ok));
  assert.ok(!sameCode("py", src, src.replace("a + b", "a - b")));
  assert.ok(!sameCode("py", src, src.replace("keep\n\nme", "keep\n\n\nme")), "a blank line inside a string constant is code");
  assert.ok(!sameCode("py", src, src.replace("#!/usr/bin/env python3", "#!/usr/bin/python")), "the shebang is code");
  assert.ok(!sameCode("py", src, src.replace("def f(a):\n    return a", "def f(a):\n    pass\n    return a")));
  // a pre-existing non-first string statement is code: documenting above it turns nothing into a docstring silently
  assert.ok(!sameCode("py", "def g():\n    'x'\n    return 1\n", 'def g():\n    """doc"""\n    \'x\'\n    return 1\n'));
  // tool directives are code
  assert.ok(!sameCode("py", "x = 1  # noqa\n", "x = 1\n"));
  assert.ok(sameCode("py", "x = 1  # old\n", "x = 1  # new words\n"));
});

test("stripped/sameCode (JS/TS): // and /* */ and JSDoc are comments; strings, templates, regexes and directives are not", () => {
  const ts = '// head\nimport x from "y"; // c\n/** doc */\nexport function a(p: number): number {\n  const re = /ab\\/\\/c/g; // c\n  const t = `x ${p /* in */} // not`;\n  return p / 2 / 3; /* tail */\n}\n// @ts-ignore\nconst u: string = 1;\nconst s = "// no";\n';
  assert.equal(stripped("js", ts), 'import x from "y";\nexport function a(p: number): number {\n  const re = /ab\\/\\/c/g;\n  const t = `x ${p /* in */} // not`;\n  return p / 2 / 3;\n}\n// @ts-ignore\nconst u: string = 1;\nconst s = "// no";');
  assert.ok(sameCode("js", ts, ts.replace("/** doc */", "/**\n * Adds.\n * @param p the number\n */")));
  assert.ok(!sameCode("js", ts, ts.replace("// no", "// yes")));
  assert.ok(!sameCode("js", ts, ts.replace("p / 2 / 3", "p / 2 / 4")));
  assert.ok(!sameCode("js", ts, ts.replace("// @ts-ignore\n", "")));
});

test("listSymbols: python module, class, methods, functions; documented ones are marked", () => {
  const src = '"""m"""\n\n\nclass A:\n    """d"""\n\n    def m(self):\n        return 1\n\n\ndef f():\n    """d"""\n    return 2\n\n\nasync def g(a,\n            b):\n    return 3\n';
  const s = listSymbols("py", src).map((x) => [x.kind, x.name, x.line, x.hasDoc]);
  assert.deepEqual(s, [["module", "(module)", 1, true], ["class", "A", 4, true], ["method", "A.m", 7, false], ["function", "f", 11, true], ["function", "g", 16, false]]);
  assert.deepEqual(listSymbols("py", src.replace("async def g", "def f")).filter((x) => x.name === "f").map((x) => x.key), ["function:f#1", "function:f#2"]);
});

test("listSymbols: js/ts functions, arrows, classes, methods, types; a preceding /** */ or // counts as documented", () => {
  const ts = '/** doc */\nexport function a(p: number): number {\n  return p;\n}\n\nexport class K {\n  // has one\n  get(x: string): string {\n    return x;\n  }\n  put(x: string): void {\n    if (x) {\n    }\n  }\n}\nexport const arrow = (a: number) => a + 1;\nexport interface I { a: string }\n';
  assert.deepEqual(listSymbols("js", ts).map((x) => [x.kind, x.name, x.line, x.end, x.hasDoc]), [
    ["function", "a", 2, 4, true], ["class", "K", 6, 15, false], ["method", "K.get", 8, 10, true], ["method", "K.put", 11, 14, false], ["function", "arrow", 16, 16, false], ["type", "I", 17, 17, false],
  ]);
});

test("batchSymbols: at most 6 symbols per call; only undocumented ones; --symbol narrows to one", () => {
  const many = Array.from({ length: 14 }, (_, i) => `def f${i}():\n    return ${i}\n`).join("\n\n");
  const { batches } = batchSymbols('"""m"""\n' + many, "py");
  assert.deepEqual(batches.map((b) => b.length), [6, 6, 2]);
  assert.deepEqual(batchSymbols(CALC, "py", "grow").wanted.map((s) => s.name), ["Box.grow"]);
});

test("applyDocBlocks: refuses code changes, other files, empty SEARCH, duplicates and huge docs; keeps the good blocks", () => {
  const good = block("calc.py", "def add(a, b):\n    return a + b", 'def add(a, b):\n    """Add two numbers."""\n    return a + b');
  const bad = block("calc.py", "def clamp(x, lo, hi):", 'def clamp(x, lo, hi):\n    """Clamp."""\n    x = 0');
  const other = block("other.py", "x", "y");
  const create = block("calc.py", "", "def new():\n    pass");
  const dup = block("calc.py", "    return", '    """d"""\n    return');
  const huge = block("calc.py", "class Box:", `class Box:\n    """${"x".repeat(1600)}"""`);
  const g = applyDocBlocks([good, bad, other, create, dup, huge].join("\n"), "calc.py", CALC, CALC, "py");
  assert.equal(g.applied, 1);
  assert.equal(g.refused.length, 5, g.refused.join("\n"));
  assert.ok(g.refused.some((r) => /changes code/.test(r)));
  assert.ok(g.refused.some((r) => /only calc.py may change/.test(r)));
  assert.ok(g.refused.some((r) => /empty SEARCH/.test(r)));
  assert.ok(g.refused.some((r) => /more than once/.test(r)));
  assert.ok(g.refused.some((r) => /over 1500/.test(r)));
  assert.ok(g.text.includes('"""Add two numbers."""') && !g.text.includes("x = 0"));
  assert.ok(sameCode("py", CALC, g.text));
});

test("/doc on a Python file: one call per batch, docstrings added, stripped code identical, py_compile ok", async () => {
  const { cwd, env } = mk({ "calc.py": CALC });
  const reply =
    block("calc.py", "def add(a, b):\n    return a + b", 'def add(a, b):\n    """Return the sum of a and b."""\n    return a + b') +
    block("calc.py", "def clamp(x, lo, hi):\n    # keep it in range", 'def clamp(x, lo, hi):\n    """Limit x to the range lo..hi."""\n    # keep it in range') +
    block("calc.py", "class Box:\n    def __init__(self, n):\n        self.n = n", 'class Box:\n    """A counter box."""\n\n    def __init__(self, n):\n        """Make a box holding n."""\n        self.n = n') +
    block("calc.py", "    def grow(self):\n        return", '    def grow(self):\n        """Return a Box one larger."""\n        return') +
    block("calc.py", "import os", '"""Small helpers."""\nimport os');
  const { chat, calls } = scripted([reply]);
  const { r, lines } = await run(cwd, env, chat, "--file calc.py add docstrings", { lint: { find: () => null } });
  assert.equal(r.ok, true, lines.join("\n"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.step, "doc");
  assert.ok(calls[0]!.messages[1]!.content.includes("--- function add (line 4) ---"));
  const after = read(cwd, "calc.py");
  assert.ok(after.includes('"""Return the sum of a and b."""') && after.includes('"""A counter box."""'));
  assert.ok(sameCode("py", CALC, after));
  assert.ok(lines.some((l) => l.startsWith("compile check: ok")), lines.join("\n"));
  assert.ok(r.documented.includes("add") && r.documented.includes("Box.grow") && r.documented.includes("(module)"), JSON.stringify(r.documented));
  // a second run finds nothing to do and makes no call
  const again = await run(cwd, env, scripted([]).chat, "--file calc.py add docstrings");
  assert.equal(again.r.reason, "nothing-to-do");
});

test("/doc refuses a reply that changes code: bad block dropped, one retry, the file keeps code byte-identical", async () => {
  const { cwd, env } = mk({ "calc.py": CALC });
  const sneaky = block("calc.py", "def add(a, b):\n    return a + b", 'def add(a, b):\n    """Add."""\n    return a - b');
  const fixed = block("calc.py", "def add(a, b):\n    return a + b", 'def add(a, b):\n    """Add."""\n    return a + b');
  const { chat, calls } = scripted([sneaky, fixed]);
  const { r, lines } = await run(cwd, env, chat, "--file calc.py add docstrings to add", { lint: { find: () => null } });
  assert.equal(calls.length, 2);
  assert.ok(lines.some((l) => /changes code/.test(l)));
  assert.ok(calls[1]!.messages.some((m) => /Not accepted/.test(m.content)));
  assert.equal(r.ok, true);
  assert.ok(read(cwd, "calc.py").includes("return a + b") && !read(cwd, "calc.py").includes("a - b"));
});

test("/doc: when every attempt changes code the file is not touched at all", async () => {
  const { cwd, env } = mk({ "calc.py": CALC });
  const sneaky = block("calc.py", "def add(a, b):\n    return a + b", "def add(a, b):\n    return a - b");
  const { chat, calls } = scripted([sneaky, sneaky]);
  const { r } = await run(cwd, env, chat, "--file calc.py add docstrings to add");
  assert.equal(calls.length, 2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "nothing-applied");
  assert.equal(read(cwd, "calc.py"), CALC);
});

test("/doc: a documented file that fails the compile check is not written", async () => {
  const { cwd, env } = mk({ "calc.py": CALC });
  const ok = block("calc.py", "def add(a, b):\n    return a + b", 'def add(a, b):\n    """Add."""\n    return a + b');
  const { chat } = scripted([ok]);
  const { r, lines } = await run(cwd, env, chat, "--file calc.py add docstrings to add", { compile: async () => ({ ok: false, message: "SyntaxError: boom" }) });
  assert.equal(r.reason, "compile-failed");
  assert.ok(lines.some((l) => /does not compile/.test(l)));
  assert.equal(read(cwd, "calc.py"), CALC);
});

test("makeCompile: py_compile and node --check really reject broken text and accept good text (ts through Node's type stripper)", async () => {
  const c = makeCompile(PY);
  assert.equal((await c("py", "a.py", "def f():\n    return 1\n")).ok, true);
  assert.equal((await c("py", "a.py", "def f(:\n    return 1\n")).ok, false);
  assert.equal((await c("py", "a.py", 'def f():\n    """unterminated\n    return 1\n')).ok, false);
  assert.equal((await c("js", "a.ts", "export function f(a: number): number {\n  return a;\n}\n")).ok, true);
  assert.equal((await c("js", "a.ts", "export function f(a: number { return a; }\n")).ok, false);
  assert.equal((await c("js", "a.ts", "export function f(a: number): number {\n  return a +;\n}\n")).ok, false);
  assert.equal((await c("js", "a.js", "const a = require('x');\nmodule.exports = a;\n")).ok, true);
  assert.equal((await c("js", "a.js", "/** broken\nconst a = 1;\n")).ok, false);
});

test("/doc on a TypeScript file documents with /** */ and passes the node check", async () => {
  const src = "export function area(w: number, h: number): number {\n  return w * h;\n}\n\nexport class Sq {\n  side(): number {\n    return 2;\n  }\n}\n";
  const { cwd, env } = mk({ "shapes.ts": src });
  const reply =
    block("shapes.ts", "export function area(w: number, h: number): number {", "/**\n * Area of a rectangle.\n * @param w width\n * @param h height\n */\nexport function area(w: number, h: number): number {") +
    block("shapes.ts", "  side(): number {\n    return 2;", "  /** Side length. */\n  side(): number {\n    return 2;");
  const { r, lines } = await run(cwd, env, scripted([reply]).chat, "--file shapes.ts add doc comments", { lint: { find: () => null } });
  assert.equal(r.ok, true, lines.join("\n"));
  assert.ok(read(cwd, "shapes.ts").includes("/** Side length. */"));
  assert.ok(sameCode("js", src, read(cwd, "shapes.ts")));
  assert.ok(lines.some((l) => l.includes("node --check")));
});

test("/doc refuses what it cannot prove: other languages, jsx/tsx; no call is made", async () => {
  const { cwd, env } = mk({ "a.rb": "def x\n  1\nend\n", "App.tsx": "export const A = () => <div>it's</div>;\n" });
  for (const f of ["a.rb", "App.tsx"]) {
    const { r } = await run(cwd, env, scripted([]).chat, `--file ${f} add comments`);
    assert.equal(r.reason, "unsupported", f);
  }
  assert.equal(read(cwd, "a.rb"), "def x\n  1\nend\n");
});

test("/doc keeps CRLF files CRLF", async () => {
  const crlf = "def add(a, b):\r\n    return a + b\r\n";
  const { cwd, env } = mk({ "c.py": crlf });
  const reply = block("c.py", "def add(a, b):\n    return a + b", 'def add(a, b):\n    """Add."""\n    return a + b');
  const { r } = await run(cwd, env, scripted([reply]).chat, "--file c.py add docstrings", { lint: { find: () => null } });
  assert.equal(r.ok, true);
  assert.equal(read(cwd, "c.py"), 'def add(a, b):\r\n    """Add."""\r\n    return a + b\r\n');
});

test("arguments and routing: /doc forms, routed text, router parity words", () => {
  assert.deepEqual(parseDocArgs("--file a.py --all add docstrings").file, "a.py");
  assert.equal(parseDocArgs("readme --update \"Install,Usage\" --max-files 5").mode, "readme");
  assert.deepEqual(parseDocArgs("readme --update \"Install,Usage\" --max-files 5").readme.update, ["Install", "Usage"]);
  assert.equal(parseDocArgs("readme --related a,b").readme.related.join(), "a,b");
  assert.equal(docArgsFromText("update the readme", []).mode, "readme");
  assert.deepEqual(docArgsFromText("update the install section of the readme", ["Install", "Usage"]).readme.update, ["Install"]);
  assert.equal(docArgsFromText("add docstrings to the readme parser", []).mode, "comments");
  const names = buildIndex(mk({ "calc.py": CALC }).cwd).names;
  const h = (t: string) => heuristic(t, names);
  for (const t of ["add docstrings to calc.py", "write doc comments for the add function in calc.py", "add comments to calc.py", "generate jsdoc for parser.ts"]) assert.equal(h(t).workflow, "doc", t);
  assert.equal(h("add docstrings to calc.py").file, "calc.py");
  assert.equal(h("add docstrings to calc.py").confident, true);
  for (const t of ["write a comment parser function", "how do I write docstrings?", "fix the comments crash"]) assert.notEqual(h(t).workflow, "doc", t);
  assert.equal(actionable({ ...h("add docstrings to calc.py") }), "doc");
  const rd = (goal: string) => actionable({ workflow: "readme", file: "", goal, confident: true });
  for (const g of ["update the readme", "write the overview", "write a README for the exporter that covers the formats", "the readme needs a section on the cli commands", "refresh the overview page"]) assert.equal(rd(g), "doc", g);
  for (const g of ["uploads over 2.5MB get rejected but the readme promises 25MB", "DESIGN.md should explain the short/long sub-rank now"]) assert.equal(rd(g), null, g);
  assert.equal(h("update the overview").workflow, "readme");
});

test("readme args keep every value of a quoted comma list; headings named in prose are whole words outside paths, the title only when asked", () => {
  assert.deepEqual(parseDocArgs('readme --update "exporter","Usage" --max-files 3').readme.update, ["exporter", "Usage"]);
  assert.deepEqual(parseDocArgs("readme --update 'A', 'B'").readme, { ...parseDocArgs("readme").readme, update: ["A", "B"] });
  const hs = [{ title: "exporter", level: 1 }, { title: "Usage", level: 2 }, { title: "Layout", level: 2 }, { title: "Use", level: 2 }];
  // doc-3-readme: "exporter" is in a path and is the title; "Use" is not a whole word of "Usage"
  assert.deepEqual(docArgsFromText("Update the Usage section of README.md so it matches what exporter/cli.py actually does.", hs).readme.update, ["Usage"]);
  assert.deepEqual(namedHeadings("update the readme's exporter section and the usage", hs), ["exporter", "Usage"]);
  assert.deepEqual(namedHeadings('fix "exporter" in the readme', hs), ["exporter"]);
  assert.deepEqual(namedHeadings("the readme layout is stale; see `layout.md`", hs), ["Layout"]);
});

test("doc targets: every named file, and the code files of a named package; one or none leaves it to findTarget", () => {
  const files = ["cal/leap.py", "cal/months.py", "cal/__init__.py", "todo/model.py", "todo/cli.py", "todo/__init__.py", "tests/test_todo.py", "calc.py"];
  const src: Record<string, string> = { "cal/leap.py": "def is_leap(y):\n    return 1\n", "cal/months.py": "def days(m):\n    return 1\n", "todo/model.py": "class Task:\n    id: int\n", "todo/cli.py": "def main():\n    pass\n", "todo/__init__.py": "", "cal/__init__.py": "" };
  const read = (f: string) => src[f] ?? null;
  assert.deepEqual(docTargets("Add docstrings to every function in cal/leap.py and cal/months.py.", files, read), ["cal/leap.py", "cal/months.py"]);
  assert.deepEqual(docTargets("Add docstrings to the todo package: every function and the Task class.", files, read), ["todo/model.py", "todo/cli.py"]);
  assert.deepEqual(docTargets("add docstrings to calc.py", files, read), []);
  assert.deepEqual(docTargets("add a docstring to Task", files, read), []);
});

test("/doc on a request naming two files documents both; one that fails is handed back in `left`", async () => {
  const { cwd, env } = mk({ "a.py": "def one(x):\n    return x\n", "b.py": "def two(x):\n    return x\n" });
  const ra = block("a.py", "def one(x):\n    return x", 'def one(x):\n    """Return x."""\n    return x');
  const rb = block("b.py", "def two(x):\n    return x", 'def two(x):\n    """Return x."""\n    return x');
  const { r, lines } = await run(cwd, env, scripted([ra, rb]).chat, "Add docstrings to a.py and b.py", { lint: { find: () => null } });
  assert.equal(r.ok, true, lines.join("\n"));
  assert.deepEqual(r.files, ["a.py", "b.py"]);
  assert.deepEqual(r.left, []);
  assert.match(read(cwd, "b.py"), /"""Return x\."""/);
  // b's reply never applies: a is written, b is left with its reason
  const two = mk({ "a.py": "def one(x):\n    return x\n", "b.py": "def two(x):\n    return x\n" });
  const bad = await run(two.cwd, two.env, scripted([ra, "no blocks", "still none"]).chat, "Add docstrings to a.py and b.py", { lint: { find: () => null } });
  assert.equal(bad.r.ok, true);
  assert.deepEqual(bad.r.files, ["a.py"]);
  assert.deepEqual(bad.r.left, ["b.py (nothing-applied)"]);
});

test("/doc on one file naming several symbols asks for each of them; every/all asks for the whole file", async () => {
  const ask = async (task: string) => {
    const { cwd, env } = mk({ "calc.py": CALC });
    const s = scripted(["no blocks", "no blocks", "no blocks", "no blocks"]);
    await run(cwd, env, s.chat, task, { lint: { find: () => null } });
    return String(s.calls[0]!.messages[1]!.content).split("\n").filter((l) => l.startsWith("- "));
  };
  assert.deepEqual(await ask("write docstrings for clamp and grow in calc.py"), ["- function clamp", "- method Box.grow"]);
  assert.deepEqual(await ask("write a docstring for clamp in calc.py"), ["- function clamp"]);
  assert.equal((await ask("docstrings for every function in calc.py, clamp included")).length, 6);
});
