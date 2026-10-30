// System and edit rules, copied verbatim from our benchmark (SYSTEM) and tc1.py (EDIT_RULES, SYSTEM). Rule 4:
// the system prompt is fixed text, so it stays byte-identical between calls and the prefix cache keeps hitting.

/**
 * Edit replies: code, not thinking in comments (operator 2026-10-30). P4000 8k, gemma-4-12b: the bowling rung-1 reply
 * was 10.6k chars, 147 of its 217 lines comment reasoning ("# Let's just do the validation:"), cut at 3171 tokens on
 * rung 1 and rung 1b; sgf-parsing 8k cut at 2135 tokens twice.
 */
export const CODE_ONLY_RULE = "Code only. No reasoning in comments; think before, not in code.";

/** tc0.SYSTEM, in pidgin (operator 2026-10-29: terse model-facing text). The edit-block format is parsed by src/protocol/blocks.ts. */
export const TC0_SYSTEM = `Fix Python repos. Reply ONLY edit blocks, one per change, exactly:

path/to/file.py
<<<<<<< SEARCH
exact lines copied from the file
=======
new lines
>>>>>>> REPLACE

SEARCH matches file exactly (whole lines, short, unique). New file: empty SEARCH. Never edit tests. No explanations. ${CODE_ONLY_RULE}`;

/** tc1.EDIT_RULES: tc0.SYSTEM with the tests sentence replaced. */
export const TESTS_RULE = "Never edit the given test; add tests only if task asks.";
export const EDIT_RULES = TC0_SYSTEM.replace("Never edit tests.", TESTS_RULE);

/** tc1.SYSTEM, the one used by tc1, tc2 and the ladder. */
export const SYSTEM =
  "Fix and extend code repos in two steps. Step 1: from outline, pick files to change, JSON. " +
  "Step 2: get those files, reply edit blocks.\n\n" +
  EDIT_RULES;
