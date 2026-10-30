# Pi alone vs Pi + tinyCode on two tested setups

| Card | Model (why we picked it) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| 16 GB (Tesla T4) | gpt-oss-20b (best coder that fits) | 3 of 15 | **8 of 15** |
| 16 GB (Tesla T4) | Qwen3.6-35B-A3B (popular reference) | 4 of 15 | **10 of 15** |
| 16 GB (Tesla T4) | Nemotron-Nano-9B-v2 (best coder for 8 GB cards; run here for speed) | 0 of 1 | **0 of 0** |

In the tables below each mark is one run, in order: ✓ pass with its time in seconds, ✗ fail, · not run yet.

### 16 GB · gpt-oss-20b

Tesla T4, MXFP4, 12.1 GB, 16k window, 16-bit cache. Fast: about 50 tokens/s on the T4. In some runs with plain Pi it wrote the solution and stopped without running the tests; tinyCode's fix workflow runs them and keeps going. bowling stayed out of reach for both.

| Task | What (tests) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| [connect](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/connect) | Hex game winner (10) | ✗ ✗ ✓26 | ✓72 ✓30 ✓28 |
| [bowling](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/bowling) | bowling scorer (31) | ✗ ✗ ✗ | ✗ ✗ ✗ |
| [dot-dsl](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/dot-dsl) | graph-building DSL (12) | ✓64 ✓52 ✗ | ✓44 ✓50 ✓60 |
| [paasio](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/paasio) | I/O byte counters (25) | ✗ ✗ ✗ | ✗ ✓152 ✗ |
| [sgf-parsing](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/sgf-parsing) | Go game-record parser (23) | ✗ ✗ ✗ | ✓154 ✗ ✗ |
| **Total** | solved (median s) | **3 of 15** (52 s) | **8 of 15** (55 s) |

### 16 GB · Qwen3.6-35B-A3B

Tesla T4, UD-IQ3_XXS, 13.2 GB, 16k window, 16-bit cache. Talkative: on connect, plain Pi's own explanations filled the 16k window (up to 3.6k tokens in one reply). tinyCode passed connect and dot-dsl in every run; on paasio both pass every run, and plain Pi is four to six times faster.

| Task | What (tests) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| [connect](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/connect) | Hex game winner (10) | ✗ ✗ ✗ | ✓30 ✓76 ✓260 |
| [bowling](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/bowling) | bowling scorer (31) | ✗ ✗ ✗ | ✗ ✗ ✓327 |
| [dot-dsl](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/dot-dsl) | graph-building DSL (12) | ✓76 ✗ ✗ | ✓198 ✓36 ✓70 |
| [paasio](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/paasio) | I/O byte counters (25) | ✓46 ✓64 ✓48 | ✓204 ✓298 ✓377 |
| [sgf-parsing](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/sgf-parsing) | Go game-record parser (23) | ✗ ✗ ✗ | ✗ ✗ ✗ |
| **Total** | solved (median s) | **4 of 15** (56 s) | **10 of 15** (201 s) |

### 16 GB · Nemotron-Nano-9B-v2

Tesla T4, Q4_K_M, 6.5 GB, 16k window, 16-bit cache. An 8 GB-class model, run on the 16 GB card for speed; the test on an 8 GB card follows when our new card arrives. On the slower 8 GB card it ran out the clock: with plain Pi it often asked for the files instead of reading them (counted below), and with tinyCode most of its edits failed to match the file exactly.

| Task | What (tests) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| [connect](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/connect) | Hex game winner (10) | ✗ · · | · · · |
| [bowling](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/bowling) | bowling scorer (31) | · · · | · · · |
| [dot-dsl](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/dot-dsl) | graph-building DSL (12) | · · · | · · · |
| [paasio](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/paasio) | I/O byte counters (25) | · · · | · · · |
| [sgf-parsing](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/sgf-parsing) | Go game-record parser (23) | · · · | · · · |
| **Total** | solved (median s) | **0 of 1** (–) | **0 of 0** (–) |

Runs that stopped to ask a question instead of acting (they count as fails): Pi alone 1 of 1, Pi + tinyCode 0 of 0.

## Method

- **Question:** on a context window a local GPU can afford, does Pi still finish the task, and does tinyCode change that?
- **Setups:** two cards, each with a model that fits it and a **16,384-token window** for the server and both sides;
  llama.cpp `llama-server`, flash attention, thinking off, temperature 0.3 with a fixed seed per run.
- **Tasks:** five Python exercises from [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)
  (Exercism, MIT), chosen by one rule before these runs: the exercises where plain Pi's largest prompt went past 14k
  tokens when it had a 32k window.
- **Prompt (both sides, identical):** the exercise's instructions, then "Edit <solution file> so that the tests in <test
  file> pass. Don't change the test file." **Pass** = the test file passes afterwards, restored from the original first.
