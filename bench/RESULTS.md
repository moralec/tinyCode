# tinyCode at a 16k context window: Pi alone vs Pi + tinyCode

| Task | Pi alone | Pi + tinyCode |
|---|---|---|
| connect | ✗ context full (4 failed, 6 passed) | ✗ time cap (1 failed, 9 passed) · ✓ 38 s |
| bowling | ✗ context full (6 failed, 25 passed) | ✓ 557 s |
| dot-dsl | ✓ 38 s | ✓ 236 s |
| paasio | ✗ reply cut (window full) (1 failed, 24 passed) | ✓ 347 s |
| sgf-parsing | ✗ context full (17 failed, 6 passed) | ✓ 539 s |
| **solved** | **1 of 5 runs** | **5 of 6 runs** |

At a 32k window, the same five tasks: Pi alone passed 8 of 8 runs, Pi + tinyCode 5 of 6 (earlier tinyCode settings).

## Method

- **Question:** at a context window a local GPU can afford, does Pi still finish the task, and does tinyCode change that?
- **Model and server:** Qwen3.6-35B-A3B (UD-IQ3_XXS) on one 16 GB NVIDIA T4, llama.cpp `llama-server`, **16,384-token
  window** for the server and both sides, f16 KV cache, thinking off, temperature 0.3 with a fixed seed per run.
- **Tasks:** five Python exercises from [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)
  (Exercism, MIT). Chosen by one rule, before these runs: the exercises where Pi alone's largest prompt went past 14k
  tokens when it had a 32k window (connect, bowling, dot-dsl, paasio from our 9-task set; sgf-parsing from the next six
  by reference-solution size).
- **Prompt (both sides, identical):** the exercise's instructions, then "Edit <solution file> so that the tests in <test
  file> pass. Don't change the test file." **Pass** = the test file passes afterwards, restored from the original first.
- **Pi alone:** Pi 1.4.0 with no extensions. **Pi + tinyCode:** the same Pi with tinyCode v1.0 defaults.
- **Each run:** interactive Pi in its own terminal, a fresh state directory, a time cap of 10 minutes (Pi alone's first
  runs used 8 minutes; none of them came within 2 minutes of it).
- **Measured the same way for both:** a logging proxy between Pi and the server records every call. *Peak context* = the
  largest prompt of a run. *Generated tokens* = all tokens the model wrote. *Context full* = Pi had no room left for a
  reply: it asks for at most the window minus its own estimate of the prompt minus 4,096 tokens, so a run can end
  "full" while the measured prompt is smaller (sgf-parsing, Pi alone).
- **Repetitions:** see the Run column; more are being added. Five tasks is a small set: read it as direction, not proof.

## Every run

| Task | Side | Run | Result | Tests | Time | Calls | Peak context | Generated tokens |
|---|---|---|---|---|---|---|---|---|
| connect | Pi alone | 1 | context full | 4 failed, 6 passed | 144 s | 13 | 13.2k | 6544 |
| connect | Pi + tinyCode | 1 | time cap | 1 failed, 9 passed | 10.0 min | 71 | 10.1k | 23252 |
| connect | Pi + tinyCode | 2 | pass | 10 passed | 38 s | 3 | 2.7k | 1372 |
| bowling | Pi alone | 1 | context full | 6 failed, 25 passed | 48 s | 5 | 14.0k | 1685 |
| bowling | Pi + tinyCode | 1 | pass | 31 passed | 557 s | 59 | 10.0k | 21378 |
| dot-dsl | Pi alone | 1 | pass | 12 passed | 38 s | 7 | 6.3k | 1422 |
| dot-dsl | Pi + tinyCode | 1 | pass | 12 passed | 236 s | 37 | 9.1k | 8583 |
| paasio | Pi alone | 1 | reply cut (window full) | 1 failed, 24 passed | 50 s | 6 | 11.8k | 1733 |
| paasio | Pi + tinyCode | 1 | pass | 25 passed | 347 s | 88 | 10.3k | 9556 |
| sgf-parsing | Pi alone | 1 | context full | 17 failed, 6 passed | 36 s | 3 | 6.1k | 1435 |
| sgf-parsing | Pi + tinyCode | 1 | pass | 23 passed | 539 s | 60 | 10.7k | 20649 |
