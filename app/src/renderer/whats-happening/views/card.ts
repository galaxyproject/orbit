/**
 * The message card, shared by every view: a header, then the changes made for
 * the message as rows (what each made, as links into Galaxy; its reads and
 * checks folded underneath; a failure's reason; a workflow run's progress),
 * then the harness's own follow-ups, folded. A finished card folds to one
 * summary line; what the user opens or closes stays that way.
 */

import { css, html, nothing, type TemplateResult } from "lit";

import { anchorUserMessage } from "../core/narrator.js";
import { rowsOf } from "../core/rows.js";
import type {
  GalaxyRef,
  GalaxyRun,
  InvocationStep,
  NarrationEntry,
  NarrationGroup,
  NarrationRow,
  NarrationState,
} from "../core/types.js";
import { cardState, cardTitle, elapsed, nowText, shorten, type DrawContext } from "./parts.js";

/** The kinds of Galaxy object worth linking to from a row, in the order they show. */
const LINKED_KINDS: readonly GalaxyRef["kind"][] = [
  "dataset",
  "collection",
  "history",
  "invocation",
  "workflow",
];

/**
 * The group whose card a follow-up shows in: the one holding the user message
 * the follow-up is anchored to. Undefined for every other group.
 */
export function hostOf(state: NarrationState, group: NarrationGroup): NarrationGroup | undefined {
  if (!group.followUp) return undefined;
  const message = anchorUserMessage(state, group);
  return message
    ? state.groups.find((g) => g !== group && g.messages.includes(message))
    : undefined;
}

/** Cards for these groups, newest first; follow-ups go inside the card they belong to. */
export function cards(groups: readonly NarrationGroup[], ctx: DrawContext): TemplateResult[] {
  const hosted = new Set(groups.filter((g) => hostOf(ctx.state, g)));
  return groups
    .filter((g) => !hosted.has(g))
    .reverse()
    .map((group) =>
      card(
        group,
        ctx,
        groups.filter((f) => hostOf(ctx.state, f) === group),
      ),
    );
}

/** One message's card, with its follow-ups. */
export function card(
  group: NarrationGroup,
  ctx: DrawContext,
  followUps: readonly NarrationGroup[] = [],
): TemplateResult {
  const header = html`<header>
    <span>${cardTitle(group, ctx)}</span>
    <span class="state">${cardState(group, ctx)}</span>
  </header>`;
  const body = cardBody(group, ctx, followUps);
  if (!isFinished(group) || followUps.some((f) => !isFinished(f))) {
    return html`<section class="card">${header}${body}</section>`;
  }
  // Finished: one summary line, opening to the rows.
  const summary = summaryLine(group, followUps, ctx);
  const hasRows =
    rowsOf(group).rows.length > 0 || rowsOf(group).checks.length > 0 || followUps.length > 0;
  return html`<section class="card">
    ${header}${group.status === "stopped" ? stoppedLine(group, ctx) : nothing}
    ${
      // Nothing done in Galaxy: the header alone.
      hasRows ? fold(`card:${group.id}`, false, html`${summary}`, body, ctx, "summary") : nothing
    }
  </section>`;
}

/** Done or stopped, with no Galaxy work of its own still running. */
export function isFinished(group: NarrationGroup): boolean {
  return (
    (group.status === "done" || group.status === "stopped") &&
    !group.entries.some((e) => e.status === "running")
  );
}

/**
 * "3 changes to your Galaxy · 1 failed", or what the card looked at; empty when
 * it did nothing in Galaxy, since the harness's own reply already says so.
 */
export function summaryLine(
  group: NarrationGroup,
  followUps: readonly NarrationGroup[],
  ctx: DrawContext,
): string {
  const { rows, checks } = rowsOf(group);
  const failed = rows.filter((r) => r.change.status === "failed").length;
  const parts: string[] = [];
  if (rows.length > 0) {
    parts.push(`${rows.length} change${rows.length === 1 ? "" : "s"} to your Galaxy`);
    if (failed > 0) parts.push(`${failed} failed`);
  } else if (checks.length > 0) {
    parts.push(
      `Looked at your Galaxy (${checks.length} check${checks.length === 1 ? "" : "s"}), changed nothing`,
    );
  }
  if (followUps.length > 0) parts.push(followedUpLabel(followUps.length, ctx));
  return parts.join(" · ");
}

/** Everything inside a card: its live line, waits, error, rows, checks and follow-ups. */
function cardBody(
  group: NarrationGroup,
  ctx: DrawContext,
  followUps: readonly NarrationGroup[],
): TemplateResult {
  const { rows, checks } = rowsOf(group);
  return html`
    ${
      group.status === "active" && group.now
        ? html`<div class="now">
            ● ${nowText(group.now, ctx)} (${elapsed(ctx.now - group.now.since)})
          </div>`
        : nothing
    }
    ${(group.waitingFor ?? []).map((w) => html`<div class="wait">⏸ To continue, ${w.text}</div>`)}
    ${group.status === "stopped" && isFinished(group) ? nothing : stoppedLine(group, ctx)}
    ${rows.map((row) => changeRow(row, ctx))}
    ${
      rows.length === 0 && checks.length > 0
        ? html`<div class="note">
            Looked at your Galaxy (${checks.length} check${checks.length === 1 ? "" : "s"}), changed
            nothing
          </div>`
        : nothing
    }
    ${checks.length > 0 ? checksFold(`checks:${group.id}`, checks, ctx) : nothing}
    ${followUps.length > 0 ? followUpsFold(group, followUps, ctx) : nothing}
  `;
}

