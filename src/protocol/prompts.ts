// System and edit rules, copied verbatim from our benchmark (SYSTEM) and tc1.py (EDIT_RULES, SYSTEM). Rule 4:
// the system prompt is fixed text, so it stays byte-identical between calls and the prefix cache keeps hitting.

/** tc0.SYSTEM */
export const TC0_SYSTEM = `You fix Python repositories. Reply ONLY with edit blocks, one per change, in exactly this format:

path/to/file.py
<<<<<<< SEARCH
exact lines copied from the file
=======
new lines
>>>>>>> REPLACE

SEARCH must match the current file exactly (copy whole lines; keep it short but unique). To create a file, use
an empty SEARCH. Never edit tests. No explanations.`;

/** tc1.EDIT_RULES: tc0.SYSTEM with the tests sentence replaced. */
export const EDIT_RULES = TC0_SYSTEM.replace(
  "Never edit tests.",
  "Never edit the test you were given; add new tests only when the task asks for them.",
);

/** tc1.SYSTEM, the one used by tc1, tc2 and the ladder. */
export const SYSTEM =
  "You fix and extend code repositories in two steps. Step 1: from an outline you pick the files to " +
  "change, as JSON. Step 2: you get those files and reply with edit blocks.\n\n" +
  EDIT_RULES;
