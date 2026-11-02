// Forgiving edits (src/forgive.ts). The samples are Nemotron-Nano-9B-v2's failed Pi edits (runs-radar 2026-10-30,
// test/fixtures/forgive/nemotron-failed-edits.json), cut down to the lines that matter.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { tmpDir } from "./tmpdir.ts";
import { DEFAULTS, mergeConfig } from "../../src/config.ts";
import { editsOf, forgive, forgiveApply, forgiveEditCall, occurrences, parsePiEditError, reindent, tolerantWindows, type EditPair } from "../../src/forgive.ts";
import { isTestPath } from "../../src/workflows/fix.ts";

const NF = (p: string) => `Could not find the exact text in ${p}. The old text must match exactly including all whitespace and newlines.`;
const NF_I = (i: number, p: string) => `Could not find edits[${i}] in ${p}. The oldText must match exactly including all whitespace and newlines.`;
const DUP = (n: number, p: string) => `Found ${n} occurrences of the text in ${p}. The text must be unique. Please provide more context to make it unique.`;

// dot-dsl: the stub's Graph class; the model sent the method dedented by 4 (36 of 36 edits)
const GRAPH = "class Edge:\n    def __init__(self, src, dst, attrs):\n        self.src = src\n\n\nclass Graph:\n    def __init__(self, data=None):\n        pass\n";
const GRAPH_OLD = "def __init__(self, data=None):\n    pass";
const GRAPH_NEW = "def __init__(self, data=None):\n    self.nodes = []\n    if data:\n        for item in data:\n            self.nodes.append(item)";

test("Pi's two match errors are recognised; anything else is not", () => {
  assert.deepEqual(parsePiEditError(NF("dot_dsl.py")), { kind: "notfound", index: 0 });
  assert.deepEqual(parsePiEditError(NF_I(3, "paasio.py")), { kind: "notfound", index: 3 });
  assert.deepEqual(parsePiEditError(DUP(2, "connect.py")), { kind: "dup", index: 0 });
  assert.deepEqual(parsePiEditError("Found 12 occurrences of edits[1] in bowling.py. Each oldText must be unique."), { kind: "dup", index: 1 });
  assert.equal(parsePiEditError("No changes made to connect.py. The replacement produced identical content."), null);
  assert.equal(parsePiEditError("Could not edit file: x.py. Error code: ENOENT."), null);
});

test("edits are read in every shape Pi accepts", () => {
  const e = { oldText: "a\r\nb", newText: "c" };
  assert.deepEqual(editsOf({ edits: [e] }), [{ oldText: "a\nb", newText: "c" }]);
  assert.deepEqual(editsOf({ edits: JSON.stringify([e]) }), [{ oldText: "a\nb", newText: "c" }]);
  assert.deepEqual(editsOf({ edits: e }), [{ oldText: "a\nb", newText: "c" }]);
  assert.deepEqual(editsOf({ oldText: "x", newText: "y" }), [{ oldText: "x", newText: "y" }]);
  assert.equal(editsOf({ edits: [] }), null);
  assert.equal(editsOf({ edits: [{ oldText: 1 }] }), null);
});

test("category uniform indent shift (dot-dsl): the block dedented as a whole matches once and lands at the file's indent", () => {
  const w = tolerantWindows(GRAPH, GRAPH_OLD);
  assert.deepEqual(w, [{ line0: 6, line1: 8, prefix: "    ", sign: 1 }]);
  const f = forgive(GRAPH, [{ oldText: GRAPH_OLD, newText: GRAPH_NEW }], NF("dot_dsl.py"));
  assert.equal(f?.kind, "applied");
  assert.equal(f!.text, "Applied (whitespace-tolerant match, lines 7-11).");
  assert.equal(
    f!.kind === "applied" && f!.content,
    "class Edge:\n    def __init__(self, src, dst, attrs):\n        self.src = src\n\n\nclass Graph:\n    def __init__(self, data=None):\n        self.nodes = []\n        if data:\n            for item in data:\n                self.nodes.append(item)\n",
  );
});

test("category uniform indent shift, the other way: more indentation than the file has is taken off the replacement too", () => {
  const file = "def f():\n    return 1\n";
  const f = forgive(file, [{ oldText: "        def f():\n            return 1", newText: "        def f():\n            return 2" }], NF("m.py"));
  assert.equal(f?.kind === "applied" && f.content, "def f():\n    return 2\n");
  // a replacement line with less indentation than the shift removes cannot be placed: nothing applies
  assert.equal(reindent("        a\n    b", "        ", -1), null);
  assert.equal(forgive(file, [{ oldText: "        def f():\n            return 1", newText: "        x = 1\n    y = 2" }], NF("m.py")), null);
});

