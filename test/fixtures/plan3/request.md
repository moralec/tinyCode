Make a plan for new output formats in this exporter tool. Don't change any code yet. Write the plan to PLAN.md: a numbered list of 3 to 12 tasks in build order, each task one behaviour; under each task a `files:` line (the files it creates or changes, relative paths) and a `test:` line (the test file and what the test checks).

Requirements:
1. A `csv` format: a header row from the first record's keys, then one row per record, quoted the way Python's csv module quotes.
2. A `markdown` format: a Markdown table; a `|` inside a value is escaped as `\|`.
3. A `--fields a,b,c` option that picks and orders the columns, for every format.
4. `--list-formats` shows the new formats too.
5. Records that do not all have the same keys: a missing value is written as an empty cell (csv and markdown).
6. When no output path is given, the result goes to standard output.

Constraints: the json output must stay byte-for-byte what it is today, so the module that writes json must not change at all; register the new formats the same way json and text are registered.