- **Pi alone:** Pi 1.4.0 with no extensions. **Pi + tinyCode:** the same Pi with tinyCode at its defaults.
- **Each run:** interactive Pi in its own terminal, a fresh state directory, a 10-minute cap. A run stopped by the cap
  is graded on its last state, so a tinyCode run that had reached a better state earlier still counts as a fail.
- **Measured the same way for both:** a logging proxy between Pi and the server records every call. *Peak context* = the
  largest prompt of a run. *Context full* = Pi had no room left for a reply: it asks for at most the window minus its own
  estimate of the prompt minus 4,096 tokens.
- **Repetitions:** three runs per task and side. llama-server is not fully deterministic even with a seed, so runs of
  the same cell can differ. Five tasks is a small set: read it as direction, not proof.

## Every run

### 16 GB, gpt-oss-20b (MXFP4, 12.1 GB, 16k window, 16-bit cache)

| Task | Side | Run | Result | Tests | Time | Calls | Peak context | Generated tokens |
|---|---|---|---|---|---|---|---|---|
| connect | Pi alone | 1 | fail | 4 failed, 6 passed | 32 s | 5 | 3.6k | 1471 |
| connect | Pi alone | 2 | fail | 4 failed, 6 passed | 28 s | 5 | 3.5k | 1170 |
| connect | Pi alone | 3 | pass | 10 passed | 26 s | 6 | 3.6k | 1088 |
| connect | Pi + tinyCode | 1 | pass | 10 passed | 72 s | 13 | 6.3k | 3078 |
| connect | Pi + tinyCode | 2 | pass | 10 passed | 30 s | 8 | 3.1k | 1184 |
| connect | Pi + tinyCode | 3 | pass | 10 passed | 28 s | 7 | 2.7k | 1110 |
| bowling | Pi alone | 1 | fail | 10 failed, 21 passed | 42 s | 6 | 7.4k | 1843 |
| bowling | Pi alone | 2 | fail | 31 failed | 12 s | 5 | 5.7k | 247 |
| bowling | Pi alone | 3 | fail | 31 failed | 12 s | 5 | 5.7k | 296 |
| bowling | Pi + tinyCode | 1 | fail | 26 failed, 5 passed | 80 s | 8 | 5.7k | 3280 |
| bowling | Pi + tinyCode | 2 | fail | 6 failed, 25 passed | 284 s | 18 | 8.3k | 12936 |
| bowling | Pi + tinyCode | 3 | fail | 4 failed, 27 passed | 110 s | 11 | 6.6k | 4765 |
| dot-dsl | Pi alone | 1 | pass | 12 passed | 64 s | 13 | 7.1k | 2860 |
| dot-dsl | Pi alone | 2 | pass | 12 passed | 52 s | 8 | 5.7k | 2433 |
| dot-dsl | Pi alone | 3 | fail | 1 failed, 11 passed | 20 s | 4 | 3.8k | 740 |
| dot-dsl | Pi + tinyCode | 1 | pass | 12 passed | 44 s | 9 | 5.7k | 1664 |
| dot-dsl | Pi + tinyCode | 2 | pass | 12 passed | 50 s | 11 | 5.6k | 1945 |
| dot-dsl | Pi + tinyCode | 3 | pass | 12 passed | 60 s | 11 | 5.8k | 2438 |
| paasio | Pi alone | 1 | context full | 25 failed | 116 s | 10 | 12.0k | 5315 |
| paasio | Pi alone | 2 | fail | 2 failed, 23 passed | 62 s | 8 | 9.0k | 2742 |
| paasio | Pi alone | 3 | fail | 2 failed, 23 passed | 62 s | 8 | 9.4k | 2717 |
| paasio | Pi + tinyCode | 1 | fail | 1 failed, 24 passed | 256 s | 33 | 9.3k | 10809 |
| paasio | Pi + tinyCode | 2 | pass | 25 passed | 152 s | 21 | 8.7k | 6484 |
| paasio | Pi + tinyCode | 3 | fail | 25 failed | 90 s | 14 | 6.4k | 4042 |
| sgf-parsing | Pi alone | 1 | fail | 4 failed, 19 passed | 44 s | 6 | 6.3k | 1944 |
| sgf-parsing | Pi alone | 2 | fail | 8 failed, 15 passed | 66 s | 6 | 6.9k | 3047 |
| sgf-parsing | Pi alone | 3 | fail | 16 failed, 7 passed | 32 s | 5 | 8.1k | 1200 |
| sgf-parsing | Pi + tinyCode | 1 | pass | 23 passed | 154 s | 26 | 10.0k | 6289 |
| sgf-parsing | Pi + tinyCode | 2 | fail | 1 failed, 22 passed | 292 s | 42 | 10.1k | 12794 |
| sgf-parsing | Pi + tinyCode | 3 | fail | 2 failed, 21 passed | 314 s | 46 | 8.8k | 13558 |