/** Why a group stopped: one line, with the whole error on demand. */
function stoppedLine(group: NarrationGroup, ctx: DrawContext): TemplateResult | typeof nothing {
  if (group.status !== "stopped") return nothing;
  return reason("Stopped", group.error, group.error, `error:${group.id}`, ctx);
}

/** One change: its outcome, what it made, why it failed, its earlier tries, its run, its checks. */
function changeRow(row: NarrationRow, ctx: DrawContext): TemplateResult {
  const entry = row.change;
  const outputs = LINKED_KINDS.flatMap((kind) =>
    entry.galaxyRefs.filter((r) => r.role === "output" && r.kind === kind),
  );
  const lost = entry.startedRuns?.find((r) => r.untracked);
  return html`<div class="row">
    <div class="title">${ICON[entry.status]} ${titleOf(entry)}</div>
    ${
      outputs.length > 0
        ? html`<div class="outputs">→ ${outputs.map((ref) => link(ref, ctx))}</div>`
        : entry.status === "done" && entry.detail
          ? html`<div class="detail">${entry.detail}</div>`
          : nothing
    }
    ${
      entry.status === "failed"
        ? reason("", entry.detail, entry.failureMessage, `error:${entry.id}`, ctx)
        : nothing
    }
    ${
      entry.status === "untracked" && lost
        ? html`<div class="detail">No longer followed (last seen ${lost.state})</div>`
        : nothing
    }
    ${row.attempts.map(
      (attempt) =>
        html`<div class="attempt">
          ✗ An earlier try failed${attempt.detail ? `: ${shorten(attempt.detail, 160)}` : ""}
        </div>`,
    )}
    ${(entry.startedRuns ?? []).map((run) => workflowRun(run, entry.id, ctx))}
    ${row.children.length > 0 ? checksFold(`checks:${entry.id}`, row.children, ctx) : nothing}
  </div>`;
}

const ICON: Record<NarrationEntry["status"], string> = {
  running: "⏳",
  done: "✅",
  failed: "❌",
  untracked: "⚠️",
};

/** How a change is told, by how it went. */
function titleOf(entry: NarrationEntry): string {
  if (entry.status === "done") return entry.doneTitle ?? entry.title;
  if (entry.status === "failed") return entry.failedTitle ?? entry.title;
  return entry.title;
}

/** A link into Galaxy for a ref, or its label alone when the host can't link to it. */
function link(ref: GalaxyRef, ctx: DrawContext): TemplateResult {
  const url = ctx.buildUrl?.(ref);
  return url
    ? html`<a href=${url} target="_blank" rel="noopener noreferrer">${ref.label}</a> `
    : html`<span>${ref.label}</span> `;
}

/**
 * A reason in one line, cut short for the row; when the whole message says
 * more, "full error" opens it.
 */
function reason(
  lead: string,
  short: string | undefined,
  whole: string | undefined,
  key: string,
  ctx: DrawContext,
): TemplateResult | typeof nothing {
  if (!short && !whole) return lead ? html`<div class="reason">${lead}</div>` : nothing;
  const line = shorten(short ?? whole ?? "", 160);
  const text = lead ? `${lead}: ${line}` : line;
  if (!whole || whole.trim() === line) return html`<div class="reason">${text}</div>`;
  return html`<div class="reason">${text}</div>
    ${fold(key, false, html`full error`, html`<pre class="error">${whole}</pre>`, ctx)}`;
}

/** A workflow run under its row: how far it has got, and its steps. */
function workflowRun(
  run: GalaxyRun,
  entryId: string,
  ctx: DrawContext,
): TemplateResult | typeof nothing {
  if (run.kind !== "invocation" || (!run.steps && !run.progress)) return nothing;
  const steps = run.steps ?? [];
  const jobs = steps.flatMap((s) => s.jobs ?? []);
  const progress = run.progress
    ? `${run.progress.completedJobs} of ${run.progress.totalJobs} jobs done${
        run.progress.failedJobs ? ` · ${run.progress.failedJobs} failed` : ""
      }`
    : jobs.length > 0
      ? `${jobs.filter((j) => j.state === "ok").length} of ${jobs.length} jobs done`
      : "";
  return html`
    ${progress ? html`<div class="detail">${progress}</div>` : nothing}
    ${
      steps.length > 0
        ? fold(
            `steps:${entryId}:${run.id}`,
            false,
            html`${steps.length} steps`,
            html`${steps.map((step) => html`<div class="item">${stepLine(step)}</div>`)}`,
            ctx,
          )
        : nothing
    }
  `;
}

