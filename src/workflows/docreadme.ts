// /doc readme (S17): a standard, high-level overview page for a project, or section-by-section README updates.
// A TypeScript port of an earlier an earlier Python tool (design
// in DESIGN-overview.md next to it): our own code, same flow, same fixed sections and the same specifics check.
//
//   1. one line per file (chunked reads for a big file: one call per 12k-char chunk, then one merge call)
//   2. one summary per top-level folder, from its file lines
//   3. fixed sections written from those summaries, never from raw code: what, use, how, data, layout
//   4. code-only facts, no model: how it starts, address, related projects (named by the caller), recent git log
//   5. the specifics checker: model prose may not hold digits, paths, dotted names, snake_case/camelCase identifiers or
//      backticks unless the token is a code-only fact; caps on words. One retry naming the offending tokens, then the
//      offending sentences are dropped and reported
//   6. a self-check call flags sentences the notes do not support (flagged on the page, never rewritten)
//   7. docs/overview.html from one fixed template, with the data embedded as JSON
//
// Call budget (sequential, nothing parallel): per file 1 call, or chunks (<= 12) + 1 merge for a file over 12k chars;
// per top-level folder 1; per section 1 (what, use, how, data, layout = 5) + 1 retry only for a section that failed
// the check; 1 self-check. With the default 30 files: about 30 + folders + 6..11 calls, at most 12 sentence-sized
// answers per file. README mode (`--update`): per named section 1 (+1 retry) after steps 1-2, plus 1 self-check; it
// edits only the named sections' text and refuses to touch a whole README in one call. Pure Node: git through
// execFile (no shell), no Unix tools.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { isDev } from "../mode.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import { trackedFiles } from "../context/evidence.ts";
import type { Message } from "../llm.ts";
import { applyEdit } from "../protocol/apply.ts";
import type { ChatFn } from "./fix.ts";
import { overviewTemplate } from "./overview-template.ts";

export const FILE_CHARS = 12000;
export const MAX_CHUNKS = 12;
export const PROSE_CHARS = 3000;
export const LAYOUT_ROWS = 12;
export const MAX_FILES_DEFAULT = 30;
export const MAX_UPDATE_SECTIONS = 6;
const READ_CAP = 400_000;
const ROW_WORDS = 15;
const LUMP = 4;
const PART_WORDS = 20;
const UPDATE_WORDS = 120;
export const SECTIONS = ["what", "use", "how", "data", "runs", "layout", "related", "changes"] as const;
export type SectionId = (typeof SECTIONS)[number];
export const TITLES: Record<SectionId, string> = {
  what: "What it is",
  use: "How you use it",
  how: "How it works",
  data: "Data",
  runs: "Where it runs",
  layout: "Project layout",
  related: "Related projects",
  changes: "Recent changes",
};
const CAPS: Record<string, number> = { what: 90, use: 90, how: 140, data: 80, update: UPDATE_WORDS };
const SKIP_READ = new Set(["md", "json", "txt", "css", "lock", "data"]);
const PLAN_RX = /(^|\/)(DESIGN|BACKLOG|TODO)[^/]*$|(^|\/)[^/]*PLAN[^/]*$/i;
const TEST_RX = /(^|\/)(tests?|spec|__tests__)(\/|_)|(^|\/)test_|_test\.|\.test\.|\.spec\.|conftest/;
const ENTRY_RX = /(^|\/)(main|app|server|index|cli|run|start|api)[\w-]*\.\w+$|(^|\/)[\w-]+$/;
const OK_TOKENS = new Set(["e.g", "i.e", "node.js", "next.js", "vue.js", "macos", "ios", "ipados", "iphone", "ipad", "icloud", "ebay"]);
const SKIP_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "node_modules", "__pycache__", "poetry.lock", "Cargo.lock"]);

// ---------------------------------------------------------------- arguments

export interface ReadmeArgs {
  /** folder (relative to the project) for overview.html; default docs */
  out?: string;
  maxFiles: number;
  /** names of other projects whose calls are listed under "Related projects" (code looks for URLs, imports, unit deps) */
  related: string[];
  /** README sections to check and update, by heading ("all" or none named = every section); null = write docs/overview.html */
  update: string[] | null;
  /** ask first ("Found README.md with N sections; check each ... ?") when the caller can confirm: set for routed requests */
  ask?: boolean;
  /** no README exists: write README.md from the overview content instead of docs/overview.html */
  create?: boolean;
  /** project name shown on the page; default the folder name */
  name?: string;
}

