/**
 * What's Happening in Orbit: the wiring. Holds the narration state and feeds
 * it from pi's events (through `adapters/pi.ts`) and from Orbit's own: notify
 * messages, approval and plan waits, and Galaxy job states read from
 * `activity.jsonl` and the notebook's workflow-run blocks.
 *
 * It draws nothing. Views (the inline line under chat messages, later the
 * Activity tab) subscribe to it and redraw on each change.
 */

import { fromPiEvent, messageText, PI_ADAPTER_START } from "./whats-happening/adapters/pi.js";
import { advance, EMPTY_STATE } from "./whats-happening/core/narrator.js";
import type { GalaxyRunRef, NarrationEvent, NarrationState } from "./whats-happening/core/types.js";
import type { ReplaySegment } from "../preload/preload.js";

/** What the wiring needs from Orbit. */
export interface OrbitNarrationHost {
  /** Reads a file in the analysis folder; `tail` reads only its end. */
  readFile: (
    path: string,
    opts?: { tail?: boolean },
  ) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
  /** A model error in the chat's own words. */
  describeModelError: (message: string) => string;
  /** The current time; Date.now() unless a test sets it. */
  now?: () => number;
  /** How often to read Galaxy job states, in milliseconds; 0 turns it off. 15 seconds by default. */
  syncEveryMs?: number;
}

export interface OrbitNarration {
  /** The narration as it stands. */
  readonly state: NarrationState;
  /** Calls `listener` after every change; returns a function that stops it. */
  subscribe: (listener: (state: NarrationState) => void) => () => void;
  /** Every pi event, as app.ts's onAgentEvent receives it. */
  onAgentEvent: (event: Record<string, unknown>) => void;
  /** Orbit's notify messages, as app.ts's onUiRequest receives them. */
  onNotify: (message: string | undefined) => void;
  /** A message the user sent from the chat input (slash commands included). */
  onUserText: (text: string) => void;
  /** Reads Galaxy job states from Orbit's files and feeds any that changed. */
  syncJobs: () => Promise<void>;
  /**
   * Rebuilds the narration from a resumed session's replay, the same one the
   * chat redraws its old messages from (`agent:session-history`). Does nothing
   * once the narration has work in it.
   *
   * Desktop only for now: the browser shell has no session replay
   * (`replayChat` in web/orbit-shim.ts), so after a reload there the narration
   * starts empty, like the chat. If the browser ever replays a session through
   * `agent:session-history`, this comes along with no change.
   *
   * Forgiving by design, since What's Happening is mostly about what is
   * happening now: the session file keeps messages and tool calls, not
   * everything seen live. Timings are approximate, model errors are left out,
   * and Orbit's approval and plan waits aren't replayed, since nothing records
   * whether they were answered.
   *
   * Resolves once Galaxy job states have been read for the rebuilt work.
   */
  restore: (history: readonly ReplaySegment[]) => Promise<void>;
  /** Forgets everything, for a fresh session (/new, another analysis folder). */
  reset: () => void;
  /** Stops the periodic job reads and drops every listener. */
  dispose: () => void;
}

/**
 * Orbit's own messages ("[Orbit automatic Galaxy follow-up]", "[Orbit check] …",
 * and upstream's one leftover "[Loom check]") aren't the user's. The run Orbit
 * starts after an /approve ("[Orbit approval] The user approved prop-…")
 * answers that proposal, so it belongs with the work that proposed it.
 */
