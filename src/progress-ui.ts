// The glue between src/progress.ts and Pi: where status, checklist and summary go.
//
// TUI (ctx.hasUI): ctx.ui.setStatus("tinycode", line) for the live status line (footer), ctx.ui.setWidget("tinycode", lines)
// for the checklist above the editor (ExtensionUIContext, vendor/pi coding-agent core/extensions/types.ts), and
// pi.sendMessage({customType, content, display: true}) for the end summary, a message in the chat transcript.
// No UI (-p, json): progress lines go to stderr, the summary to stdout.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { stuckConfirmFor } from "./mode.ts";
import { createProgress, CUSTOM_BEAT, type Progress, type ProgressSink, type Summary } from "./progress.ts";

/** The progress that currently owns the screen (a workflow, or the plain-chat one); the Pi loop feeds its todo into it. */
export const live: { current: Progress | null } = { current: null };

export function uiSink(pi: ExtensionAPI, ctx: ExtensionContext): ProgressSink {
  const ui = ctx.hasUI;
  // Redraw only on change: the 1 s tick re-sends both, and an unchanged widget redrawn every second flickers.
  let lastStatus: string | undefined;
  let lastWidget: string | undefined;
  return {
    interactive: ui,
    status: (t) => {
      if (!ui || t === lastStatus) return;
      lastStatus = t;
      ctx.ui.setStatus("tinycode", t);
    },
    widget: (l) => {
      const key = l === undefined ? "" : JSON.stringify(l);
      if (!ui || key === lastWidget) return;
      lastWidget = key;
      ctx.ui.setWidget("tinycode", l);
    },
    message: (text, kind) => {
      if (ui) pi.sendMessage({ customType: kind === "beat" ? CUSTOM_BEAT : "tinycode", content: text, display: true });
      else process.stdout.write(text + "\n");
    },
    err: (line) => {
      process.stderr.write(line + "\n");
    },
    width: () => (ui ? process.stdout.columns || 0 : 0),
    confirmStuck: stuckConfirmFor(ctx),
    onStop: () => {
      try {
        ctx.abort();
      } catch {
        // nothing is running in Pi's loop; a workflow's next call fails on its own
      }
    },
  };
}

/** Start a progress for a workflow, and make it the live one. */
export function startProgress(pi: ExtensionAPI, ctx: ExtensionContext, cfg: Config, workflow: string, phases: string[], quiet = false): Progress {
  // quiet (S19, a workflow run as the model's tool): status line, checklist and heartbeat show as usual, but the end
  // summary is not posted as a chat message or to stdout: the tool returns it to the model, which reports it in words.
  const sink = uiSink(pi, ctx);
  const p = createProgress({ workflow, phases, sink: quiet ? { ...sink, message: () => {} } : sink, stuckCalls: cfg.progress.stuckCalls, heartbeatSeconds: cfg.progress.heartbeatSeconds, timer: ctx.hasUI || cfg.progress.heartbeatSeconds > 0 });
  prev.set(p, live.current);
  live.current = p;
  return p;
}

// What was live before each workflow (the chat progress, when the workflow runs as the model's tool): restored at the end.
const prev = new Map<Progress, Progress | null>();

export function endProgress(p: Progress): void {
  if (live.current === p) live.current = prev.get(p) ?? null;
  prev.delete(p);
}

export type { Summary };
