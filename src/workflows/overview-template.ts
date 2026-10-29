// The fixed page for /doc readme (S17): one self-contained HTML file, system fonts, no external requests, no scripts
// besides the embedded JSON. Placeholders {{NAME}} are filled in one pass by docreadme.ts (model text is HTML-escaped
// before it gets here and is never scanned for placeholders). Same eight section ids as an earlier overview template
// simplified: no web font, one stylesheet.
export const overviewTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{TITLE}} - Overview</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root { --text: #1f2937; --dim: #6b7280; --bg: #ffffff; --line: #e5e7eb; --code: #f3f4f6; --accent: #211951; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: var(--text); background: var(--bg); }
header { background: #211951; color: #fff; padding: 2rem 1rem 1.5rem; }
header .inner, main { max-width: 760px; margin: 0 auto; }
header p.kicker { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.6; }
header h1 { font-size: 2rem; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; }
header p.meta { font-size: 0.8rem; opacity: 0.6; margin-top: 0.5rem; }
nav { display: flex; flex-wrap: wrap; gap: 0.25rem 0.9rem; margin-top: 1rem; }
nav a { color: #fff; opacity: 0.75; text-decoration: none; font-size: 0.8rem; }
main { padding: 0 1rem 4rem; }
h2 { font-size: 1.3rem; font-weight: 600; color: var(--accent); margin: 2rem 0 0.75rem; padding-bottom: 0.4rem; border-bottom: 2px solid var(--line); }
p { margin-bottom: 0.75rem; color: var(--dim); }
p b, li b { color: var(--text); font-weight: 600; }
ul { margin: 0 0 0.75rem 1.2rem; color: var(--dim); }
li { margin-bottom: 0.35rem; }
ul.changes { list-style: none; margin-left: 0; }
.date { display: inline-block; min-width: 6.5rem; color: var(--text); font-variant-numeric: tabular-nums; }
.flow { font-style: italic; }
.none { color: #9ca3af; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; background: var(--code); padding: 0.1rem 0.35rem; border-radius: 4px; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; margin-bottom: 0.75rem; font-size: 0.92rem; }
td { padding: 0.5rem 0.5rem 0.5rem 0; border-bottom: 1px solid var(--line); vertical-align: top; color: var(--dim); }
td:first-child { width: 34%; white-space: nowrap; }
@media (max-width: 560px) {
  header h1 { font-size: 1.6rem; }
  td { display: block; width: auto; border-bottom: none; padding: 0.1rem 0; }
  td:first-child { width: auto; padding-top: 0.6rem; white-space: normal; }
  tr { display: block; border-bottom: 1px solid var(--line); padding-bottom: 0.5rem; }
}
</style>
</head>
<body>
<header>
<div class="inner">
<p class="kicker">Project overview</p>
<h1>{{TITLE}}</h1>
<p class="meta">{{MACHINE}} · commit {{COMMIT}} · generated {{DATE}} by tinyCode /doc readme</p>
<nav><a href="#what">What</a><a href="#use">Use</a><a href="#how">How</a><a href="#data">Data</a><a href="#runs">Runs</a><a href="#layout">Layout</a><a href="#related">Related</a><a href="#changes">Changes</a></nav>
</div>
</header>
<main>
<section id="what"><h2>What it is</h2>
{{WHAT}}
</section>
<section id="use"><h2>How you use it</h2>
{{USE}}
</section>
<section id="how"><h2>How it works</h2>
{{HOW}}
</section>
<section id="data"><h2>Data</h2>
{{DATA}}
</section>
<section id="runs"><h2>Where it runs</h2>
{{RUNS}}
</section>
<section id="layout"><h2>Project layout</h2>
{{LAYOUT}}
</section>
<section id="related"><h2>Related projects</h2>
{{RELATED}}
</section>
<section id="changes"><h2>Recent changes</h2>
{{CHANGES}}
</section>
</main>
<script type="application/json" id="overview-data">
{{OVERVIEW_DATA}}
</script>
</body>
</html>
`;