function harnessMessage(text: string): { about: GalaxyRunRef[]; answerId?: string } | undefined {
  if (!/^\[(?:Orbit|Loom) /.test(text)) return undefined;
  const approved = /^\[Orbit approval\] The user approved (prop-[\w-]+)/.exec(text)?.[1];
  return { about: followUpRuns(text), ...(approved ? { answerId: approved } : {}) };
}

/** Waits a plain chat message answers; a proposal waits for Orbit's "Approved prop-…". */
const ANSWERED_BY_A_MESSAGE = ["plan", "follow-up-paused"];

export function createOrbitNarration(host: OrbitNarrationHost): OrbitNarration {
  const now = host.now ?? Date.now;
  let state: NarrationState = EMPTY_STATE;
  let pi = PI_ADAPTER_START;
  const listeners = new Set<(state: NarrationState) => void>();

  function apply(event: NarrationEvent): void {
    const next = advance(state, event);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(state);
  }

  // Galaxy job states, each activity.jsonl row fed once.
  const seenJobRows = new Set<string>();
  const sentProgress = new Map<string, string>();
  const finalProgress = new Set<string>();
  let syncing = false;

  /** `whole` reads all of activity.jsonl rather than its end, for jobs that finished long ago. */
  async function syncJobs(whole = false): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
      await syncInvocationProgress();
      if (!state.galaxyRunning.some((w) => w.galaxyId)) return;
      const res = await host.readFile("activity.jsonl", whole ? undefined : { tail: true });
      if (!res.ok) return;
      for (const line of new TextDecoder("utf-8").decode(res.bytes).split("\n")) {
        const event = jobStateFromActivity(line, seenJobRows, now());
        if (event) apply(event);
      }
    } catch {
      // No activity log yet.
    } finally {
      syncing = false;
    }
  }

  /** Orbit's poller rewrites each workflow run's block in the notebook with step and job counts. */
  async function syncInvocationProgress(): Promise<void> {
    // Every workflow run started here whose final counts haven't been sent yet.
    const tracked = new Set(
      state.groups.flatMap((g) =>
        g.entries.flatMap((e) =>
          (e.startedRuns ?? []).flatMap((r) =>
            r.kind === "invocation" && !finalProgress.has(r.id) ? [r.id] : [],
          ),
        ),
      ),
    );
    if (tracked.size === 0) return;
    const res = await host.readFile("notebook.md");
    if (!res.ok) return;
    for (const event of invocationProgress(new TextDecoder("utf-8").decode(res.bytes), now())) {
      if (!tracked.has(event.id)) continue;
      const { kind: _kind, at: _at, ...counted } = event;
      const key = JSON.stringify(counted);
      if (sentProgress.get(event.id) === key) continue;
      sentProgress.set(event.id, key);
      if (event.state !== "scheduled") finalProgress.add(event.id);
      apply(event);
    }
  }

  function onAgentEvent(event: Record<string, unknown>): void {
    const type = event.type as string | undefined;
    const at = now();
    const step = fromPiEvent(pi, event, at, {
      harnessMessage,
      describeModelError: host.describeModelError,
    });
    pi = step.state;
    for (const narration of step.events) apply(narration);

    const groupId = pi.groupId;
    const message = event.message as { role?: string } | undefined;
    const recorded = type === "tool_execution_start" ? recordedRun(event) : undefined;
    if (recorded) apply({ kind: "run-labeled", at, ...recorded });
    if (type === "tool_execution_end" && String(event.toolName).endsWith("loom_propose")) {
      // Orbit's approval gate: a proposal leaves the user to type /approve. Its
      // "Not proposed -- fix these" reply isn't flagged as an error, so only a
      // "Proposed prop-…" result counts.
      const text = messageText(event.result);
      const id = /Proposed (prop-[\w-]+)/.exec(text)?.[1];
      const label = /\|\s*Label\s*\|\s*([^|\n]+?)\s*\|/.exec(text)?.[1];
      if (id) {
        apply({
          kind: "awaiting-user",
          groupId,
          at,
          id,
          text: `approve ${label ? `"${label}" ` : ""}(type /approve ${id})`,
        });
      }
    } else if (type === "message_end" && message?.role === "assistant") {
      // A ```plan fence becomes a "Plan draft — awaiting your approval" card in the chat.
      const title = planTitle(messageText(message));
      if (title !== undefined) {
        apply({
          kind: "awaiting-user",
          groupId,
          at,
          id: "plan",
          text: `approve the plan${title ? ` "${title}"` : ""} (Approve, Edit or Reject in the chat)`,
        });
      }
    } else if (type === "agent_end" && event.willRetry !== true) {
      void syncJobs();
    }
  }

  function onNotify(message: string | undefined): void {
    if (!message) return;
    void syncJobs();
    const at = now();
    const finished = /Galaxy: "(.+?)" finished/.exec(message);
    if (finished) apply({ kind: "galaxy-finished", at, label: finished[1] });
    // /approve can fail, so a proposal is answered only once Orbit says it was approved.
    const approved = /^Approved (prop-[\w-]+)/.exec(message)?.[1];
    if (approved) apply({ kind: "user-replied", at, id: approved });
    // The poller stops following up on its own after a few turns and waits for the user.
    if (/automatic follow-up (is )?paused/.test(message)) {
      apply({
        kind: "awaiting-user",
        groupId: pi.groupId,
        at,
        id: "follow-up-paused",
        text: 'say "continue" so Orbit checks the Galaxy results that came in',
      });
    }
  }

  function onUserText(text: string): void {
    // Slash commands answer nothing here; /approve is answered by Orbit's reply.
    if (text.trim().startsWith("/")) return;
    for (const id of ANSWERED_BY_A_MESSAGE) apply({ kind: "user-replied", at: now(), id });
  }

  async function restore(history: readonly ReplaySegment[]): Promise<void> {
    if (state.groups.length > 0) return;
    const options = { harnessMessage, describeModelError: host.describeModelError };
    const feed = (event: Record<string, unknown>, at: number): void => {
      const step = fromPiEvent(pi, event, at, options);
      pi = step.state;
      for (const narration of step.events) apply(narration);
    };
    // One run per user message, ending at the last thing it did.
    let open = false;
    let last = 0;
    for (const segment of history) {
      const at = segment.timestamp ?? last;
      if (segment.role === "user") {
        if (open) feed({ type: "agent_end" }, last);
        feed({ type: "agent_start" }, at);
        open = true;
        feed(
          {
            type: "message_start",
            message: {
              role: "user",
              content: [{ type: "text", text: segment.text }],
              timestamp: segment.timestamp,
            },
          },
          at,
        );
        last = at;
        continue;
      }
      if (!open) continue;
      for (const tool of segment.tools ?? []) {
        const started = tool.startedAt ?? at;
        const ended = tool.endedAt ?? started;
        const common = { toolCallId: tool.id, toolName: tool.name };
        feed({ type: "tool_execution_start", ...common, args: tool.arguments }, started);
        feed(
          {
            type: "tool_execution_end",
            ...common,
            isError: tool.isError === true,
            result: { content: [{ type: "text", text: tool.resultText ?? "" }] },
          },
          ended,
        );
        last = Math.max(last, ended);
      }
      last = Math.max(last, at);
    }
    if (open) feed({ type: "agent_end" }, last);
    await syncJobs(true);
  }

  function reset(): void {
    state = EMPTY_STATE;
    pi = PI_ADAPTER_START;
    seenJobRows.clear();
    sentProgress.clear();
    finalProgress.clear();
    for (const listener of listeners) listener(state);
  }

  const syncEveryMs = host.syncEveryMs ?? 15_000;
  const timer = syncEveryMs > 0 ? setInterval(() => void syncJobs(), syncEveryMs) : undefined;

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAgentEvent,
    onNotify,
    onUserText,
    syncJobs: () => syncJobs(),
    restore,
    reset,
    dispose() {
      clearInterval(timer);
      listeners.clear();
    },
  };
}

