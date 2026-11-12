# Models

This page covers which model to run on your hardware, where to get it, and how to start it so tinyCode can use it.

## Which model for which card

| Your hardware | Model | Why |
|---|---|---|
| 16 GB GPU, working with Pi yourself | **gpt-oss-20b** | About four times faster (a median of 55 s per solved task), which matters when you are waiting. |
| 16 GB GPU, jobs handed over by another agent | **Qwen3.6-35B-A3B** | Solves the most (10 of 15 with tinyCode), slower but steadier. Nobody waits on a delegated job. |
| 24 GB or more of unified memory (Apple Silicon, AMD Strix Halo) | either of the two above | The model and a 16k window fit. This setup is untested by us. |
| 8 GB GPU | not there yet | The models that fit (Nemotron-Nano-9B-v2, gemma-4-12B, Qwen3.5-4B) were not helped by tinyCode in our runs. |

**Why 16 GB?** The model needs about 12–13 GB, and the 16k context window needs room on top. On an 8 GB card the
window shrinks to about 8k, and Pi keeps 4k of that for the reply, which leaves too little for the task.

## The files we tested

| Model | File | Size |
|---|---|---|
| gpt-oss-20b | MXFP4 GGUF of [openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b) (set reasoning effort to low) | about 12 GB |
| Qwen3.6-35B-A3B | `UD-IQ3_XXS` from [unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) | about 13 GB |

## Start the model

Use the alias `tinycode-model` and a 16k window:

```
llama-server -m <model file> -a tinycode-model -ngl 99 -c 16384 -np 1 -fa on --jinja --reasoning-budget 0 --port 8080
```

If you choose a different window, tell tinyCode, so it sizes its steps to it:

```
sh install.sh --trunk-context <tokens> --small-context <tokens>
```

A larger window works too; tinyCode then rarely needs to step in.

**Next:** [Getting started](getting-started.md), or back to [Start here](../START-HERE.md).