/** `[--out DIR] [--max-files N] [--related a,b] [--update "Heading,Other"] [--name N]`. */
export function parseReadmeArgs(raw: string): ReadmeArgs {
  const out: ReadmeArgs = { maxFiles: MAX_FILES_DEFAULT, related: [], update: null };
  let r = raw.trim();
  // a value: one word, one quoted string, or a comma list of quoted strings (`--update "Usage","Install"`: every one kept)
  const val = /^(?:=|\s+)((?:"[^"]*"|'[^']*')(?:\s*,\s*(?:"[^"]*"|'[^']*'))*|\S+)\s*/;
  for (;;) {
    const m = r.match(/^--(out|max-files|related|update|name)/);
    if (!m) break;
    const v = r.slice(m[0].length).match(val);
    if (!v) break;
    const quoted = [...v[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map((q) => (q[1] ?? q[2]) as string);
    const value = /^["']/.test(v[1]!) ? quoted.join(",") : v[1]!;
    r = r.slice(m[0].length + v[0].length);
    if (m[1] === "out") out.out = value;
    else if (m[1] === "max-files") out.maxFiles = Math.max(1, Math.min(200, Number.parseInt(value, 10) || MAX_FILES_DEFAULT));
    else if (m[1] === "related") out.related = value.split(",").map((x) => x.trim()).filter(Boolean);
    else if (m[1] === "update") out.update = value.split(",").map((x) => x.trim()).filter(Boolean);
    else out.name = value;
  }
  return out;
}

// ---------------------------------------------------------------- the project map (code only)

type Lang = "py" | "js" | "sh" | "code" | "unit" | "conf" | "json" | "md" | "txt" | "css" | "html" | "applescript" | "data";
const EXT: Record<string, Lang> = {
  ".py": "py", ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".mts": "js", ".cts": "js", ".jsx": "js", ".tsx": "js",
  ".sh": "sh", ".bash": "sh", ".zsh": "sh", ".ps1": "sh", ".bat": "sh", ".command": "sh",
  ".go": "code", ".rs": "code", ".java": "code", ".kt": "code", ".c": "code", ".h": "code", ".cpp": "code", ".rb": "code", ".php": "code", ".swift": "code", ".cs": "code",
  ".service": "unit", ".timer": "unit", ".plist": "conf", ".toml": "conf", ".ini": "conf", ".cfg": "conf", ".conf": "conf", ".yaml": "conf", ".yml": "conf",
  ".json": "json", ".md": "md", ".txt": "txt", ".css": "css", ".html": "html", ".scpt": "applescript", ".applescript": "applescript",
  ".csv": "data", ".svg": "data", ".lock": "data", ".map": "data",
};
const CODE_LANGS = new Set<Lang>(["py", "js", "sh", "code"]);
const codeFirst = (l: Lang) => (CODE_LANGS.has(l) ? 0 : l === "html" || l === "conf" || l === "unit" || l === "applescript" ? 1 : 2);

export interface PFile {
  path: string;
  lang: Lang;
  lines: number;
}

function readText(abs: string): string | null {
  try {
    if (statSync(abs).size > READ_CAP) return null;
    const buf = readFileSync(abs);
    if (buf.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export interface ProjectMap {
  files: PFile[];
  texts: Map<string, string>;
  tracked: string[];
  commit: string;
}

export function mapProject(cwd: string): ProjectMap {
  const tracked = trackedFiles(cwd).filter((p) => !p.split("/").some((s) => SKIP_NAMES.has(s)));
  const files: PFile[] = [];
  const texts = new Map<string, string>();
  for (const p of tracked) {
    const t = readText(join(cwd, p));
    if (t === null) continue;
    const base = basename(p);
    const lang: Lang = EXT[extname(p).toLowerCase()] ?? (/^(Makefile|Procfile|Dockerfile)$/.test(base) ? "conf" : "txt");
    texts.set(p, t);
    files.push({ path: p, lang, lines: t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0) });
  }
  return { files, texts, tracked, commit: (git(cwd, ["rev-parse", "HEAD"]) ?? "").trim() };
}

// ---------------------------------------------------------------- code-only facts

export interface StartRow {
  how: string;
  name: string;
  when?: string;
  runs?: string;
  address?: string;
  src: string;
}
export interface Runs {
  machine: string;
  starts: StartRow[];
  addresses: { address: string; src: string }[];
}

function unitFields(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*)$/);
    if (m && !/^\s*[#;]/.test(line)) (out[m[1]!] ??= []).push(m[2]!.trim());
  }
  return out;
}

function addressOf(envs: string[]): string | null {
  let host: string | null = null;
  let port: string | null = null;
  for (const e of envs)
    for (const m of e.matchAll(/([A-Z][A-Z0-9_]*)=("[^"]*"|\S+)/g)) {
      const k = m[1]!;
      const v = m[2]!.replace(/"/g, "");
      if (/^[\w.-]+:\d{2,5}$/.test(v)) return v;
      if (k.endsWith("PORT") && /^\d+$/.test(v)) port = v;
      else if (k.endsWith("HOST")) host = v;
    }
  return host && port ? `${host}:${port}` : port;
}

function scriptOf(cmd: string): string {
  const toks = (cmd || "").split(/\s+/).filter((t) => t && !t.startsWith("-"));
  for (const t of toks) if (/\.(py|sh|js|mjs|ts|rb|scpt)$/.test(t)) return basename(t);
  return toks.length ? basename(toks[toks.length - 1]!) : "";
}

const OWN_PORT = new Set(["PORT", "DEFAULT_PORT", "LISTEN_PORT", "SERVER_PORT", "HTTP_PORT", "APP_PORT", "BACKEND_PORT", "LISTEN"]);
function ownPorts(name: string, p: string, text: string): { address: string; src: string }[] {
  const me = name.replace(/\W+/g, "_").toUpperCase();
  const out: { address: string; src: string }[] = [];
  for (const m of text.matchAll(/^\s*(?:export\s+|const\s+|let\s+)?((?:[A-Z]+_)*PORT)\s*[:=]\s*["']?(\d{2,5})\b/gm))
    if (OWN_PORT.has(m[1]!) || m[1]!.startsWith(me + "_")) out.push({ address: "port " + m[2], src: p });
  for (const m of text.matchAll(/^\s*((?:[A-Z]+_)*LISTEN)\s*=.*?["'][\w.-]*:(\d{2,5})["']/gm))
    if (OWN_PORT.has(m[1]!) || m[1]!.startsWith(me + "_")) out.push({ address: "port " + m[2], src: p });
  return out;
}

export function codeRuns(map: ProjectMap, machine: string, name: string): Runs {
  const starts: StartRow[] = [];
  const addrs: { address: string; src: string }[] = [];
  const codeAddrs: { address: string; src: string }[] = [];
  const langOf = new Map(map.files.map((f) => [f.path, f.lang]));
  for (const [p, text] of map.texts) {
    const base = basename(p);
    if (TEST_RX.test(p)) continue;
    if (base.endsWith(".service") || base.endsWith(".timer")) {
      const f = unitFields(text);
      const timer = base.endsWith(".timer");
      const when = timer ? "on a timer: " + [...(f.OnCalendar ?? []), ...(f.OnUnitActiveSec ?? [])].join(", ") : f.WantedBy ? "at boot or login" : "on demand (not enabled)";
      const row: StartRow = { how: timer ? "systemd timer" : "systemd unit", name: base, when, src: p };
      if (!timer) {
        row.runs = scriptOf((f.ExecStart ?? [""])[0]!);
        const a = addressOf(f.Environment ?? []);
        if (a) {
          row.address = a;
          addrs.push({ address: a, src: p });
        }
      }
      starts.push(row);
    } else if (base.endsWith(".plist") && text.includes("<plist")) {
      const label = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
      const args = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
      const prog = args ? [...args[1]!.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]!) : [];
      const when = /StartCalendarInterval|StartInterval/.test(text) ? "on a schedule" : text.includes("KeepAlive") ? "kept alive" : text.includes("RunAtLoad") ? "at login" : "on demand";
      starts.push({ how: "launchd job", name: label ? label[1]! : base, when, runs: scriptOf(prog.join(" ")), src: p });
    } else if (/^(start|run|serve|launch)[\w-]*\.(sh|scpt|command|ps1|bat)$|^(Makefile|Procfile)$/.test(base)) {
      starts.push({ how: "script", name: p, src: p });
    } else if (base === "package.json") {
      try {
        const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
        for (const [k, v] of Object.entries(scripts)) starts.push({ how: "npm script", name: `npm run ${k}`, runs: String(v).slice(0, 80), src: p });
      } catch {
        // not JSON: no scripts
      }
    } else if (base === "pyproject.toml") {
      const sec = text.match(/^\[project\.scripts\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
      if (sec) for (const m of sec[1]!.matchAll(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/gm)) starts.push({ how: "command", name: m[1]!, runs: m[2]!, src: p });
    } else if (CODE_LANGS.has(langOf.get(p) ?? "txt")) {
      codeAddrs.push(...ownPorts(name, p, text));
    }
  }
  const uniq: { address: string; src: string }[] = [];
  const seen = new Set<string>();
  for (const a of addrs.length ? addrs : codeAddrs) {
    const port = a.address.match(/\d{2,5}/g)!.slice(-1)[0]!;
    if (!seen.has(port)) {
      seen.add(port);
      uniq.push(a);
    }
  }
  starts.sort((a, b) => Number(a.how !== "systemd unit") - Number(b.how !== "systemd unit") || (a.how < b.how ? -1 : a.how > b.how ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { machine, starts: starts.slice(0, 12), addresses: uniq };
}

export interface RelatedRow {
  name: string;
  how: string;
  src: string;
  files: number;
}
const URL_RX = /https?:\/\/[^\s'"<>]+|\b[\w.-]+:\d{2,5}\b|\blocalhost\b/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** (kind, line) of the first place file `p` calls project `n`: URL/host on a line naming it, an import, or a unit dependency. */
function callsIn(n: string, p: string, text: string): [string, number] | null {
  const names = [...new Set([esc(n), esc(n.replace(/-/g, "_"))])].join("|");
  const rx = new RegExp(`(?<![A-Za-z0-9])(?:${names})(?![A-Za-z0-9])`, "i");
  const mod = new RegExp(`^\\s*(?:from|import)\\s+${esc(n.replace(/-/g, "_"))}\\b|\\brequire\\(\\s*['"][^'"]*${esc(n)}['"]|^\\s*import\\b.*from\\s+['"][^'"]*${esc(n)}['"]`, "i");
  const unit = /\.(service|timer|socket)$/.test(p);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (mod.test(line)) return ["import", i + 1];
    if (!rx.test(line)) continue;
    if (unit && /^\s*(After|Requires|Wants|BindsTo|PartOf|Requisite)\s*=/.test(line)) return ["systemd dependency", i + 1];
    if (URL_RX.test(line)) return ["URL or host", i + 1];
  }
  return null;
}

/** Projects from the caller's list that this code calls (not merely names); docs, logs and tests never count. */
export function codeRelated(name: string, map: ProjectMap, candidates: string[]): RelatedRow[] {
  const hits = new Map<string, RelatedRow>();
  const langOf = new Map(map.files.map((f) => [f.path, f.lang]));
  for (const n of candidates) {
    if (n.toLowerCase() === name.toLowerCase() || n.length < 3) continue;
    for (const [p, text] of map.texts) {
      const l = langOf.get(p) ?? "txt";
      if (!(CODE_LANGS.has(l) || l === "unit" || l === "conf" || l === "json" || l === "html") || /(^|\/)readme[^/]*$/i.test(p) || p.startsWith("logs/") || TEST_RX.test(p)) continue;
      const c = callsIn(n, p, text);
      if (!c) continue;
      const h = hits.get(n) ?? { name: n, how: c[0], src: `${p}:${c[1]}`, files: 0 };
      h.files++;
      hits.set(n, h);
    }
  }
  return [...hits.values()].sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1)).slice(0, 8);
}

export interface Change {
  date: string;
  subject: string;
}
export function parseLog(raw: string): Change[] {
  const out: Change[] = [];
  for (const line of raw.split("\n")) {
    const i = line.indexOf("\t");
    if (i < 0) continue;
    const subj = line.slice(i + 1).trim();
    out.push({ date: line.slice(0, i).trim(), subject: subj.length <= 120 ? subj : subj.slice(0, 117).trimEnd() + "…" });
  }
  return out.slice(0, 5);
}
export const codeChanges = (cwd: string): Change[] => parseLog(git(cwd, ["log", "-5", "--date=short", "--format=%ad%x09%s", "--", "."]) ?? "");

export interface LayoutRow {
  name: string;
  kind: "folder" | "file";
  files?: number;
  in: string[];
  does?: string;
}
export function layoutRows(tracked: string[]): { rows: LayoutRow[]; more: number } {
  const dirs = new Map<string, string[]>();
  const files: string[] = [];
  for (const p of tracked) {
    const top = p.split("/")[0]!;
    if (top.startsWith(".") || (top === p && (SKIP_NAMES.has(top) || /-(shm|wal|journal)$/.test(top)))) continue;
    if (p.includes("/")) (dirs.get(top) ?? dirs.set(top, []).get(top)!).push(p);
    else files.push(p);
  }
  const rows: LayoutRow[] = [...dirs.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => ({ name: k + "/", kind: "folder" as const, files: v.length, in: v }));
  files.sort((a, b) => Number(TEST_RX.test(a)) - Number(TEST_RX.test(b)) || codeFirst(EXT[extname(a).toLowerCase()] ?? "txt") - codeFirst(EXT[extname(b).toLowerCase()] ?? "txt") || (a < b ? -1 : 1));
  rows.push(...files.map((p) => ({ name: p, kind: "file" as const, in: [p] })));
  return { rows: rows.slice(0, LAYOUT_ROWS), more: Math.max(0, rows.length - LAYOUT_ROWS) };
}

/** README names, in the order they are looked for. */
export const README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README.html", "readme.html", "docs/readme.html", "docs/README.html", "README.rst", "README.txt"];
export type ReadmeKind = "md" | "html" | "rst" | "txt";
export interface ReadmeFound {
  rel: string;
  kind: ReadmeKind;
}

/** The project's README: the first of README_CANDIDATES that exists (README.html counts), or null. */
export function findReadme(cwd: string): ReadmeFound | null {
  for (const rel of README_CANDIDATES) {
    try {
      if (!statSync(join(cwd, rel)).isFile()) continue;
    } catch {
      continue;
    }
    const ext = extname(rel).toLowerCase();
    return { rel, kind: ext === ".html" ? "html" : ext === ".rst" ? "rst" : ext === ".txt" ? "txt" : "md" };
  }
  return null;
}

/** One line saying what was found (or not), for the report. */
export function readmeLine(f: ReadmeFound | null): string {
  return f ? `README found: ${f.rel} (${f.kind})` : `no README (looked for ${README_CANDIDATES.filter((c) => c !== "readme.md" && c !== "Readme.md").join(", ")})`;
}

/** Visible text of an HTML page: scripts, styles and tags removed, common entities decoded. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** The old README's prose (background only; design, plan and backlog docs never), code fences dropped, cut at PROSE_CHARS. */
export function readmeProse(cwd: string, map: ProjectMap): { prose: string; rel: string | null; kind: ReadmeKind | null } {
  const f = findReadme(cwd);
  if (!f) return { prose: "", rel: null, kind: null };
  const raw = map.texts.get(f.rel) ?? readText(join(cwd, f.rel)) ?? "";
  const t = (f.kind === "html" ? htmlText(raw) : raw).replace(/```[\s\S]*?```/g, "");
  return { prose: t.slice(0, PROSE_CHARS), rel: f.rel, kind: f.kind };
}

// ---------------------------------------------------------------- the specifics check (no model)

export const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
export const tokens = (text: string): string[] => text.split(/\s+/).filter(Boolean).map((t) => t.replace(/^[.,;:!?()[\]{}"'“”‘’*]+|[.,;:!?()[\]{}"'“”‘’*]+$/g, ""));

export function badToken(tok: string): boolean {
  const t = tok.toLowerCase();
  if (!tok || OK_TOKENS.has(t)) return false;
  return tok.includes("`") || /\d/.test(tok) || tok.includes("/") || tok.includes("\\") || tok.includes("_") || tok.startsWith("-") || /[A-Za-z0-9]\.[A-Za-z0-9]/.test(tok) || /^[a-z]+[A-Z]/.test(tok);
}

/** Tokens too specific for model prose (digits, paths, dotted names, snake/camelCase, backticks) that are not code-only facts. */
export function specifics(text: string, allowed: Set<string>): string[] {
  const out: string[] = [];
  for (const tok of tokens(text)) if (badToken(tok) && !allowed.has(tok.toLowerCase()) && !out.includes(tok)) out.push(tok);
  return out;
}

export function allowedTokens(name: string, runs: Runs, related: RelatedRow[]): Set<string> {
  const vals = [name, ...related.map((r) => r.name)];
  for (const r of runs.starts) vals.push(r.name ?? "", r.runs ?? "");
  vals.push(...runs.addresses.map((a) => a.address));
  return new Set(vals.flatMap((v) => tokens(String(v))).filter(Boolean).map((t) => t.toLowerCase()));
}

export const sentences = (text: string): string[] => text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);

function clip(text: string, cap: number, allowed: Set<string>, dropped: string[], label: string): string {
  const keep: string[] = [];
  for (const s of sentences(text)) {
    const bad = specifics(s, allowed);
    if (bad.length) dropped.push(`${label}: dropped "${s}" (${bad.join(", ")})`);
    else keep.push(s);
  }
  while (keep.length && keep.reduce((n, s) => n + words(s), 0) > cap) {
    if (keep.length === 1) {
      const w = keep[0]!.split(/\s+/);
      dropped.push(`${label}: cut at ${cap} words: "${w.slice(cap).join(" ")}"`);
      keep[0] = w.slice(0, cap).join(" ").replace(/[,;:]+$/, "") + "…";
      break;
    }
    dropped.push(`${label}: dropped over the cap: "${keep[keep.length - 1]}"`);
    keep.pop();
  }
  return keep.join(" ");
}

type Json = Record<string, unknown>;
interface Part {
  name: string;
  does: string;
  where?: string;
}
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Json[]) : []);

function sectionTexts(sid: string, ans: Json): [string, string][] {
  if (sid === "how") return [...arr(ans.parts).map((p, i): [string, string] => [`part ${i + 1}`, `${norm(p.name)}: ${norm(p.does)}`]), ["flow", norm(ans.flow)]];
  if (sid === "layout") return arr(ans.rows).map((r): [string, string] => [norm(r.name), norm(r.does)]);
  return [["text", norm(ans.text)]];
}

/** Problems a retry must fix; empty = the section passes. */
export function checkSection(sid: string, ans: Json, allowed: Set<string>): string[] {
  const probs: string[] = [];
  for (const [label, text] of sectionTexts(sid, ans)) {
    const bad = specifics(text, allowed);
    if (bad.length) probs.push(`${label} names specific tokens: ${bad.join(", ")}`);
  }
  if (sid in CAPS) {
    const n = sectionTexts(sid, ans).reduce((a, [, t]) => a + words(t), 0);
    if (n > CAPS[sid]!) probs.push(`${n} words, the cap is ${CAPS[sid]}`);
  }
  if (sid === "how") {
    const parts = arr(ans.parts);
    if (parts.length < 3 || parts.length > 7) probs.push(`${parts.length} parts, need 3 to 7`);
    parts.forEach((p, i) => {
      if (words(norm(p.does)) > PART_WORDS) probs.push(`part ${i + 1} is ${words(norm(p.does))} words, the cap is ${PART_WORDS}`);
    });
  }
  if (sid === "layout")
    for (const r of arr(ans.rows)) if (words(norm(r.does)) > ROW_WORDS) probs.push(`${norm(r.name)} line is ${words(norm(r.does))} words, the cap is ${ROW_WORDS}`);
  return probs;
}

/** The section after the final check: offending sentences dropped, caps applied. */
export function enforce(sid: string, ans: Json, allowed: Set<string>): { ans: Json; dropped: string[] } {
  const dropped: string[] = [];
  if (sid === "how") {
    const parts: Part[] = [];
    for (const p of arr(ans.parts).slice(0, 7)) {
      const name = norm(p.name);
      const does = clip(norm(p.does), PART_WORDS, allowed, dropped, `how part '${name}'`);
      const bad = specifics(name, allowed);
      if (bad.length || !does) {
        dropped.push(`how: dropped part "${name}"` + (bad.length ? ` (${bad.join(", ")})` : " (no line left)"));
        continue;
      }
      parts.push({ name, does, where: norm(p.where) });
    }
    const used = parts.reduce((n, p) => n + words(p.name) + words(p.does), 0);
    return { ans: { parts, flow: clip(norm(ans.flow), Math.max(0, CAPS.how! - used), allowed, dropped, "how flow") }, dropped };
  }
  if (sid === "layout") return { ans: { rows: arr(ans.rows).map((r) => ({ ...r, does: clip(norm(r.does), ROW_WORDS, allowed, dropped, `layout ${norm(r.name)}`) })) }, dropped };
  return { ans: { text: clip(norm(ans.text), CAPS[sid] ?? UPDATE_WORDS, allowed, dropped, sid) }, dropped };
}

function untitle(sid: string, ans: Json): Json {
  const t = norm(ans.text);
  const title = TITLES[sid as SectionId];
  return title && t.toLowerCase().startsWith(title.toLowerCase()) ? { ...ans, text: t.slice(title.length).replace(/^[\s:.\-—]+/, "") } : ans;
}

// fuzzy name match: 1 - edit distance / longer length
function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length]![b.length]! / Math.max(a.length, b.length);
}

/** True when a `how` part names a real folder or file: by its `where`, else fuzzy on its name. */
export function partMaps(part: Part, paths: string[]): boolean {
  for (const w0 of (part.where ?? "").split(",")) {
    const w = w0.trim().replace(/`/g, "").replace(/^\.\//, "").replace(/\/$/, "");
    if (w && paths.some((p) => p === w || p.startsWith(w + "/") || p.endsWith("/" + w))) return true;
  }
  const ptoks = new Set(paths.flatMap((p) => p.toLowerCase().split(/[/_.-]+/)).filter((t) => t.length >= 3));
  const ntoks = (part.name.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((t) => !["the", "and", "for"].includes(t));
  return ntoks.some((t) => [...ptoks].some((q) => ratio(t, q) >= 0.8));
}

export function keyFiles(files: PFile[], lines: Map<string, string>, k = 5): string[] {
  const code = files.filter((f) => lines.has(f.path) && CODE_LANGS.has(f.lang));
  const big = [...code].sort((a, b) => b.lines - a.lines).slice(0, k).map((f) => f.path);
  return [...big, ...code.filter((f) => !big.includes(f.path) && ENTRY_RX.test(f.path) && !f.path.includes("/")).map((f) => f.path).slice(0, 2)];
}
export const covered = (keys: string[], parts: Part[]): string[] => {
  const where = parts.map((p) => p.where ?? "").join(" ");
  return keys.filter((k) => !where.includes(k) && !where.includes(basename(k)));
};

// ---------------------------------------------------------------- prompts and schemas

const FILE_SYSTEM = "You describe one source file for a project overview. `does`: one plain sentence, 20 words at most, saying what the file is for. No line numbers.";
const CHUNK_SYSTEM = "You describe one part of a larger source file for a project overview. `does`: one or two plain sentences, 35 words at most, saying what this part of the file does. No line numbers.";
const MERGE_SYSTEM = "You are given short descriptions of the consecutive parts of one source file. `does`: one plain sentence, 25 words at most, saying what the whole file is for, naming its main jobs.";
const FOLDER_SYSTEM = "You summarise one folder of a software project from one line per file (largest files first). `summary`: one or two plain sentences, 40 words at most, naming the folder's main roles. The roles of the largest files must appear.";
export const SECTION_SYSTEM =
  "You write one section of a short, high-level overview page of a software project, for a person or an agent who has never seen it. Plain words. High level: no numbers, no file or folder names, no paths, no ports, no function, class or variable names, no code, no backticks. Say what it does and why, not how each piece is coded. The folder summaries and file lines are the source: say only what they support. The old README is background only and may be out of date; never take a fact from it that the lines do not support. When the material does not say, write less rather than guess. Do not repeat the section title.";
const CHECK_SYSTEM =
  "You check a short project overview against notes taken from the project's code. For each numbered sentence, decide whether the notes support it. List only the sentences the notes do not support (a claim the notes do not make, or contradict), each with a short reason. Judge only from the notes. An empty list is a fine answer.";
const ASK: Record<string, string> = {
  what: "Section 'What it is': one paragraph, at most 90 words: the problem it solves and who it is for.",
  use: "Section 'How you use it': the ways a person or another program uses it (for example a web page, a command, an API, a timer that runs it), in plain words, at most 90 words. Name a way in only if the lines show it.",
  how:
    "Section 'How it works': 3 to 7 main parts, built from the folder summaries and file lines. A part is a role (what one piece does), not a folder: split a large folder into its main roles. Each part: `name` (at most 4 words, plain words, not a file name), `does` (one line, at most 18 words), and `where` (the files it lives in, copied from the lists, comma-separated; not shown to readers). Every key file must appear in the `where` of some part. Then `flow`: one sentence on how data moves between the parts. At most 140 words in all.",
  data: "Section 'Data': what it reads and what it keeps, by kind (for example photos, settings, a job queue, logs), never by field, column or table name; at most 80 words.",
  layout:
    "Section 'Project layout': for each top-level entry listed below, one line (at most 15 words) saying what is in it, from its folder summary or file line. Plain words; no file names inside the line. Return every entry, `name` copied exactly.",
};
const S = { type: "string" };
const DOES_SCHEMA = { type: "object", required: ["does"], properties: { does: S } };
const textSchema = { type: "object", required: ["text"], properties: { text: S } };
const howSchema = {
  type: "object",
  required: ["parts", "flow"],
  properties: { parts: { type: "array", minItems: 3, maxItems: 7, items: { type: "object", required: ["name", "does", "where"], properties: { name: S, does: S, where: S } } }, flow: S },
};
const layoutSchema = (names: string[]) => ({
  type: "object",
  required: ["rows"],
  properties: { rows: { type: "array", maxItems: names.length, items: { type: "object", required: ["name", "does"], properties: { name: { type: "string", enum: names }, does: S } } } },
});

/** The text cut on line boundaries into pieces of at most `size` chars (one longer line is cut hard). */
export function chunksOf(text: string, size = FILE_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (let line of text.split(/(?<=\n)/)) {
    while (line.length > size) {
      if (cur) out.push(cur);
      out.push(line.slice(0, size));
      cur = "";
      line = line.slice(size);
    }
    if (cur && cur.length + line.length > size) {
      out.push(cur);
      cur = "";
    }
    cur += line;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

export function pickFiles(files: PFile[], maxFiles: number, readmeRel: string | null): { read: string[]; cut: string[] } {
  const cands = files.filter((f) => f.path !== readmeRel && !SKIP_READ.has(f.lang) && !TEST_RX.test(f.path) && !PLAN_RX.test(f.path));
  const rank = (f: PFile) => [Number(!(ENTRY_RX.test(f.path) && CODE_LANGS.has(f.lang))), codeFirst(f.lang), -f.lines] as const;
  cands.sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  return { read: cands.slice(0, maxFiles).map((f) => f.path), cut: cands.slice(maxFiles).map((f) => f.path) };
}

export function extractJson(text: string): Json | null {
  const t = text.trim();
  const tries = [t, t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""), t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const s of tries) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === "object" && !Array.isArray(j)) return j as Json;
    } catch {
      // next
    }
  }
  return null;
}

export function buildContext(o: {
  name: string;
  runs: Runs;
  related: RelatedRow[];
  lines: Map<string, string>;
  sizes: Map<string, number>;
  folders: Map<string, string>;
  keys: string[];
  unread: string[];
  prose: string;
}): string {
  const L: string[] = [`Project: ${o.name}`, "", "How it starts (from the code):"];
  const starts = o.runs.starts.map((r) => `- ${r.how} ${r.name}` + (r.runs ? ` runs ${r.runs}` : "") + (r.when ? `, ${r.when}` : ""));
  L.push(...(starts.length ? starts : ["- nothing found"]));
  if (o.related.length) L.push("", "Other projects it calls: " + o.related.map((r) => r.name).join(", "));
  L.push("", "Folders (summary, then one line per file, largest first):");
  const by = new Map<string, string[]>();
  for (const p of o.lines.keys()) {
    const k = p.includes("/") ? p.split("/")[0]! : "";
    (by.get(k) ?? by.set(k, []).get(k)!).push(p);
  }
  const size = (p: string) => o.sizes.get(p) ?? 0;
  for (const k of [...by.keys()].filter(Boolean).sort()) {
    L.push(`${k}/ — ${o.folders.get(k) ?? ""}`.replace(/ — $/, ""));
    for (const p of by.get(k)!.sort((a, b) => size(b) - size(a))) L.push(`  - ${p.slice(k.length + 1)}: ${o.lines.get(p)}`);
  }
  if (by.get("")?.length) {
    L.push("", "Top-level files:");
    for (const p of by.get("")!.sort((a, b) => size(b) - size(a))) L.push(`  - ${p}: ${o.lines.get(p)}`);
  }
  if (o.keys.length) L.push("", "Key files (largest and entry points): " + o.keys.join(", "));
  if (o.unread.length) {
    const cnt = new Map<string, number>();
    for (const p of o.unread) cnt.set(dirname(p) === "." ? "(top level)" : dirname(p), (cnt.get(dirname(p) === "." ? "(top level)" : dirname(p)) ?? 0) + 1);
    L.push("", "Not described (tests, docs, data, or over the cap): " + [...cnt.entries()].sort().map(([k, v]) => `${k} (${v})`).join(", "));
  }
  if (o.prose) L.push("", "Background only — the old README (may be out of date; the lines above win):", o.prose);
  return L.join("\n");
}

// ---------------------------------------------------------------- the engine: calls with a budget

/** The phases `/doc readme` reports: the overview page, and an update of named README.md sections. */
export const README_PHASES = ["scan", "summarising files", "summarising folders", "writing sections", "self-check", "render"];
/** The per-section checks replace "checking sections" once the README is read (one checklist item per section). */
export const README_UPDATE_PHASES = ["scan", "summarising files", "summarising folders", "checking sections", "self-check"];

export interface ReadmeDeps {
  /** progress display (src/progress.ts); absent = none */
  progress?: Progress;
  /** a UI's yes/no for the offer before a README check or creation; absent: no question is asked */
  confirm?: (question: string) => Promise<boolean>;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export interface ReadmeResult {
  ok: boolean;
  calls: number;
  byStep: Record<string, number>;
  /** the page written, or README.md for --update */
  output: string | null;
  updated: string[];
  flagged: string[];
  dropped: string[];
  failed: string[];
  lines: string[];
  reason?: string;
  /** README sections whose call failed twice: left as they were and shown as "not checked" */
  notChecked?: string[];
  /** README sections whose update the deletion guard refused */
  refused?: string[];
}

interface Engine {
  ask: (kind: string, system: string, user: string, schema: object, maxTokens: number) => Promise<Json | null>;
  calls: Record<string, number>;
  failed: string[];
}

function makeEngine(deps: ReadmeDeps): Engine {
  const calls: Record<string, number> = {};
  const failed: string[] = [];
  return {
    calls,
    failed,
    ask: async (kind, system, user, schema, maxTokens) => {
      calls[kind] = (calls[kind] ?? 0) + 1;
      const messages: Message[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      try {
        const r = await deps.chat("doc", messages, { schema, schemaName: kind.replace(/\W+/g, "_"), maxTokens, workflow: "doc", config: deps.config, env: deps.env });
        const j = extractJson(r.text);
        if (!j) failed.push(`${kind}: answer was not JSON`);
        return j;
      } catch (e) {
        failed.push(`${kind}: ${(e as Error).message}`);
        return null;
      }
    },
  };
}

interface Notes {
  lines: Map<string, string>;
  sizes: Map<string, number>;
  parts: Map<string, string[]>;
  folders: Map<string, string>;
  read: string[];
  cut: string[];
  truncated: string[];
  keys: string[];
  unread: string[];
}

/** Steps 1 and 2: one line per file (chunks + merge for a big file), one summary per top-level folder. */
async function describeProject(map: ProjectMap, maxFiles: number, readmeRel: string | null, eng: Engine, pg: Progress): Promise<Notes> {
  const sizes = new Map(map.files.map((f) => [f.path, f.lines] as const));
  const { read, cut } = pickFiles(map.files, maxFiles, readmeRel);
  const lines = new Map<string, string>();
  const parts = new Map<string, string[]>();
  const truncated: string[] = [];
  for (const [fi, p] of read.entries()) {
    pg.step("summarising files", fi + 1, read.length);
    const text = map.texts.get(p) ?? "";
    const cs = chunksOf(text);
    if (cs.length === 1) {
      const j = await eng.ask("file", FILE_SYSTEM, `File: ${p}\n\n${text}`, DOES_SCHEMA, 120);
      if (j && norm(j.does)) lines.set(p, norm(j.does));
      else eng.failed.push(`file ${p}: answer unusable`);
      continue;
    }
    const n = Math.min(cs.length, MAX_CHUNKS);
    if (n < cs.length) truncated.push(`${p}: ${n} of ${cs.length} chunks read`);
    const notes: string[] = [];
    for (let k = 0; k < n; k++) {
      const j = await eng.ask("chunk", CHUNK_SYSTEM, `File: ${p} — part ${k + 1} of ${cs.length}\n\n${cs[k]}`, DOES_SCHEMA, 160);
      if (j && norm(j.does)) notes.push(norm(j.does));
      pg.sub();
    }
    if (!notes.length) {
      eng.failed.push(`file ${p}: no chunk answer usable`);
      continue;
    }
    parts.set(p, notes);
    const j = await eng.ask("merge", MERGE_SYSTEM, `File: ${p} (${sizes.get(p)} lines). Its parts, in order:\n${notes.map((x, k) => `${k + 1}. ${x}`).join("\n")}`, DOES_SCHEMA, 140);
    lines.set(p, j && norm(j.does) ? norm(j.does) : notes.slice(0, 2).join(" "));
    pg.sub();
  }
  const unread = map.files.filter((f) => !lines.has(f.path)).map((f) => f.path);
  const byFolder = new Map<string, string[]>();
  for (const p of lines.keys()) if (p.includes("/")) (byFolder.get(p.split("/")[0]!) ?? byFolder.set(p.split("/")[0]!, []).get(p.split("/")[0]!)!).push(p);
  const folders = new Map<string, string>();
  const folderList = [...byFolder.entries()].sort();
  for (const [fk, [k, files]] of folderList.entries()) {
    pg.step("summarising folders", fk + 1, folderList.length);
    const rows: string[] = [];
    for (const p of [...files].sort((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0))) {
      rows.push(`- ${p.slice(k.length + 1)} (${sizes.get(p) ?? 0} lines): ${lines.get(p)}`);
      for (const x of parts.get(p) ?? []) rows.push(`    part: ${x}`);
    }
    const more = unread.filter((u) => u.startsWith(k + "/")).length;
    const j = await eng.ask("folder", FOLDER_SYSTEM, `Folder: ${k}/\n${rows.join("\n")}` + (more ? `\n(${more} more files not described: tests, docs or data)` : ""), { type: "object", required: ["summary"], properties: { summary: S } }, 200);
    folders.set(k, j ? norm(j.summary) : "");
  }
  return { lines, sizes, parts, folders, read, cut, truncated, keys: keyFiles(map.files, lines), unread };
}

const retryUser = (user: string, ans: Json, probs: string[]) => `${user}\n\nYour previous answer:\n${JSON.stringify(ans)}\n\nFix these and answer again: ${probs.join("; ")}. Replace each named token with plain words.`;

// ---------------------------------------------------------------- rendering

const h = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const para = (t: unknown, empty = "Not enough material to say.") => (t ? `<p>${h(t)}</p>` : `<p class="none">${empty}</p>`);

interface PageData {
  schema: number;
  project: string;
  commit: string;
  generated: string;
  sections: {
    what: { text: string };
    use: { text: string };
    how: { parts: Part[]; flow: string };
    data: { text: string };
    runs: Runs;
    layout: { rows: { name: string; kind: string; does: string }[]; more: number };
    related: RelatedRow[];
    changes: Change[];
  };
  folders: Record<string, string>;
  key_files: string[];
  files: { path: string; does: string }[];
  self_check: { section: string; sentence: string; why: string }[];
}

export function renderSection(sid: SectionId, d: PageData["sections"]): string {
  switch (sid) {
    case "what":
    case "use":
    case "data":
      return para(d[sid].text);
    case "how": {
      const li = d.how.parts.map((p) => `<li><b>${h(p.name)}</b> — ${h(p.does)}</li>`).join("");
      return (li ? `<ul class="parts">${li}</ul>` : para("")) + (d.how.flow ? `<p class="flow">${h(d.how.flow)}</p>` : "");
    }
    case "layout": {
      const rows = d.layout.rows.map((r) => `<tr><td><code>${h(r.name)}</code></td><td>${h(r.does)}</td></tr>`).join("");
      return (rows ? `<table>${rows}</table>` : para("", "No files.")) + (d.layout.more ? `<p class="none">and ${d.layout.more} more</p>` : "");
    }
    case "runs": {
      const r = d.runs;
      const out = [`<p><b>Machine</b> <code>${h(r.machine)}</code></p>`];
      if (r.starts.length)
        out.push("<ul>" + r.starts.map((s) => `<li>${h(s.how)} <code>${h(s.name)}</code>` + (s.runs ? ` runs <code>${h(s.runs)}</code>` : "") + (s.when ? ` · ${h(s.when)}` : "") + (s.address ? ` · <code>${h(s.address)}</code>` : "") + "</li>").join("") + "</ul>");
      else out.push('<p class="none">No unit, job or start script found in the code.</p>');
      const extra = r.addresses.filter((a) => !r.starts.some((s) => s.address === a.address)).map((a) => a.address);
      if (extra.length) out.push("<p><b>Its addresses</b> " + extra.map((x) => `<code>${h(x)}</code>`).join(" · ") + "</p>");
      return out.join("\n");
    }
    case "related":
      return d.related.length ? "<ul>" + d.related.map((r) => `<li><b>${h(r.name)}</b> · ${h(r.how)}</li>`).join("") + "</ul>" : '<p class="none">The code calls none of the projects named for this check.</p>';
    case "changes":
      return d.changes.length ? '<ul class="changes">' + d.changes.map((c) => `<li><span class="date">${h(c.date)}</span> ${h(c.subject)}</li>`).join("") + "</ul>" : '<p class="none">No git history.</p>';
  }
}

export function renderPage(data: PageData): string {
  const json = JSON.stringify(data, null, 1).replace(/<\//g, "<\\/");
  const fill: Record<string, string> = {
    TITLE: h(data.project),
    DATE: h(data.generated),
    COMMIT: h(data.commit.slice(0, 10) || "none"),
    MACHINE: h(data.sections.runs.machine),
    OVERVIEW_DATA: json,
  };
  for (const sid of SECTIONS) fill[sid.toUpperCase()] = renderSection(sid, data.sections);
  // one pass: model text is never re-read for placeholders
  return overviewTemplate.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => fill[k] ?? "");
}

/** README.md text from the same data as the overview page: the project name, then its sections. */
export function renderReadmeMd(d: PageData): string {
  const s = d.sections;
  const out: string[] = [`# ${d.project}`, ""];
  const text = (title: string, t: string) => {
    if (t) out.push(`## ${title}`, "", t, "");
  };
  if (s.what.text) out.push(s.what.text, "");
  text(TITLES.use, s.use.text);
  if (s.how.parts.length || s.how.flow) {
    out.push(`## ${TITLES.how}`, "");
    for (const p of s.how.parts) out.push(`- **${p.name}**: ${p.does}`);
    if (s.how.parts.length) out.push("");
    if (s.how.flow) out.push(s.how.flow, "");
  }
  text(TITLES.data, s.data.text);
  if (s.runs.starts.length) {
    out.push(`## ${TITLES.runs}`, "", `Machine: ${s.runs.machine}`, "");
    for (const r of s.runs.starts) out.push(`- ${r.how} \`${r.name}\`` + (r.runs ? ` runs \`${r.runs}\`` : "") + (r.when ? ` (${r.when})` : ""));
    out.push("");
  }
  const rows = s.layout.rows.filter((r) => r.does);
  if (rows.length) out.push(`## ${TITLES.layout}`, "", ...rows.map((r) => `- \`${r.name}\`: ${r.does}`), "");
  if (s.related.length) out.push(`## ${TITLES.related}`, "", ...s.related.map((r) => `- ${r.name}: ${r.how}`), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------- the overview flow

function pageSentences(sec: PageData["sections"], sourced: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  for (const s of sentences(sec.what.text)) out.push(["what", s]);
  for (const s of sentences(sec.use.text)) out.push(["use", s]);
  for (const p of sec.how.parts) out.push(["how", `${p.name} — ${p.does}`]);
  for (const s of sentences(sec.how.flow)) out.push(["how", s]);
  for (const s of sentences(sec.data.text)) out.push(["data", s]);
  for (const r of sec.layout.rows) if (r.does && sourced.has(r.name.replace(/\/$/, ""))) out.push(["layout", `${r.name} — ${r.does}`]);
  return out;
}

async function selfCheck(sents: [string, string][], notes: string, eng: Engine): Promise<{ section: string; sentence: string; why: string }[]> {
  if (!sents.length) return [];
  const schema = { type: "object", required: ["unsupported"], properties: { unsupported: { type: "array", items: { type: "object", required: ["n", "why"], properties: { n: { type: "integer" }, why: S } } } } };
  const j = await eng.ask("check", CHECK_SYSTEM, `Notes from the code:\n${notes}\n\nOverview sentences:\n${sents.map(([sid, t], i) => `${i + 1}. [${sid}] ${t}`).join("\n")}`, schema, 900);
  const out: { section: string; sentence: string; why: string }[] = [];
  for (const f of arr(j?.unsupported)) {
    const n = f.n;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= sents.length) out.push({ section: sents[n - 1]![0], sentence: sents[n - 1]![1], why: norm(f.why) });
  }
  return out;
}

function notesText(n: Notes, runs: Runs): string {
  return [
    ...[...n.folders].filter(([, v]) => v).sort().map(([k, v]) => `${k}/: ${v}`),
    ...[...n.lines.keys()].sort((a, b) => (n.sizes.get(b) ?? 0) - (n.sizes.get(a) ?? 0)).map((p) => `${p}: ${n.lines.get(p)}`),
    ...runs.starts.map((r) => `starts: ${r.how} ${r.name}` + (r.when ? ` (${r.when})` : "")),
  ].join("\n");
}

export async function runOverview(args: ReadmeArgs, deps: ReadmeDeps): Promise<ReadmeResult> {
  const cwd = resolve(deps.cwd);
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const eng = makeEngine(deps);
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("scan");
  // no README at all: offer to create README.md from the overview content (never over an existing README)
  const createMd = Boolean(args.create) && findReadme(cwd) === null;
  if (createMd && args.ask && deps.confirm) {
    let yes = false;
    try {
      yes = await deps.confirm("No README found. Create README.md from the project overview?");
    } catch {
      yes = false;
    }
    if (!yes) {
      say("not created; no README was written");
      return { ok: false, calls: 0, byStep: {}, output: null, updated: [], flagged: [], dropped: [], failed: [], lines, reason: "declined" };
    }
  }
  const name = args.name ?? basename(cwd);
  const map = mapProject(cwd);
  if (!map.files.length) {
    say("/doc readme: no readable text files found here; nothing to describe");
    return { ok: false, calls: 0, byStep: {}, output: null, updated: [], flagged: [], dropped: [], failed: [], lines, reason: "empty" };
  }
  const runs = codeRuns(map, hostname(), name);
  const related = codeRelated(name, map, args.related);
  const changes = codeChanges(cwd);
  const { rows, more } = layoutRows(map.tracked);
  const { prose, rel: readmeRel, kind: readmeKind } = readmeProse(cwd, map);
  const allowed = allowedTokens(name, runs, related);
  say(`${name}: ${map.files.length} text files, ${runs.starts.length} start entries, ${related.length} related, ${changes.length} commits`);
  say(readmeLine(readmeRel && readmeKind ? { rel: readmeRel, kind: readmeKind } : null));

  const notes = await describeProject(map, args.maxFiles, readmeRel, eng, pg);
  const ctx = buildContext({ name, runs, related, lines: notes.lines, sizes: notes.sizes, folders: notes.folders, keys: notes.keys, unread: notes.unread, prose });

  // 3. sections: one call each, one retry for a section the check fails
  const sids = ["what", "use", "how", "data", "layout"] as const;
  const names = rows.map((r) => r.name);
  const user = (sid: string) =>
    sid !== "layout"
      ? ctx
      : ctx +
        "\n\nTop-level entries:\n" +
        rows
          .map((r) => {
            const f = notes.folders.get(r.name.replace(/\/$/, ""));
            return `- ${r.name}` + (f ? ` (folder, ${r.files} files): ${f}` : r.kind === "folder" ? ` (folder, ${r.files} files: ${r.in.slice(0, 8).map((x) => basename(x)).join(", ")})` : notes.lines.has(r.name) ? ` (file): ${notes.lines.get(r.name)}` : " (file, judge from its name)");
          })
          .join("\n");
  const schemaOf = (sid: string) => (sid === "how" ? howSchema : sid === "layout" ? layoutSchema(names) : textSchema);
  const problems = (sid: string, j: Json | null): string[] => {
    if (!j) return ["no usable answer"];
    const probs = checkSection(sid, j, allowed);
    if (sid === "how") {
      const ps = arr(j.parts) as unknown as Part[];
      const miss = covered(notes.keys, ps);
      if (miss.length) probs.push("these key files belong in the `where` of a part, with their role: " + miss.join(", "));
      for (const p of ps) {
        const n = (p.where ?? "").split(",").filter((w) => w.trim()).length;
        if (n > LUMP) probs.push(`part "${p.name}" lumps ${n} files together; split it into their main roles (a part is a role, not a folder)`);
      }
    }
    return probs;
  };
  const got: Record<string, Json> = {};
  const report = { retried: [] as string[], dropped: [] as string[], unmapped: [] as string[], uncovered: [] as string[] };
  for (const [si, sid] of sids.entries()) {
    pg.step("writing sections", si + 1, sids.length);
    const sys = `${SECTION_SYSTEM}\n\n${ASK[sid]}`;
    const u = user(sid);
    let j = await eng.ask("section", sys, u, schemaOf(sid), 900);
    const probs = problems(sid, j);
    if (probs.length) {
      report.retried.push(`${sid}: ${probs.join("; ")}`);
      const j2 = await eng.ask("retry", sys, retryUser(u, j ?? {}, probs), schemaOf(sid), 900);
      if (j2) j = j2;
      else if (!j) eng.failed.push(`section ${sid}: no usable answer after the retry`);
    }
    got[sid] = j ?? {};
  }
  const sec = {} as Record<string, Json>;
  for (const sid of sids) {
    const e = enforce(sid, untitle(sid, got[sid]!), allowed);
    report.dropped.push(...e.dropped);
    sec[sid] = e.ans;
  }
  const byName = new Map(arr(sec.layout!.rows).filter((r) => !/^not described/i.test(norm(r.does))).map((r) => [norm(r.name), norm(r.does)] as const));
  const layout = { rows: rows.map((r) => ({ name: r.name, kind: r.kind as string, does: byName.get(r.name) ?? "" })), more };
  const how = sec.how as unknown as { parts: Part[]; flow: string };
  for (const p of how.parts) if (!partMaps(p, map.tracked)) report.unmapped.push(`how part "${p.name}" (where: ${p.where || "-"}) maps to no folder or file`);
  report.uncovered = covered(notes.keys, how.parts).map((k) => `${k}: ${notes.lines.get(k) ?? ""}`);

  // 6. self-check: flagged, never rewritten
  const sections: PageData["sections"] = { what: sec.what as { text: string }, use: sec.use as { text: string }, how, data: sec.data as { text: string }, runs, layout, related, changes };
  const sourced = new Set([...notes.folders].filter(([, v]) => v).map(([k]) => k).concat([...notes.lines.keys()]));
  pg.step("self-check");
  const flagged = await selfCheck(pageSentences(sections, sourced), notesText(notes, runs), eng);

  pg.step("render");
  const data: PageData = {
    schema: 1,
    project: name,
    commit: map.commit,
    generated: new Date().toISOString().slice(0, 10),
    sections,
    folders: Object.fromEntries(notes.folders),
    key_files: notes.keys,
    files: notes.read.filter((p) => notes.lines.has(p)).map((p) => ({ path: p, does: notes.lines.get(p)! })),
    self_check: flagged,
  };
  const outDir = args.out ? resolve(cwd, args.out) : join(cwd, "docs");
  if (!createMd) mkdirSync(outDir, { recursive: true });
  const outPath = createMd ? join(cwd, "README.md") : join(outDir, "overview.html");
  writeFileSync(outPath, createMd ? renderReadmeMd(data) : renderPage(data));
  pg.touch(outPath);
  const total = Object.values(eng.calls).reduce((a, b) => a + b, 0);
  say(`wrote ${outPath}`);
  say(`calls: ${total} (${Object.entries(eng.calls).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  const note = (title: string, xs: string[]) => {
    if (xs.length) say(`${title} (${xs.length}):\n` + xs.map((x) => `  - ${x}`).join("\n"));
  };
  note("sections retried after the check", report.retried);
  note("dropped by the check", report.dropped);
  note("flagged by the self-check (not supported by the notes)", flagged.map((f) => `[${f.section}] ${f.sentence} — ${f.why}`));
  note("key files missing from How it works", report.uncovered);
  note("How parts that map to no folder or file", report.unmapped);
  note("not read (over --max-files)", notes.cut.slice(0, 10).concat(notes.cut.length > 10 ? [`... and ${notes.cut.length - 10} more`] : []));
  note("large files read only in part", notes.truncated);
  note("failed calls", eng.failed);
  return { ok: true, calls: total, byStep: eng.calls, output: outPath, updated: [], flagged: flagged.map((f) => f.sentence), dropped: report.dropped, failed: eng.failed, lines };
}

// ---------------------------------------------------------------- README: check and update sections

export interface MdSection {
  title: string;
  level: number;
  /** line index of the heading */
  at: number;
  /** body is lines (at+1 .. end-1), up to the next heading of any level */
  end: number;
}

export function mdSections(lines: string[]): MdSection[] {
  const out: MdSection[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ title: m[2]!, level: m[1]!.length, at: i, end: lines.length });
  });
  out.forEach((s, k) => {
    if (out[k + 1]) s.end = out[k + 1]!.at;
  });
  return out;
}

/** The heading a requested name means: a fixed id (what, use, how, data), the exact title, or a title containing the name. */
export function matchSection<T extends { title: string }>(want: string, secs: T[]): T | null {
  const w = want.trim().toLowerCase();
  const title = TITLES[w as SectionId]?.toLowerCase();
  return secs.find((s) => s.title.toLowerCase() === w || (title !== undefined && s.title.toLowerCase() === title)) ?? secs.find((s) => w.length >= 3 && s.title.toLowerCase().includes(w)) ?? null;
}

/** A README section located in the file text: the body is src[start, end); `text` is what a reader sees there. */
export interface RSection {
  title: string;
  level: number;
  start: number;
  end: number;
  text: string;
}

const decodeTitle = (html: string): string => htmlText(html).replace(/\s+/g, " ").trim();

/**
 * Sections of a Markdown README (headings) or an HTML one (`<section>` elements with a heading, else h2/h3 blocks).
 * A section whose body is empty is listed too (callers skip it); `src` must use "\n" line ends.
 */
export function readmeSections(src: string, kind: ReadmeKind): RSection[] {
  if (kind === "md") {
    const lines = src.split("\n");
    const starts: number[] = [];
    let at = 0;
    for (const l of lines) {
      starts.push(at);
      at += l.length + 1;
    }
    const off = (i: number) => (i < lines.length ? Math.min(starts[i]!, src.length) : src.length);
    return mdSections(lines).map((s) => {
      const start = off(s.at + 1);
      const end = off(s.end);
      return { title: s.title, level: s.level, start, end: Math.max(start, end), text: src.slice(start, Math.max(start, end)).trim() };
    });
  }
  if (kind !== "html") return [];
  const out: RSection[] = [];
  const secRe = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
  for (let m = secRe.exec(src); m; m = secRe.exec(src)) {
    const inner0 = m.index + m[0].indexOf(">") + 1;
    const innerEnd = m.index + m[0].length - "</section>".length;
    const hm = src.slice(inner0, innerEnd).match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
    if (!hm) continue;
    const start = inner0 + hm.index! + hm[0].length;
    out.push({ title: decodeTitle(hm[2]!), level: Number(hm[1]), start, end: innerEnd, text: htmlText(src.slice(start, innerEnd)) });
  }
  if (out.length) return out;
  const hRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const hs = [...src.matchAll(hRe)];
  const tail = /<\/(body|main|article)>/i.exec(src)?.index ?? src.length;
  hs.forEach((m, k) => {
    if (m[1] === "1") return;
    const start = m.index! + m[0].length;
    const end = Math.max(start, hs[k + 1]?.index ?? tail);
    out.push({ title: decodeTitle(m[2]!), level: Number(m[1]), start, end, text: htmlText(src.slice(start, end)) });
  });
  return out;
}

/** Plain revised text (paragraphs, `- ` lines) as the inner HTML of a section. */
export function textToHtml(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(h).join(" ")}</p>`);
    if (list.length) out.push(`<ul>${list.map((x) => `<li>${h(x)}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const b = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/);
    if (!line) flush();
    else if (b) {
      if (para.length) flush();
      list.push(b[1]!);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** Replace only the bodies named (`edits`), bottom up so offsets stay valid; everything else stays byte-identical. */
export function spliceSections(src: string, kind: ReadmeKind, edits: { sec: RSection; text: string }[]): string {
  let out = src;
  for (const { sec, text } of [...edits].sort((a, b) => b.sec.start - a.sec.start)) {
    const body = kind === "html" ? `\n${textToHtml(text)}\n` : `\n${text}\n\n`;
    out = out.slice(0, sec.start) + body + out.slice(sec.end);
  }
  return out;
}

/** Put each section's new source in place of its old one (bottom up, original leading and trailing whitespace kept); the rest is untouched. */
export function spliceRaw(src: string, edits: { sec: RSection; text: string }[]): string {
  let out = src;
  for (const { sec, text } of [...edits].sort((a, b) => b.sec.start - a.sec.start)) {
    const raw = out.slice(sec.start, sec.end);
    out = out.slice(0, sec.start) + (/^\s*/.exec(raw)?.[0] ?? "") + text + (/\s*$/.exec(raw)?.[0] ?? "") + out.slice(sec.end);
  }
  return out;
}

/** `{added, removed}` lines between two texts (common head and tail trimmed): a small diff stat. */
export function diffStat(before: string, after: string): { added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { removed: a.length - i - j, added: b.length - i - j };
}

const STOP = new Set(["this", "that", "with", "from", "have", "will", "your", "into", "also", "when", "then", "than", "them", "they", "each", "such", "only", "just", "more", "most", "some", "what", "which", "where", "about", "other"]);

/** The file one-liners most related to a section: ranked by shared words with its title and text. */
export function relevantLines(secText: string, notes: { lines: Map<string, string>; sizes: Map<string, number> }, k = 15): Map<string, string> {
  const want = new Set((secText.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
  const scored = [...notes.lines].map(([p, l]) => {
    const have = new Set((`${p} ${l}`.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
    let n = 0;
    for (const w of have) if (want.has(w)) n++;
    return { p, l, n, size: notes.sizes.get(p) ?? 0 };
  });
  scored.sort((a, b) => b.n - a.n || b.size - a.size);
  const picked = scored.filter((x) => x.n > 0).slice(0, k);
  for (const x of scored) if (picked.length < Math.min(5, scored.length) && !picked.includes(x)) picked.push(x);
  return new Map(picked.map((x) => [x.p, x.l]));
}

/** Revised section text after the specifics check: offending sentences dropped line by line, the word cap applied; lists keep their lines. */
export function enforceText(text: string, allowed: Set<string>, cap: number, dropped: string[], label: string): string {
  const out: string[] = [];
  let used = 0;
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*((?:[-*]|\d+[.)])\s+)?(.*)$/)!;
    const body = norm(m[2]);
    if (!body) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const kept = clip(body, Math.max(0, cap - used), allowed, dropped, label);
    if (!kept) continue;
    used += words(kept);
    out.push((m[1] ? (/^\d/.test(m[1]) ? m[1].trim() + " " : "- ") : "") + kept);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

const UPDATE_SYSTEM =
  "You check one section of a project's README against notes taken from the project's code. The section is shown as it is written in the file (Markdown or HTML source). Reply with JSON {\"verdict\": \"ok\" or \"revise\", \"reason\": one short sentence, \"edits\": [{\"search\": ..., \"replace\": ...}] (only when revising)}. " +
  "Answer \"ok\" when nothing in the section is contradicted by the notes; claims the notes do not cover are left alone. Answer \"revise\" only when the notes show the section is out of date or wrong: then give SEARCH/REPLACE edits. `search` is a short exact piece copied from the section (one sentence or one line, never the whole section); `replace` is that piece corrected. " +
  "Keep markup, entities and links exactly as written; change only what the notes contradict; do not delete parts that are still true. " +
  "Plain words; do not add numbers, file names, paths or identifiers that are not in the notes or in the current text; no backticks you were not given.";
const editSchema = { type: "object", required: ["search", "replace"], properties: { search: S, replace: S } };
const verdictSchema = { type: "object", required: ["verdict", "reason"], properties: { verdict: { type: "string", enum: ["ok", "revise"] }, reason: S, edits: { type: "array", maxItems: 6, items: editSchema } } };
/** A section update that would remove more than this share of the section's text is refused (never applied). */
export const MAX_SECTION_SHRINK = 0.2;

export interface SectionEdit {
  search: string;
  replace: string;
}

/** The edits of a model answer: only objects with a non-empty `search` string and a string `replace`. */
export function sectionEdits(j: Json): SectionEdit[] {
  return arr(j.edits)
    .filter((e) => typeof e.search === "string" && e.search.trim() && typeof e.replace === "string")
    .map((e) => ({ search: String(e.search), replace: String(e.replace) }));
}

/**
 * SEARCH/REPLACE edits applied inside one section's source (Markdown or HTML as written, nothing re-escaped). An edit
 * whose SEARCH is not in the text is reported in `missed`; the rest are applied in order.
 */
export function applySectionEdits(source: string, edits: SectionEdit[]): { text: string; applied: SectionEdit[]; missed: SectionEdit[] } {
  let cur = source;
  const applied: SectionEdit[] = [];
  const missed: SectionEdit[] = [];
  for (const e of edits) {
    const next = applyEdit(cur, e.search, e.replace);
    if (next === null) missed.push(e);
    else {
      cur = next;
      applied.push(e);
    }
  }
  return { text: cur, applied, missed };
}

/** The deletion guard: how much of the section's text the update would remove (0..1; growth counts as 0). */
export function sectionShrink(before: string, after: string): number {
  const b = before.trim().length;
  return b ? Math.max(0, (b - after.trim().length) / b) : 0;
}

const CLAIM_SYSTEM =
  "A README sentence is about to be changed. You see the old sentence, the new sentence and numbered lines from the project's source (path:line: text). " +
  "Decide which one the source supports. Reply with JSON {\"verdict\": \"old_correct\" | \"new_correct\" | \"unclear\", \"evidence\": \"path:line\"} where evidence is ONE of the numbered lines shown that supports your verdict. " +
  "Answer new_correct only when a shown line proves the new sentence (or proves the old one false); a claim the shown lines do not cover is unclear; if the old sentence is still true, old_correct.";
const claimSchema = { type: "object", required: ["verdict", "evidence"], properties: { verdict: { type: "string", enum: ["old_correct", "new_correct", "unclear"] }, evidence: S } };
export const CLAIM_LINE_CAP = 60;

/** True when the edit changes or removes text: not a pure addition (the old text is still all there inside the new). */
export function changesClaim(search: string, replace: string): boolean {
  const a = norm(search);
  const b = norm(replace);
  return a !== b && !b.includes(a);
}

/** Identifier-like words of a sentence: `backticked`, snake_case, camelCase, file names with an extension. */
export function claimIdentifiers(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/`([^`\n]{2,60})`/g)) out.add(m[1]!.trim());
    for (const m of t.matchAll(/[A-Za-z_][\w-]*(?:[./][\w-]+)*\.[A-Za-z]{1,5}\b/g)) out.add(m[0]);
    for (const m of t.matchAll(/\b[A-Za-z][a-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) out.add(m[0]);
  }
  return [...out].filter((x) => x.length >= 3);
}

/**
 * The source lines a claim's check call sees: the files its sentences name (file names), the places where their code
 * identifiers are defined or used, and the files mapped to the section (`mapped`: by the file notes). Numbered `path:line: text`.
 * `shown` is what the verdict's evidence may cite.
 */
export function claimSources(map: ProjectMap, oldText: string, newText: string, mapped: string[], cap = CLAIM_LINE_CAP): { text: string; shown: Map<string, Set<number>> } {
  const shown = new Map<string, Set<number>>();
  const rows: string[] = [];
  const add = (path: string, i: number, line: string): boolean => {
    if (rows.length >= cap) return false;
    const set = shown.get(path) ?? shown.set(path, new Set()).get(path)!;
    if (set.has(i + 1)) return true;
    set.add(i + 1);
    rows.push(`${path}:${i + 1}: ${line.trim().slice(0, 160)}`);
    return true;
  };
  /** the first lines of a definition's body (indented lines right after it) */
  const body = (path: string, i: number): void => {
    const ls = (map.texts.get(path) ?? "").split("\n");
    const ind = (x: string) => x.length - x.trimStart().length;
    for (let k = i + 1; k < ls.length && k <= i + 8; k++) {
      if (!ls[k]!.trim()) continue;
      if (ind(ls[k]!) <= ind(ls[i]!)) break;
      add(path, k, ls[k]!);
    }
  };
  const ids = claimIdentifiers(oldText, newText);
  const named = map.tracked.filter((p) => ids.some((id) => p === id || p.endsWith("/" + id) || basename(p) === basename(id)));
  const def = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|const|let|var|fn|func)\b/;
  for (const id of ids) {
    if (/\.\w{1,5}$/.test(id) && named.some((p) => p === id || p.endsWith("/" + id) || basename(p) === basename(id))) continue; // a file name: its head is shown below
    const re = new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
    const found: [string, number, string][] = [];
    for (const defsOnly of [true, false]) {
      for (const [path, text] of map.texts) {
        const ls = text.split("\n");
        for (let i = 0; i < ls.length && found.length < 3; i++) if (re.test(ls[i]!) && (!defsOnly || def.test(ls[i]!))) found.push([path, i, ls[i]!]);
        if (found.length >= 3) break;
      }
      if (found.length) break;
    }
    for (const [path, i, l] of found) {
      add(path, i, l);
      if (def.test(l)) body(path, i);
    }
  }
  for (const p of [...named, ...mapped.filter((m) => !named.includes(m))]) {
    const ls = (map.texts.get(p) ?? "").split("\n");
    const defs = ls.map((l, i) => [l, i] as const).filter(([l]) => def.test(l));
    const head = ls.map((l, i) => [l, i] as const).filter(([l]) => l.trim());
    for (const [l, i] of (defs.length >= 3 ? defs : head).slice(0, named.includes(p) ? 25 : 8)) {
      add(p, i, l);
      if (def.test(l)) body(p, i);
    }
  }
  return { text: rows.join("\n"), shown };
}

/** The evidence line of a verdict ("path:line" or "path:a-b"), when it is one of the lines the call was shown. */
export function validEvidence(evidence: unknown, shown: Map<string, Set<number>>): string | null {
  const m = norm(evidence).replace(/`/g, "").match(/^(.+?):(\d+)(?:\s*-\s*\d+)?$/);
  return m && shown.get(m[1]!)?.has(Number(m[2])) ? `${m[1]}:${m[2]}` : null;
}

export const MAX_ALL_SECTIONS = 20;

/**
 * Check a README section by section against the code (named sections, or all of them) and update the ones that are out
 * of date. One call per section returns ok or a revised body; unchanged sections stay byte-identical. Markdown sections
 * are headings; HTML sections are `<section>` elements or h2/h3 blocks, only the inner content of changed blocks is replaced.
 */
export async function runReadmeUpdate(args: ReadmeArgs, deps: ReadmeDeps): Promise<ReadmeResult> {
  const cwd = resolve(deps.cwd);
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const eng = makeEngine(deps);
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("scan");
  const fail = (reason: string): ReadmeResult => ({ ok: false, calls: 0, byStep: {}, output: null, updated: [], flagged: [], dropped: [], failed: [], lines, reason });
  const want = args.update ?? [];
  const all = !want.length || want.some((w) => /^(all|\*|everything|whole|entire)$/i.test(w));
  const found = findReadme(cwd);
  say(readmeLine(found));
  if (!found) {
    say("/doc readme --update: there is no README here; use `/doc readme` for docs/overview.html");
    return fail("no-readme");
  }
  if (found.kind !== "md" && found.kind !== "html") {
    say(`/doc readme --update: updating sections of a ${found.kind.toUpperCase()} README (${found.rel}) is not supported; ${found.rel} is left untouched and docs/overview.html is written instead`);
    return runOverview({ ...args, update: null }, deps);
  }
  const rel = found.rel;
  const original = readFileSync(join(cwd, rel), "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const src = original.replace(/\r\n/g, "\n");
  const secs = readmeSections(src, found.kind);
  const chosen: RSection[] = [];
  if (all) {
    for (const s of secs) if (s.text) chosen.push(s);
    if (!chosen.length) {
      say(`${rel}: no sections with text found (${found.kind === "html" ? "h2/h3 headings or <section> elements" : "headings"} are what is checked)`);
      return fail("no-section");
    }
    if (chosen.length > MAX_ALL_SECTIONS) {
      say(`${rel} has ${chosen.length} sections; checking the first ${MAX_ALL_SECTIONS} (name others with --update "Heading")`);
      chosen.length = MAX_ALL_SECTIONS;
    }
  } else {
    for (const w of want) {
      const s = matchSection(w, secs);
      if (!s) say(`no section named "${w}" in ${rel}; its headings: ${secs.map((x) => x.title).join(" | ") || "(none)"}`);
      else if (!chosen.includes(s)) chosen.push(s);
    }
    if (!chosen.length) return fail("no-section");
    if (chosen.length > MAX_UPDATE_SECTIONS) {
      say(`/doc readme --update: at most ${MAX_UPDATE_SECTIONS} sections per run, ${chosen.length} named`);
      return fail("too-many");
    }
  }
  say(`${rel}: ${secs.length} sections, checking ${chosen.length}`);
  // auto mode asks only for a rewrite that touches more than 3 sections; dev mode asks as before
  if (args.ask && deps.confirm && (chosen.length > 3 || isDev())) {
    let yes = false;
    try {
      yes = await deps.confirm(`Found ${rel} with ${secs.length} sections; check each against the code and update the ones that are out of date?`);
    } catch {
      yes = false;
    }
    if (!yes) {
      say(`not checked; ${rel} is as it was`);
      return fail("declined");
    }
  }
  const labels = chosen.map((s) => `check "${s.title.slice(0, 30)}"`);
  pg.declare(["scan", "summarising files", "summarising folders", ...labels, "self-check"]);
  pg.step("scan");
  const map = mapProject(cwd);
  const name = args.name ?? basename(cwd);
  const runs = codeRuns(map, hostname(), name);
  const related = codeRelated(name, map, args.related);
  const facts = allowedTokens(name, runs, related);
  for (const p of map.tracked) {
    facts.add(p.toLowerCase());
    facts.add(basename(p).toLowerCase());
  }
  const notes = await describeProject(map, args.maxFiles, rel, eng, pg);
  const dropped: string[] = [];
  const done: { sec: RSection; text: string; source: string }[] = [];
  const kept: string[] = [];
  const flagged: string[] = [];
  const refused: string[] = [];
  const notChecked: string[] = [];
  const summary: string[] = [];
  const isHtml = found.kind === "html";
  const visible = (t: string) => (isHtml ? htmlText(t) : t);
  for (const [ci, sec] of chosen.entries()) {
    pg.step(labels[ci]!);
    const source = src.slice(sec.start, sec.end).trim();
    const ctx = buildContext({ name, runs, related, lines: relevantLines(`${sec.title} ${sec.text}`, notes), sizes: notes.sizes, folders: notes.folders, keys: [], unread: [], prose: "" });
    const user = `${ctx}\n\nSection '${sec.title}' (current ${isHtml ? "HTML" : "Markdown"} source):\n${source.slice(0, 2500) || "(empty)"}`;
    const allowed = new Set([...facts, ...tokens(sec.text).map((t) => t.toLowerCase()), ...tokens(source).map((t) => t.toLowerCase())]);
    let j = await eng.ask("update", UPDATE_SYSTEM, user, verdictSchema, 700);
    let retried = false;
    if (!j) {
      // one retry for a call that failed or did not answer in JSON, then the section shows as "not checked"
      retried = true;
      j = await eng.ask("retry", UPDATE_SYSTEM, user, verdictSchema, 700);
      if (!j) {
        notChecked.push(sec.title);
        flagged.push(`${sec.title}: not checked (no usable answer after a retry); left as it was`);
        summary.push(`  ? not checked: ${sec.title} (no usable answer after a retry)`);
        continue;
      }
    }
    const reason = norm(j.reason);
    if (norm(j.verdict).toLowerCase() !== "revise") {
      kept.push(sec.title);
      summary.push(`  = kept: ${sec.title}${reason ? ` (${reason})` : ""}`);
      continue;
    }
    const problems = (a: Json): string[] => {
      const es = sectionEdits(a);
      const probs: string[] = [];
      if (!es.length) probs.push("no usable edits (give search and replace)");
      const bad = [...new Set(es.flatMap((e) => specifics(visible(e.replace), allowed)))];
      if (bad.length) probs.push(`the replacements name specific tokens: ${bad.join(", ")}`);
      const miss = applySectionEdits(source, es).missed;
      if (miss.length) probs.push(`${miss.length} search text(s) are not in the section; copy them exactly`);
      return probs;
    };
    let cur: Json = j;
    const probs = problems(cur);
    if (probs.length && !retried) {
      const j2 = await eng.ask("retry", UPDATE_SYSTEM, `${user}\n\nYour previous answer:\n${JSON.stringify(j)}\n\nFix these and answer again: ${probs.join("; ")}.`, verdictSchema, 700);
      if (j2 && norm(j2.verdict).toLowerCase() === "revise") cur = j2;
    }
    const drops: string[] = [];
    const usable: SectionEdit[] = [];
    for (const e of sectionEdits(cur)) {
      const bad = specifics(visible(e.replace), allowed);
      if (bad.length) drops.push(`update ${sec.title}: dropped an edit naming ${bad.join(", ")}`);
      else usable.push(e);
    }
    // an edit that changes or removes a claim is applied only when the code backs the new text (one small check call)
    const verified: SectionEdit[] = [];
    const rejected: string[] = [];
    const mapped = [...relevantLines(`${sec.title} ${sec.text}`, notes, 4).keys()];
    for (const e of usable) {
      if (!changesClaim(visible(e.search), visible(e.replace))) {
        verified.push(e);
        continue;
      }
      const src2 = claimSources(map, visible(e.search), visible(e.replace), mapped);
      const v = await eng.ask(
        "claim",
        CLAIM_SYSTEM,
        `Old sentence: ${norm(visible(e.search))}\nNew sentence: ${norm(visible(e.replace))}\n\nSource lines:\n${src2.text || "(none found)"}`,
        claimSchema,
        120,
      );
      const ev = v ? validEvidence(v.evidence, src2.shown) : null;
      if (v && norm(v.verdict) === "new_correct" && ev) verified.push(e);
      else {
        const why = !v ? "no usable answer" : norm(v.verdict) !== "new_correct" ? norm(v.verdict) || "no verdict" : "no valid evidence line";
        rejected.push(`kept: the code supports the original (${sec.title}: "${norm(visible(e.search)).slice(0, 50)}"; check said ${why}${v && norm(v.evidence) ? ` at ${norm(v.evidence)}` : ""})`);
      }
    }
    flagged.push(...rejected);
    const res = applySectionEdits(source, verified);
    for (const m of res.missed) drops.push(`update ${sec.title}: dropped an edit whose search text is not in the section ("${norm(m.search).slice(0, 40)}")`);
    dropped.push(...drops);
    if (!res.applied.length && rejected.length) {
      kept.push(sec.title);
      summary.push(`  = kept: ${sec.title} (kept: the code supports the original)`);
      continue;
    }
    if (!res.applied.length || norm(res.text) === norm(source)) {
      kept.push(sec.title);
      if (!res.applied.length) flagged.push(`${sec.title}: no usable edit came back, left as it was`);
      summary.push(res.applied.length ? `  = kept: ${sec.title}` : `  ! flagged: ${sec.title} (no usable edit came back, kept)`);
      continue;
    }
    const shrink = sectionShrink(visible(source), visible(res.text));
    if (shrink > MAX_SECTION_SHRINK) {
      const pct = Math.round(shrink * 100);
      kept.push(sec.title);
      refused.push(sec.title);
      flagged.push(`${sec.title}: update refused, it would remove ${pct}% of the section (limit ${Math.round(MAX_SECTION_SHRINK * 100)}%); left as it was`);
      summary.push(`  ! refused: ${sec.title} (would remove ${pct}% of the section; kept)`);
      continue;
    }
    done.push({ sec, text: res.text, source });
    if (drops.length) flagged.push(`${sec.title}: ${drops.length} edit(s) dropped by the checks`);
    summary.push(`  ~ updated: ${sec.title}${reason ? ` (${reason})` : ""}${drops.length ? ` [flagged: ${drops.length} dropped]` : ""}`);
  }
  for (const l of summary) say(l);
  if (notChecked.length) say(`not checked (${notChecked.length}): ${notChecked.join(", ")}; left as they were`);
  if (refused.length) say(`refused by the deletion guard (${refused.length}): ${refused.join(", ")}; left as they were`);
  const total = Object.values(eng.calls).reduce((a, b) => a + b, 0);
  if (!done.length) {
    say(`${rel}: no section needed a change; the file is as it was`);
    say(`calls: ${total} (${Object.entries(eng.calls).map(([k, v]) => `${k} ${v}`).join(", ")})`);
    if (flagged.length) say(`flagged (${flagged.length}):\n` + flagged.map((x) => `  - ${x}`).join("\n"));
    if (eng.failed.length) say(`failed calls (${eng.failed.length}):\n` + eng.failed.map((x) => `  - ${x}`).join("\n"));
    const usable = eng.failed.length === 0 && !notChecked.length;
    return { ok: usable, calls: total, byStep: eng.calls, output: null, updated: [], flagged, dropped, failed: eng.failed, lines, notChecked, refused, reason: usable ? "up-to-date" : "nothing-usable" };
  }
  const next = spliceRaw(src, done);
  pg.touch(rel);
  writeFileSync(join(cwd, rel), eol === "\r\n" ? next.replace(/\n/g, "\r\n") : next);
  pg.step("self-check");
  const checked = await selfCheck(done.map((d) => ["update", `${d.sec.title}: ${visible(d.text)}`] as [string, string]), notesText(notes, runs), eng);
  for (const f of checked) flagged.push(`${f.sentence} — ${f.why}`);
  const st = diffStat(src, next);
  say(`updated ${rel}: ${done.map((d) => `"${d.sec.title}" (${words(visible(d.text))} words)`).join(", ")}; ${kept.length} kept; +${st.added} -${st.removed} lines; the rest of the file is as it was (review with git diff)`);
  say(`calls: ${Object.values(eng.calls).reduce((a, b) => a + b, 0)} (${Object.entries(eng.calls).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  if (dropped.length) say(`dropped by the check (${dropped.length}):\n` + dropped.map((x) => `  - ${x}`).join("\n"));
  if (flagged.length) say(`flagged (${flagged.length}):\n` + flagged.map((x) => `  - ${x}`).join("\n"));
  if (eng.failed.length) say(`failed calls (${eng.failed.length}):\n` + eng.failed.map((x) => `  - ${x}`).join("\n"));
  return { ok: true, calls: Object.values(eng.calls).reduce((a, b) => a + b, 0), byStep: eng.calls, output: join(cwd, rel), updated: done.map((d) => d.sec.title), flagged, dropped, failed: eng.failed, lines, notChecked, refused };
}

export async function runReadme(args: ReadmeArgs, deps: ReadmeDeps): Promise<ReadmeResult> {
  return args.update ? runReadmeUpdate(args, deps) : runOverview(args, deps);
}
