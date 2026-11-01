/**
 * Parts shared by the What's Happening views: the status lines, the message
 * card, and their styles. Each view (the list, the inline one-liner) is a thin
 * element around these, so a card looks the same wherever it is drawn.
 */

import { css, html, LitElement, nothing, type PropertyValues } from "lit";

import {
  anchorUserMessage,
  currentActivity,
  EMPTY_STATE,
  isStalled,
  stallText,
} from "../core/narrator.js";
import type {
  ActivityLine,
  GalaxyRef,
  NarrationGroup,
  NarrationState,
  NowLine,
} from "../core/types.js";

/** A Galaxy page for a ref, or undefined when the host can't link to it. */
export type GalaxyLinkBuilder = (ref: GalaxyRef) => string | undefined;

/** What every part needs to draw. */
export interface DrawContext {
  state: NarrationState;
  /** The current time, in epoch milliseconds. */
  now: number;
  /** The assistant's name, e.g. "Orbit"; without it the wording stays neutral. */
  assistantName?: string;
  /** Builds a link into Galaxy for a ref; without it, nothing is a link. */
  buildUrl?: GalaxyLinkBuilder;
  /** Whether a fold (by its key) is open: what the user last chose, else `byDefault`. */
  isOpen: (key: string, byDefault: boolean) => boolean;
  /** Remembers the user opening or closing a fold, so a redraw keeps it that way. */
  setOpen: (key: string, open: boolean) => void;
}

/**
 * What every view element takes from its host, and a clock that ticks once a
 * second while something is going on, so its timers move.
 */
export class NarrationView extends LitElement {
  static override properties = {
    state: { attribute: false },
    buildUrl: { attribute: false },
    assistantName: { type: String, attribute: "assistant-name" },
    now: { attribute: false },
  };

  // Declared, not class fields: a class field would hide Lit's reactive accessor.
  /** The narration state to draw. */
  declare state: NarrationState;
  /** Builds a link into Galaxy for a ref; without it, nothing is a link. */
  declare buildUrl?: GalaxyLinkBuilder;
  /** The assistant's name, e.g. "Orbit"; without it the wording stays neutral. */
  declare assistantName?: string;
  /** The clock, in epoch milliseconds; for tests. Left unset, the element keeps its own. */
  declare now?: number;

  #clock = Date.now();
  #ticker?: ReturnType<typeof setInterval>;
  /** Folds the user opened or closed, by key. */
  #folds = new Map<string, boolean>();

  constructor() {
    super();
    this.state = EMPTY_STATE;
  }

  /** What the parts need to draw, as of now. */
  protected get context(): DrawContext {
    return {
      state: this.state,
      now: this.now ?? Math.max(this.#clock, Date.now()),
      assistantName: this.assistantName,
      buildUrl: this.buildUrl,
      isOpen: (key, byDefault) => this.#folds.get(key) ?? byDefault,
      setOpen: (key, open) => this.#folds.set(key, open),
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#syncTicker();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#stopTicker();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("state") || changed.has("now")) this.#syncTicker();
  }

  #syncTicker(): void {
    const busy = this.now === undefined && currentActivity(this.state).length > 0;
    if (busy && !this.#ticker) {
      this.#ticker = setInterval(() => {
        this.#clock = Date.now();
        this.requestUpdate();
      }, 1000);
    } else if (!busy) {
      this.#stopTicker();
    }
  }

  #stopTicker(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = undefined;
  }
}

/** Everything going on right now: one line each, Galaxy work folded into one, or "Nothing running". */
export function statusLines(ctx: DrawContext) {
  const activity = currentActivity(ctx.state);
  if (activity.length === 0) {
    return html`<div class="status"><span class="quiet">Nothing running</span></div>`;
  }
  const galaxy = activity.filter((l) => l.kind === "galaxy");
  const more = galaxy.length > 1 ? ` (+${galaxy.length - 1} more)` : "";
  return html`<div class="status">
    ${activity
      .filter((l) => l.kind !== "galaxy")
      .map((line) => html`<div>${statusLine(line, ctx)}</div>`)}
    ${
      galaxy.length > 0
        ? html`<div>
            ⏳ Galaxy is still working: ${galaxy[0].text}${more}
            (${elapsed(ctx.now - galaxy[0].since)})
          </div>`
        : nothing
    }
  </div>`;
}

function statusLine(line: ActivityLine, ctx: DrawContext): string {
  const age = `(${elapsed(ctx.now - line.since)})`;
  if (line.kind === "waiting") return `⏸ Waiting for you: ${line.text} ${age}`;
  return `● ${nowText(line, ctx)} ${age}`;
}

/** A status line's words, or who is slow once nothing has happened under it for a while. */
export function nowText(line: NowLine, ctx: DrawContext): string {
  return isStalled(line, ctx.now)
    ? stallText(line, { assistantName: ctx.assistantName })
    : line.text;
}

/** "You asked: …", or for the harness's own follow-up, who followed up on what. */
export function cardTitle(group: NarrationGroup, ctx: DrawContext): string {
  const message = anchorUserMessage(ctx.state, group);
  const quoted = message ? ` "${shorten(message.text, 70)}"` : "";
  if (!group.followUp) return message ? `You asked:${quoted}` : "Working on your message";
  const who = ctx.assistantName ? `${ctx.assistantName} followed up` : "Followed up on its own";
  return message ? `${who} on:${quoted}` : who;
}

/** Where a card stands: at work and for how long, waiting on the user, stopped, or done. */
export function cardState(group: NarrationGroup, ctx: DrawContext): string {
  const took = elapsed((group.endedAt ?? ctx.now) - group.startedAt);
  if (group.status === "active") return `⏳ ${took}`;
  if (group.status === "stopped") return "❌ Stopped";
  if (group.status === "waiting") return "⏸ Waiting for you";
  if (group.entries.some((e) => e.status === "running")) return "⏳ Galaxy still working";
  return `✅ Done in ${took}`;
}

/** "45s", "3m 05s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The first line of a text, cut to `max` characters for a header. */
export function shorten(text: string, max: number): string {
  const line = text.trim().split("\n")[0];
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Styles for the parts, through `--wh-*` custom properties with neutral defaults. */
export const partStyles = css`
  :host {
    display: block;
    color: var(--wh-text, inherit);
    font: var(--wh-font, inherit);
  }
  .status {
    padding: 6px 0;
    font-weight: 600;
  }
  .status .quiet {
    font-weight: normal;
    color: var(--wh-muted, GrayText);
  }
  .card {
    margin: 10px 0;
    padding: 8px 10px;
    border: 1px solid var(--wh-border, rgba(127, 127, 127, 0.4));
    border-radius: var(--wh-radius, 6px);
    background: var(--wh-card, transparent);
  }
`;
