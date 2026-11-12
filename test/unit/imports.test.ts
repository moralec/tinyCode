import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { localImports, reverseImports } from "../../src/context/imports.ts";

function repo(files: Record<string, string>): string {
  const cwd = tmpDir("tinycode-imports-");
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, p)), { recursive: true });
    writeFileSync(join(cwd, p), t);
  }
  return cwd;
}

test("python imports: import, from pkg import a, b (module and attribute), relative imports, a package __init__", () => {
  const files = ["app/__init__.py", "app/cli.py", "app/settings.py", "app/formats/__init__.py", "app/formats/json_fmt.py", "app/util.py", "top.py"];
  assert.deepEqual(localImports("app/cli.py", "import json\nfrom app import formats, settings\n", files), ["app/__init__.py", "app/formats/__init__.py", "app/settings.py"]);
  assert.deepEqual(localImports("x.py", "import app.util, top as t\n", [...files, "x.py"]), ["app/util.py", "top.py"]);
  assert.deepEqual(localImports("app/formats/__init__.py", "from . import json_fmt\nfrom .. import util\n", files), ["app/formats/json_fmt.py", "app/__init__.py", "app/util.py"]);
  assert.deepEqual(localImports("app/cli.py", "from .formats.json_fmt import write_json\n", files), ["app/formats/json_fmt.py"]);
  assert.deepEqual(localImports("app/cli.py", "from app.formats import (\n    json_fmt,\n    get,\n)\n", files), ["app/formats/__init__.py", "app/formats/json_fmt.py"]);
  assert.deepEqual(localImports("app/cli.py", "# from app import util\nimport os\n", files), [], "comments and stdlib give nothing");
});

test("TS/JS imports: import, export from, require, dynamic import, extension and index resolution; packages ignored; no TS scan without \"ts\"", () => {
  const files = ["src/a.ts", "src/b.ts", "src/c.tsx", "src/lib/index.ts", "src/d.js", "src/e.mjs", "src/f.ts"];
  const text = [
    'import { x } from "./b";',
    'export * from "./c";',
    'const l = require("./lib");',
    'const d = await import("./d.js");',
    'import "./e";',
    'import { y } from "./f.js";',
    'import fs from "node:fs";',
    'import z from "react";',
  ].join("\n");
  const langs = ["py", "ts"];
  assert.deepEqual(localImports("src/a.ts", text, files, langs), ["src/b.ts", "src/c.tsx", "src/lib/index.ts", "src/d.js", "src/e.mjs", "src/f.ts"]);
  assert.deepEqual(localImports("src/a.ts", text, files, ["py"]), [], "without \"ts\" there is no TS scanning");
});

test("reverse map: `from exporter import formats` imports formats/__init__.py; a different utils.py is not matched by stem", () => {
  const cwd = repo({
    "exporter/__init__.py": "",
    "exporter/cli.py": "from exporter import formats, settings\n",
    "exporter/settings.py": "X = 1\n",
    "exporter/formats/__init__.py": "from exporter.formats import utils\n",
    "exporter/formats/utils.py": "",
    "other/utils.py": "",
    "other/run.py": "from other import utils\n",
    "tests/test_x.py": "from exporter.formats import utils\nimport exporter.settings\n",
  });
  const files = ["exporter/__init__.py", "exporter/cli.py", "exporter/settings.py", "exporter/formats/__init__.py", "exporter/formats/utils.py", "other/utils.py", "other/run.py", "tests/test_x.py"];
  const m = reverseImports(cwd, ["exporter/formats/__init__.py", "exporter/formats/utils.py", "exporter/settings.py"], files);
  assert.deepEqual(m.get("exporter/formats/__init__.py"), ["exporter/cli.py", "tests/test_x.py"]);
  assert.deepEqual(m.get("exporter/formats/utils.py"), ["exporter/formats/__init__.py", "tests/test_x.py"]);
  assert.deepEqual(m.get("exporter/settings.py"), ["exporter/cli.py", "tests/test_x.py"]);
});