/**
 * The run Orbit is recording in its notebook, and the label it gives it:
 * `galaxy_invocation_record({ invocationId, label })` for a workflow run,
 * `galaxy_job_record({ jobId, label })` for a tool run.
 */
export function recordedRun(
  event: Record<string, unknown>,
): { id: string; label: string } | undefined {
  const tool = String(event.toolName);
  const args = event.args as
    { invocationId?: unknown; jobId?: unknown; label?: unknown } | undefined;
  const id = tool.endsWith("galaxy_invocation_record")
    ? args?.invocationId
    : tool.endsWith("galaxy_job_record")
      ? args?.jobId
      : undefined;
  const label = typeof args?.label === "string" ? args.label.trim() : "";
  return typeof id === "string" && id && label ? { id, label } : undefined;
}

/** The runs Orbit's follow-up is about, from the JSON list in its text ({kind, id, …} per run). */
export function followUpRuns(text: string): GalaxyRunRef[] {
  const start = text.indexOf("\n[");
  const end = text.indexOf("\n]", start);
  if (start === -1 || end === -1) return [];
  try {
    const runs: unknown = JSON.parse(text.slice(start + 1, end + 2));
    if (!Array.isArray(runs)) return [];
    return runs.flatMap((r) =>
      (r?.kind === "job" || r?.kind === "invocation") && typeof r.id === "string"
        ? [{ kind: r.kind, id: r.id }]
        : [],
    );
  } catch {
    return [];
  }
}