test("tabs: a tab-indented file and a dedented oldText; the tab is the shift, blank lines stay blank", () => {
  const file = "func main() {\n\tif x {\n\t\ty()\n\n\t}\n}\n";
  const f = forgive(file, [{ oldText: "if x {\n\ty()\n\n}", newText: "if x {\n\ty()\n\n\tz()\n}" }], NF("main.go"));
  assert.equal(f?.kind === "applied" && f.content, "func main() {\n\tif x {\n\t\ty()\n\n\t\tz()\n\t}\n}\n");
  // spaces for tabs is not a uniform shift: no guess
  assert.deepEqual(tolerantWindows(file, "    if x {\n        y()"), []);
});

test("category uniform indent shift, 4 edits in one call (paasio): all four apply together, each at its own place", () => {
  const file = "class MeteredFile:\n    def read(self, size=-1):\n        pass\n\n    def write(self, b):\n        pass\n\n\nclass MeteredSocket:\n    def recv(self, bufsize, flags=0):\n        pass\n";
  const edits: EditPair[] = [
    { oldText: "def read(self, size=-1):\n    pass", newText: "def read(self, size=-1):\n    self.read_ops += 1\n    return super().read(size)" },
    { oldText: "def write(self, b):\n    pass", newText: "def write(self, b):\n    return super().write(b)" },
    { oldText: "def recv(self, bufsize, flags=0):\n    pass", newText: "def recv(self, bufsize, flags=0):\n    return self._s.recv(bufsize, flags)" },
  ];
  const f = forgive(file, edits, NF_I(0, "paasio.py"));
  assert.equal(f?.kind, "applied");
  assert.equal(f!.text, "Applied 3 blocks (whitespace-tolerant match, lines 2-4, 6-7, 11-12).");
  assert.equal(
    f!.kind === "applied" && f!.content,
    "class MeteredFile:\n    def read(self, size=-1):\n        self.read_ops += 1\n        return super().read(size)\n\n    def write(self, b):\n        return super().write(b)\n\n\nclass MeteredSocket:\n    def recv(self, bufsize, flags=0):\n        return self._s.recv(bufsize, flags)\n",
  );
});

test("multi-edit semantics kept: one edit that cannot be placed and nothing applies; overlaps refused; exact and tolerant edits mix", () => {
  const file = "a = 1\nclass C:\n    def f(self):\n        pass\n    def g(self):\n        pass\n";
  const ok = { oldText: "def f(self):\n    pass", newText: "def f(self):\n    return 1" };
  assert.equal(forgiveApply(file, [ok, { oldText: "def h(self):\n    pass", newText: "x" }]), null, "edits[1] is nowhere: all or nothing");
  assert.equal(forgiveApply(file, [ok, { oldText: "    pass", newText: "x" }]), null, "an exact duplicate in the call: nothing");
  assert.equal(forgiveApply(file, [ok, { oldText: "def f(self):", newText: "def f(self, x):" }]), null, "overlapping edits: nothing");
  const mix = forgiveApply(file, [ok, { oldText: "a = 1", newText: "a = 2" }]);
  assert.equal(mix?.content, "a = 2\nclass C:\n    def f(self):\n        return 1\n    def g(self):\n        pass\n");
  assert.equal(mix?.tolerant, 1);
});

test("a one-line oldText is never placed by indentation alone: located instead (a same-text line may sit at another level)", () => {
  const file = "def f():\n  if x:\n    y = 1\n  return y\n";
  assert.equal(forgiveApply(file, [{ oldText: "        y = 1", newText: "        y = 2" }]), null);
  assert.equal(forgiveApply(file, [{ oldText: "        y = 1\n\n", newText: "        y = 2" }]), null, "blank lines do not count");
  const f = forgive(file, [{ oldText: "        y = 1", newText: "        y = 2" }], NF("m.py"));
  assert.equal(f?.kind, "clarified");
  assert.equal(f!.text, "oldText not exact. Same lines, other indent, at lines 3. Copy indent from file.\n3: above 2| if x:, below 4| return y");
  // two lines with one shift: applied
  assert.equal(forgiveApply(file, [{ oldText: "      if x:\n        y = 1", newText: "      if x:\n        y = 2" }])?.content, "def f():\n  if x:\n    y = 2\n  return y\n");
});