/** "Step 2: fastp — 1 ok, 1 running"; a step whose jobs Galaxy didn't list has no counts. */
function stepLine(step: InvocationStep): string {
  const label = step.label ? `: ${step.label}` : "";
  return `Step ${step.index + 1}${label}${step.jobs ? ` — ${jobCounts(step.jobs)}` : ""}`;
}

/** "2 ok, 1 running". */
function jobCounts(jobs: readonly { state: string }[]): string {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.state, (counts.get(job.state) ?? 0) + 1);
  return [...counts].map(([state, n]) => `${n} ${state}`).join(", ");
}

/** Reads and checks, folded into "N checks". */
function checksFold(
  key: string,
  entries: readonly NarrationEntry[],
  ctx: DrawContext,
): TemplateResult {
  return fold(
    key,
    false,
    html`${entries.length} check${entries.length === 1 ? "" : "s"}`,
    html`${entries.map(
      (e) =>
        html`<div class="item">
          ${
            e.status === "failed"
              ? `✗ ${e.title}${e.detail ? `: ${shorten(e.detail, 160)}` : ""}`
              : e.status === "running"
                ? `${e.title}…`
                : (e.doneTitle ?? e.title)
          }
        </div>`,
    )}`,
    ctx,
  );
}

/** The harness's follow-ups on this message's work, folded; open by itself while one is at work or failed. */
function followUpsFold(
  group: NarrationGroup,
  followUps: readonly NarrationGroup[],
  ctx: DrawContext,
): TemplateResult {
  const busy = followUps.some((f) => !isFinished(f) || f.status === "stopped");
  const checked = followUps.reduce(
    (n, f) => n + f.entries.filter((e) => e.kind !== "internal").length,
    0,
  );
  const label = `${followedUpLabel(followUps.length, ctx)}${checked > 0 ? ` · checked ${checked} thing${checked === 1 ? "" : "s"}` : ""}`;
  return fold(
    `followups:${group.id}`,
    busy,
    html`${label}`,
    html`${followUps.map(
      (f) =>
        html`<div class="followup">
          <div class="followup-state">${cardState(f, ctx)}</div>
          ${cardBody(f, ctx, [])}
        </div>`,
    )}`,
    ctx,
  );
}

/** "Orbit followed up (2)", or with no name, "Followed up on its own (2)". */
function followedUpLabel(count: number, ctx: DrawContext): string {
  const who = ctx.assistantName ? `${ctx.assistantName} followed up` : "Followed up on its own";
  return `${who} (${count})`;
}

/** A fold the user can open and close; it remembers their choice by key across redraws. */
function fold(
  key: string,
  byDefault: boolean,
  label: TemplateResult,
  content: TemplateResult,
  ctx: DrawContext,
  className = "fold",
): TemplateResult {
  const open = ctx.isOpen(key, byDefault);
  // The browser also fires "toggle" when the view itself opens or closes a fold;
  // only a change away from what was drawn is the user's choice.
  const onToggle = (event: Event) => {
    const now = (event.target as HTMLDetailsElement).open;
    if (now !== open) ctx.setOpen(key, now);
  };
  return html`<details class=${className} ?open=${open} @toggle=${onToggle}>
    <summary>${label}</summary>
    ${content}
  </details>`;
}

/** Styles for the card, through `--wh-*` custom properties with neutral defaults. */
export const cardStyles = css`
  .card header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-weight: 600;
  }
  .card .state {
    flex: none;
    white-space: nowrap;
  }
  .now,
  .wait,
  .note,
  .reason {
    margin: 4px 0 0 12px;
  }
  .wait {
    font-weight: 600;
  }
  .note,
  .detail,
  .item,
  .attempt,
  .followup-state {
    color: var(--wh-muted, GrayText);
  }
  .row {
    margin: 6px 0 0 12px;
  }
  .row .title {
    font-weight: 600;
  }
  .outputs,
  .detail,
  .attempt,
  .row .reason,
  .row .fold {
    margin: 2px 0 0 18px;
    font-size: 0.92em;
  }
  .outputs a {
    color: var(--wh-link, inherit);
  }
  .item {
    margin: 1px 0 0 14px;
    font-size: 0.92em;
  }
  /* Every fold says it opens: its own chevron, the pointer, and a hover underline. */
  details > summary {
    list-style: none;
    cursor: pointer;
    color: var(--wh-muted, GrayText);
  }
  details > summary::-webkit-details-marker {
    display: none;
  }
  details > summary::before {
    content: "▸";
    display: inline-block;
    width: 1.1em;
    color: var(--wh-text, inherit);
  }
  details[open] > summary::before {
    content: "▾";
  }
  details > summary:hover {
    text-decoration: underline;
  }
  details.summary {
    margin: 4px 0 0 12px;
  }
  details.summary > summary {
    color: inherit;
  }
  .fold {
    margin: 4px 0 0 12px;
  }
  .followup {
    margin: 4px 0 0 12px;
    padding-left: 10px;
    border-left: 2px solid var(--wh-border, rgba(127, 127, 127, 0.4));
  }
  pre.error {
    margin: 4px 0 0 14px;
    white-space: pre-wrap;
    font-size: 0.85em;
  }
`;
