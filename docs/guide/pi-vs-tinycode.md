# See the difference

The same tasks, run once with plain Pi and once with tinyCode. Each entry gives the task, what plain Pi did, what
tinyCode did, and the takeaway. These are real recorded runs with the same model (Qwen3.6-35B-A3B), the same 16k
window and one 16 GB card. A single run varies, so read them as stories, not scores. The README has the full
results tables.

| Task | Plain Pi | Pi + tinyCode |
|---|---|---|
| [connect](#connect-the-window-runs-out) | ran out of room, 8 of 10 tests | **passed**, 30 s |
| [greenhouse](#greenhouse-only-a-traceback) | passed, 18 s | **passed, 14 s** |
| [parking](#parking-a-decoy-function) | passed, 28 s | **passed, 12 s** |
| [paasio](#paasio-a-task-that-fits) | **passed, 46 s** | passed, 204 s |
| [pricebook](#pricebook-the-right-answer-is-no-change) | changed a test file | changed a test file |
| [unitkit](#unitkit-a-bug-in-a-1500-line-file) | ran out of room | claimed a fix it never made (now fixed) |

---

### connect: the window runs out

**The task:** finish a program that decides who won a game of Hex (an Exercism exercise from the
[Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)). The tests are given.

**Plain Pi** wrote a solution and ran the tests: 2 of 10 failed. It then explored the hex-grid geometry with several
inline scripts and rewrote the whole file. By then the conversation had filled the 16k window, and its reply was
cut off with 8 of 10 tests passing. 170 s, 8 calls.

**tinyCode** saw "make the tests pass" and ran its fix workflow. Its first targeted edit made all 10 tests pass, and
the model ran them once to confirm. 30 s, 3 calls.

**Takeaway:** a short, targeted first step keeps the conversation small enough to finish.

### greenhouse: only a traceback

**The task:** "This crashes:" followed by a real Python traceback from a greenhouse sensor logger. No test is named;
hidden tests decide. The cause: missing readings (`None`) reach `min()`.

**Plain Pi** first tried to open the file at the path printed in the traceback, which didn't exist on this machine.
It listed the folder, found the file, filtered out the missing readings, then tidied its own edit. 18 s, 7 calls.

**tinyCode** picked the right file from the traceback and fixed it with one targeted edit. The model then confirmed
the fix and stopped. 14 s, 3 calls.

**Takeaway:** both got it right. tinyCode took fewer steps.

### parking: a decoy function

**The task:** "A ticket at 12:15 am shows as afternoon." There are two similar functions, `parse_date` and
`parse_datetime`. The bug is in the second.

**Plain Pi** read five files, then found that `12 am` was never mapped to hour 0, and fixed `parse_datetime`.
28 s, 6 calls.

**tinyCode** went straight to the parsing file with one targeted edit. 12 s, 3 calls.

**Takeaway:** neither fell for the decoy. tinyCode was more than twice as fast.

### paasio: a task that fits

**The task:** implement file and socket wrappers that count bytes and calls, with 25 tests given.

**Plain Pi** read the tests, wrote the implementation once, and all 25 passed. 46 s. It passed all three recorded
runs, in 46–64 s.

**tinyCode** started with its quick fix try. This is new code rather than a bug, so the try didn't solve it, and
tinyCode handed over to Pi's loop with notes and a todo list. It passed all three runs, in 204–376 s.

**Takeaway:** when a task fits easily, plain Pi is faster. tinyCode's extra steps cost time.

### pricebook: the right answer is no change

**The task:** "tests/test_catalog.py is failing. Can you fix the failing test?" The test fails only because an
environment variable is missing. The project's Makefile sets it, and the README says so. The right answer is to say
so and change nothing.

**Plain Pi** found the cause, and even confirmed that `make test` passes. Then it edited `tests/conftest.py` to set
the variable anyway.

**tinyCode** could not fix it with a code edit, which is correct. The model then also added the variable to
`tests/conftest.py`.

**Takeaway:** both took the bait. Neither yet asks "should anything change at all?"

### unitkit: a bug in a 1,500-line file

**The task:** "`convert(212, "F", "C")` returns 324.0." The bug is one line, deep inside a 1,500-line module.

**Plain Pi** read the whole module, and its context ran out. No change.

**tinyCode** (in v1.0) reported "fixed" with nothing changed. Its reproduction test had not been written, and the
tests that already passed counted as success. **This is fixed in v1.1.0:** when the tests pass before any change,
`/fix` now says so and asks for a test that fails first.

**Takeaway:** large files are hard for both, and "fixed" must mean a failing test now passes.

---

## Try it yourself (connect)

1. **Get the task, twice:**

   ```
   git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark
   cp -r polyglot-benchmark/python/exercises/practice/connect connect-pi
   cp -r polyglot-benchmark/python/exercises/practice/connect connect-tinycode
   ```

2. **Let plain Pi reach your server.** With extensions off, tinyCode's model entry is gone too, so add this to
   `~/.pi/agent/models.json`:

   ```json
   {
     "providers": {
       "local": {
         "baseUrl": "http://127.0.0.1:8080/v1",
         "api": "openai-completions",
         "apiKey": "none",
         "compat": { "supportsDeveloperRole": false, "supportsStore": false, "supportsReasoningEffort": false, "maxTokensField": "max_tokens" },
         "models": [{ "id": "tinycode-model", "name": "tinycode-model", "reasoning": false, "contextWindow": 16384, "maxTokens": 4096 }]
       }
     }
   }
   ```

3. **Run both, then their tests:**

   ```
   cd connect-pi
   pi --no-extensions --provider local --model tinycode-model -p "Edit connect.py so that the tests in connect_test.py pass. Don't change the test file."
   python3 -m pytest connect_test.py -q

   cd ../connect-tinycode
   pi --model tinycode/tinycode-model -p "Edit connect.py so that the tests in connect_test.py pass. Don't change the test file."
   python3 -m pytest connect_test.py -q
   ```

Your numbers will differ from run to run.

**Next:** back to [Start here](../START-HERE.md).