test("0 or 2+ tolerant places never apply; a non-uniform shift is no match", () => {
  const two = "class A:\n    def f(self):\n        pass\nclass B:\n    def f(self):\n        pass\n";
  assert.equal(tolerantWindows(two, "def f(self):\n    pass").length, 2);
  assert.equal(forgiveApply(two, [{ oldText: "def f(self):\n    pass", newText: "def f(self):\n    return 1" }]), null);
  assert.equal(forgiveApply(GRAPH, [{ oldText: "def __init__(self, data=None):\n    return", newText: "x" }]), null, "0 places");
  // the first line dedented by 4, the second by 8: the lines are there, the structure is not what the model meant
  assert.deepEqual(tolerantWindows(GRAPH, "def __init__(self, data=None):\npass"), []);
});

test("category uniform shift at 2 places (connect, 10-edit calls): not applied, the result says where", () => {
  const file =
    "    def get_winner(self):\n        # Check for O's vertical connection\n        for row in self.board:\n            return 'O'\n\n        # Check for O's vertical connection (top to bottom)\n        for row in self.board:\n            return 'O'\n";
  const edits = [{ oldText: "for row in self.board:\n    return 'O'", newText: "for row in self.board:\n    return 'X'" }];
  const f = forgive(file, edits, NF_I(0, "connect.py"));
  assert.equal(f?.kind, "clarified");
  assert.equal(
    f!.text,
    [
      "oldText not exact. Same lines, other indent, at lines 3-4, 7-8. Copy indent from file; add a nearby line to make it unique.",
      "3-4: above 2| # Check for O's vertical connection, below 6| # Check for O's vertical connection (top to bottom)",
      "7-8: above 6| # Check for O's vertical connection (top to bottom)",
    ].join("\n"),
  );
});

test("category duplicate oldText (connect, bowling): each occurrence's lines with the nearest line above and below; never applied", () => {
  const file = "class Game:\n    def roll(self, pins):\n        self.rolls.append(pins)\n        self.frame.append(pins)\n        self.frame.append(pins)\n        if pins == 10:\n            pass\n";
  const f = forgive(file, [{ oldText: "        self.frame.append(pins)", newText: "x" }], DUP(2, "bowling.py"));
  assert.equal(f?.kind, "clarified");
  assert.equal(
    f!.text,
    "oldText at lines 4, 5. Add a nearby line to make it unique.\n4: above 3| self.rolls.append(pins), below 5| self.frame.append(pins)\n5: above 4| self.frame.append(pins), below 6| if pins == 10:",
  );
  // a multi-edit call names the edit; more than 4 places: the rest counted
  const many = "x\n" + "y = 1\n".repeat(6);
  const m = forgive(many, [{ oldText: "a", newText: "b" }, { oldText: "y = 1", newText: "y = 2" }], "Found 6 occurrences of edits[1] in m.py. Each oldText must be unique.");
  assert.match(m!.text, /^edits\[1\] oldText at lines 2, 3, 4, 5, 6, 7\. Add a nearby line/);
  assert.match(m!.text, /\n\+2 more$/);
  // Pi counts with trailing spaces ignored: the same here
  assert.deepEqual(occurrences("a  \nb\na\n", "a"), [{ line0: 0, line1: 1 }, { line0: 2, line1: 3 }]);
});

test("categories stale or invented text, and no-op edits: Pi's message stays", () => {
  // paasio: the model's picture of the file skipped the docstring and the blank lines between methods
  const file = 'class MeteredFile:\n    """Implement using a subclassing model."""\n\n    def read(self, size=-1):\n        pass\n\n    @property\n    def read_bytes(self):\n        pass\n';
  const old = "class MeteredFile:\n    def read(self, size=-1):\n        pass\n    @property\n    def read_bytes(self):\n        pass";
  assert.equal(forgive(file, [{ oldText: old, newText: "x" }], NF("paasio.py")), null);
  // bowling after a best-tree restore: the model edits lines that are no longer there
  assert.equal(forgive("class BowlingGame:\n    def __init__(self):\n        pass\n", [{ oldText: "    def __init__(self):\n        self.rolls = []", newText: "x" }], NF("bowling.py")), null);
  // the same text as the file (dot-dsl after its own write): no change, nothing written
  assert.equal(forgive(GRAPH, [{ oldText: GRAPH_OLD, newText: GRAPH_OLD }], NF("dot_dsl.py")), null);
  assert.equal(forgive(GRAPH, [{ oldText: GRAPH_OLD, newText: "x" }], "No changes made to dot_dsl.py."), null);
});