/** A plan draft's title: its first line, without heading marks or a trailing [tag]; undefined without a plan. */
export function planTitle(reply: string): string | undefined {
  // Like the chat's plan card: a closed block, or one left open to the end of the reply.
  const plan =
    /```plan\b[^\n]*\n([\s\S]*?)```/.exec(reply)?.[1] ??
    /```plan\b[^\n]*\n([\s\S]*)$/.exec(reply)?.[1];
  if (plan === undefined) return undefined;
  return (
    plan
      .split("\n")
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, "")
      .replace(/\s*\[[^\]]*\]\s*$/, "")
      .trim() ?? ""
  );
}

/**
 * One activity.jsonl row as a job state, or undefined when it isn't one or was
 * already seen: `poll.transition` carries a job's or workflow run's new state,
 * `poll.block_missing` means Orbit stopped tracking it.
 */
export function jobStateFromActivity(
  line: string,
  seen: Set<string>,
  fallbackAt: number,
): NarrationEvent | undefined {
  if (!line.includes("poll.transition") && !line.includes("poll.block_missing")) return undefined;
  let row: { timestamp?: string; kind?: string; payload?: Record<string, unknown> };
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  const id = row.payload?.id;
  if (typeof id !== "string") return undefined;
  const key = `${row.timestamp}|${row.kind}|${id}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const at = Date.parse(row.timestamp ?? "") || fallbackAt;
  if (row.kind === "poll.block_missing") return { kind: "job-state", at, id, state: "untracked" };
  const galaxyState = row.payload?.galaxyState;
  const to = row.payload?.to;
  const isInvocation = row.payload?.blockKind === "invocation";
  let state: string;
  if (isInvocation && (to === "completed" || to === "failed")) {
    state = to;
  } else if (typeof galaxyState === "string") {
    state = galaxyState;
  } else if (to === "completed") {
    state = "ok";
  } else if (to === "failed") {
    state = "error";
  } else {
    state = String(to ?? "running");
  }
  return { kind: "job-state", at, id, state };
}

/** Each workflow run's state and counts, from the notebook's `orbit-invocation` blocks. */
export function invocationProgress(
  notebook: string,
  fallbackAt: number,
): Extract<NarrationEvent, { kind: "job-state" }>[] {
  const events: Extract<NarrationEvent, { kind: "job-state" }>[] = [];
  for (const block of notebook.matchAll(/```(?:orbit|loom)-invocation\n([\s\S]*?)```/g)) {
    const fields = new Map(
      block[1].split("\n").flatMap((line) => {
        const m = /^(\w+):\s*(.*)$/.exec(line);
        return m ? [[m[1], m[2].trim()] as const] : [];
      }),
    );
    const id = fields.get("invocation_id");
    if (!id || !fields.has("total_steps")) continue;
    const count = (name: string): number => Number(fields.get(name) ?? 0) || 0;
    const at = Date.parse(fields.get("last_polled_at") ?? "") || fallbackAt;
    const status = fields.get("status");
    const state =
      status === "completed" || status === "failed" || status === "cancelled"
        ? status
        : "scheduled";
    events.push({
      kind: "job-state",
      at,
      id,
      state,
      progress: {
        totalSteps: count("total_steps"),
        completedSteps: count("completed_steps"),
        totalJobs: count("total_jobs"),
        completedJobs: count("completed_jobs"),
        failedJobs: count("failed_jobs"),
        at,
      },
    });
  }
  return events;
}
