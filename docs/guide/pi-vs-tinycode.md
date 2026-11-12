# See the difference

The same task, run once with plain Pi and once with tinyCode. It is `connect`, a public exercise from the
[Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark), and the clearest case in our results.

## What we saw

Qwen3.6-35B-A3B, a 16k window, one 16 GB card, one recorded run:

| | Plain Pi | Pi + tinyCode |
|---|---|---|
| Result | ran out of context, 8 of 10 tests | **all 10 tests pass** |
| Time | 170 s | **30 s** |
| Model calls | 8 | **3** |

- **Plain Pi** wrote a solution, saw 2 tests fail, explored the problem with several scripts, and rewrote the file.
  By then the conversation had filled the window.
- **tinyCode** recognised "make the tests pass", made one targeted edit, and all 10 tests passed.

When a task fits easily, plain Pi is often faster: tinyCode's extra steps cost time.

## Try it yourself

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

Your numbers will differ from run to run. The README's Results section has the full tables.