test("line endings and BOM are kept as Pi keeps them; a final newline in oldText takes the line break", () => {
  const crlf = "\uFEFFclass G:\r\n    def f(self):\r\n        pass\r\n";
  const f = forgive(crlf, [{ oldText: "def f(self):\n    pass", newText: "def f(self):\n    return 1" }], NF("g.py"));
  assert.equal(f?.kind === "applied" && f.content, "\uFEFFclass G:\r\n    def f(self):\r\n        return 1\r\n");
  const nl = forgiveApply("a:\n    b\n    c\nd\n", [{ oldText: "b\nc\n", newText: "e\n" }]);
  assert.equal(nl?.content, "a:\n    e\nd\n");
  assert.deepEqual(nl?.lines, [[2, 2]]);
});

test("the switch: on by default, a boolean", () => {
  assert.equal(DEFAULTS.limits.forgiveEdits, true);
  assert.equal(mergeConfig({ limits: { forgiveEdits: false } }).limits.forgiveEdits, false);
  assert.throws(() => mergeConfig({ limits: { forgiveEdits: "yes" } }), /limits\.forgiveEdits: must be true or false/);
});

/** Pi's real edit tool on `cwd`: the result as the tool_result hook sees it */
async function piEdit(cwd: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const def = createEditToolDefinition(cwd);
  try {
    const r = await def.execute("id", def.prepareArguments!(input) as never, undefined, undefined, { cwd } as never);
    return { text: (r.content[0] as { text: string }).text, isError: false };
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}

test("forgiveEditCall on disk: Pi's real error for the dot-dsl edit, then the file written; never a test file, never outside cwd", async () => {
  const cwd = tmpDir("tc-forgive-");
  writeFileSync(join(cwd, "dot_dsl.py"), GRAPH);
  writeFileSync(join(cwd, "dot_dsl_test.py"), GRAPH);
  const input = { path: "dot_dsl.py", edits: [{ oldText: GRAPH_OLD, newText: GRAPH_NEW }] };
  const pi = await piEdit(cwd, input);
  assert.deepEqual(pi, { text: NF("dot_dsl.py"), isError: true }, "Pi refuses it");
  const f = forgiveEditCall(cwd, input, pi.text, isTestPath);
  assert.equal(f?.path, "dot_dsl.py");
  assert.equal(f?.result.text, "Applied (whitespace-tolerant match, lines 7-11).");
  assert.match(readFileSync(join(cwd, "dot_dsl.py"), "utf8"), /\n        self\.nodes = \[\]\n        if data:\n/);
  assert.equal(forgiveEditCall(cwd, { ...input, path: "dot_dsl_test.py" }, pi.text, isTestPath), null, "the test file");
  assert.equal(readFileSync(join(cwd, "dot_dsl_test.py"), "utf8"), GRAPH);
  assert.equal(forgiveEditCall(cwd, { ...input, path: "../dot_dsl.py" }, pi.text, isTestPath), null, "outside cwd");
});

// the extension's hook (same harness as tools.test.ts)
type Handler = (e: unknown, ctx: unknown) => unknown;
async function loadExt(env: Record<string, string>) {
  Object.assign(process.env, env);
  const mod = await import("../../extensions/tinycode/index.ts");
  const handlers = new Map<string, Handler[]>();
  const active = ["read", "bash", "edit", "write"];
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, [...(handlers.get(n) ?? []), h]),
    registerTool: (t: { name: string }) => void active.push(t.name),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerProvider: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    setModel: async () => true,
    getActiveTools: () => [...active],
    setActiveTools: () => {},
  };
  mod.default(pi as never);
  return (e: unknown, ctx: unknown) => handlers.get("tool_result")![0]!(e, ctx) as { content: { text: string }[]; isError?: boolean } | undefined;
}