### 16 GB, Qwen3.6-35B-A3B (UD-IQ3_XXS, 13.2 GB, 16k window, 16-bit cache)

| Task | Side | Run | Result | Tests | Time | Calls | Peak context | Generated tokens |
|---|---|---|---|---|---|---|---|---|
| connect | Pi alone | 1 | context full | 2 failed, 8 passed | 170 s | 8 | 12.4k | 8008 |
| connect | Pi alone | 2 | context full | 3 failed, 7 passed | 154 s | 12 | 12.2k | 7023 |
| connect | Pi alone | 3 | context full | 1 failed, 9 passed | 160 s | 13 | 12.5k | 7327 |
| connect | Pi + tinyCode | 1 | pass | 10 passed | 30 s | 3 | 2.7k | 758 |
| connect | Pi + tinyCode | 2 | pass | 10 passed | 76 s | 7 | 5.1k | 3067 |
| connect | Pi + tinyCode | 3 | pass | 10 passed | 260 s | 18 | 9.1k | 11510 |
| bowling | Pi alone | 1 | context full | 14 failed, 17 passed | 70 s | 6 | 11.2k | 2901 |
| bowling | Pi alone | 2 | context full | 8 failed, 23 passed | 68 s | 5 | 13.3k | 2687 |
| bowling | Pi alone | 3 | context full | 28 failed, 3 passed | 54 s | 5 | 9.8k | 2030 |
| bowling | Pi + tinyCode | 1 | time cap | 28 failed, 3 passed | 10.0 min | 50 | 9.7k | 23587 |
| bowling | Pi + tinyCode | 2 | time cap | 15 failed, 16 passed | 10.0 min | 58 | 9.9k | 22791 |
| bowling | Pi + tinyCode | 3 | pass | 31 passed | 327 s | 19 | 10.3k | 13795 |
| dot-dsl | Pi alone | 1 | pass | 12 passed | 76 s | 11 | 10.4k | 3092 |
| dot-dsl | Pi alone | 2 | context full | 1 failed, 11 passed | 74 s | 11 | 12.7k | 2847 |
| dot-dsl | Pi alone | 3 | context full | 1 failed, 11 passed | 82 s | 9 | 12.3k | 3346 |
| dot-dsl | Pi + tinyCode | 1 | pass | 12 passed | 198 s | 24 | 8.8k | 7698 |
| dot-dsl | Pi + tinyCode | 2 | pass | 12 passed | 36 s | 5 | 5.3k | 1118 |
| dot-dsl | Pi + tinyCode | 3 | pass | 12 passed | 70 s | 12 | 6.2k | 2329 |
| paasio | Pi alone | 1 | pass | 25 passed | 46 s | 7 | 11.7k | 1522 |
| paasio | Pi alone | 2 | pass | 25 passed | 64 s | 8 | 12.3k | 2409 |
| paasio | Pi alone | 3 | pass | 25 passed | 48 s | 6 | 10.7k | 1677 |
| paasio | Pi + tinyCode | 1 | pass | 25 passed | 204 s | 38 | 10.1k | 6697 |
| paasio | Pi + tinyCode | 2 | pass | 25 passed | 298 s | 62 | 9.8k | 9605 |
| paasio | Pi + tinyCode | 3 | pass | 25 passed | 377 s | 63 | 10.2k | 12772 |
| sgf-parsing | Pi alone | 1 | context full | 17 failed, 6 passed | 36 s | 3 | 6.1k | 1435 |
| sgf-parsing | Pi alone | 2 | context full | 5 failed, 18 passed | 78 s | 7 | 12.8k | 3183 |
| sgf-parsing | Pi alone | 3 | context full | 19 failed, 4 passed | 46 s | 4 | 15.2k | 1500 |
| sgf-parsing | Pi + tinyCode | 1 | time cap | 5 failed, 18 passed | 10.0 min | 74 | 10.3k | 22854 |
| sgf-parsing | Pi + tinyCode | 2 | time cap | tests timed out (180 s) | 10.0 min | 20 | 9.7k | 10906 |
| sgf-parsing | Pi + tinyCode | 3 | time cap | tests timed out (180 s) | 10.0 min | 60 | 10.2k | 20568 |

### 16 GB, Nemotron-Nano-9B-v2 (Q4_K_M, 6.5 GB, 16k window, 16-bit cache)

| Task | Side | Run | Result | Tests | Time | Calls | Peak context | Generated tokens |
|---|---|---|---|---|---|---|---|---|
| connect | Pi alone | 1 | fail | 10 failed | 6 s | 1 | 1.8k | 56 |