test("the extension: a forgiven edit is a success for the model and the loop; switch off = Pi's result untouched; one log line", async () => {
  for (const on of [true, false]) {
    const cwd = tmpDir("tc-forgive-ext-");
    const log = join(cwd, "calls.jsonl");
    writeFileSync(join(cwd, "cfg.json"), JSON.stringify({ limits: { forgiveEdits: on } }));
    writeFileSync(join(cwd, "dot_dsl.py"), GRAPH);
    const hook = await loadExt({ TINYCODE_CONFIG: join(cwd, "cfg.json"), TINYCODE_LOG: log });
    const input = { path: "dot_dsl.py", edits: [{ oldText: GRAPH_OLD, newText: GRAPH_NEW }] };
    const pi = await piEdit(cwd, input);
    const out = hook({ type: "tool_result", toolName: "edit", toolCallId: "c1", input, content: [{ type: "text", text: pi.text }], details: undefined, isError: true }, { cwd, hasUI: false });
    if (on) {
      assert.deepEqual(out, { content: [{ type: "text", text: "Applied (whitespace-tolerant match, lines 7-11)." }], isError: false });
      const rec = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.step === "edit_forgive");
      assert.equal(rec.length, 1);
      assert.equal(rec[0].status, "applied: dot_dsl.py lines 7-11 (1 tolerant)");
    } else {
      assert.equal(out, undefined, "Pi's error goes to the model as Pi wrote it");
      assert.equal(readFileSync(join(cwd, "dot_dsl.py"), "utf8"), GRAPH);
    }
  }
});

test("the extension: a duplicate gets the occurrence lines and stays an error", async () => {
  const cwd = tmpDir("tc-forgive-dup-");
  writeFileSync(join(cwd, "b.py"), "def f():\n    x = 1\n    x = 1\n");
  const hook = await loadExt({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const input = { path: "b.py", edits: [{ oldText: "    x = 1", newText: "    x = 2" }] };
  const pi = await piEdit(cwd, input);
  assert.equal(pi.text, DUP(2, "b.py"));
  const out = hook({ type: "tool_result", toolName: "edit", toolCallId: "c1", input, content: [{ type: "text", text: pi.text }], details: undefined, isError: true }, { cwd, hasUI: false });
  assert.equal(out?.isError, true);
  assert.equal(out?.content[0]!.text, "oldText at lines 2, 3. Add a nearby line to make it unique.\n2: above 1| def f():, below 3| x = 1\n3: above 2| x = 1");
});

// The replay: every failed edit Nemotron made, against the file as it was before that call.
interface Rec {
  run: string;
  arm: string;
  call: number;
  path: string;
  err: string;
  file: string;
  edits: EditPair[];
}
const FX = JSON.parse(readFileSync(new URL("../fixtures/forgive/nemotron-failed-edits.json", import.meta.url), "utf8")) as { files: Record<string, string>; edits: Rec[] };

test("replay over the recorded Nemotron runs: 48 failed calls would have applied, 11 clarified, 35 keep Pi's message", () => {
  const tally: Record<string, number> = {};
  for (const r of FX.edits) {
    const kind = r.err.startsWith("Could not find") ? "notfound" : r.err.startsWith("Found") ? "dup" : "other";
    const f = forgive(FX.files[r.file]!, r.edits.map((e) => ({ oldText: e.oldText, newText: e.newText })), r.err);
    const k = `${r.run}/${r.arm} ${kind} ${f?.kind ?? "pi"}`;
    tally[k] = (tally[k] ?? 0) + 1;
    if (f?.kind === "applied") {
      // the intent, where it is determinable: every replaced block is the model's newText moved by one indentation shift
      const out = f.content.split("\n");
      for (const [i, [a, b]] of f.lines.entries()) {
        const want = r.edits[i]!.newText.split("\n");
        const got = out.slice(a - 1, b);
        assert.equal(got.length, want.length);
        assert.deepEqual(got.map((l) => l.trim()), want.map((l) => l.trim()));
      }
    }
  }
  assert.deepEqual(tally, {
    "nemo-connect-r1/tinycode other pi": 4, // "No changes made": the model re-sent the file's text
    "nemo-connect-r1/tinycode notfound pi": 3, // a line the model had already removed
    "nemo-connect-r1/tinycode dup clarified": 2,
    "nemo-connect-r1/tinycode notfound clarified": 4, // 10-edit calls, dedented, each block at 2 places
    "nemo-bowling-r1/tinycode dup clarified": 5,
    "nemo-bowling-r1/tinycode notfound pi": 15, // invented lines, then the tree before a best-tree restore
    "nemo-dot-dsl-r1/tinycode notfound applied": 35,
    "nemo-dot-dsl-r1/tinycode notfound pi": 1, // after its own write: oldText = newText = the file's text, dedented
    "nemo-dot-dsl-r1/pi notfound applied": 11, // plain Pi, same model, same miss
    "nemo-paasio-r1/tinycode notfound applied": 2,
    "nemo-paasio-r1/tinycode notfound pi": 12, // the docstring and blank lines left out
  });
});
