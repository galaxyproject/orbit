/**
 * Watchdog that breaks the "stuck on thinking" hang (#185).
 *
 * Orbit clears its "...thinking" indicator only when the brain emits a terminal
 * event (`agent_end` / `error` / `message_end` with an error stop reason). When a
 * cloud provider call fails or stalls *after* prompt preflight, pi can emit no
 * terminal event at all -- the RPC layer swallows a post-preflight throw, and a
 * truly stalled socket never resolves -- so the UI spins forever with no error,
 * no timeout, no recovery.
 *
 * This watchdog is the shell-side backstop: while a prompt is in flight it arms a
 * silence timer, resets it on every byte of brain activity, and fires if the
 * brain goes completely silent for `timeoutMs`. It deliberately pauses for the
 * whole tool-execution window and while a UI modal is open, since those are
 * legitimate long/indefinite waits rather than a stalled provider call. System
 * sleep is excluded too; waking starts a fresh silence window for recovery.
 *
 * Compaction is one long summarization call that emits nothing until it ends,
 * and on a local model it can run for most of an hour (#616). It gets its own,
 * much longer window instead of a pause, so a compaction that truly wedges is
 * still reported rather than spinning forever. pi also compacts after
 * `agent_end`, when the user may already be typing again, so compaction is
 * tracked and timed whether or not a turn is in flight and survives a queued
 * prompt.
 */
export type TurnStallKind = "silence" | "compaction";

export interface TurnWatchdogConfig {
  /** How long the brain may stay silent mid-turn before we treat it as stalled. */
  timeoutMs: number;
  /**
   * How long a compaction may run between `compaction_start` and `compaction_end`,
   * counted from its start (system sleep excepted), whatever else arrives meanwhile.
   */
  compactionTimeoutMs: number;
  /**
   * Invoked when a turn or a compaction stalls; a compaction can stall after its
   * turn has ended. The watchdog is already disarmed when this runs.
   */
  onTimeout: (kind: TurnStallKind) => void;
}

export class TurnWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // A user prompt is in flight (turn started, not yet terminal).
  private active = false;
  // The brain is legitimately blocked (running a tool, or awaiting a modal),
  // so silence is expected and must not be mistaken for a stall.
  private paused = false;
  // Between compaction_start and compaction_end; selects the longer window.
  // Like `suspended`, it outlives promptSent() and stop(): only the brain
  // (compaction_end), a firing, or a brain exit (reset / forgetCompaction)
  // clears it.
  private compacting = false;
  // A fixed ceiling, so prompts typed at a wedged compaction can't postpone it.
  private compactionStartedAt = 0;
  // Power state is independent of tool/modal waits and survives stop(). Brain
  // events can still arrive after the OS announces suspend; none may rearm us.
  private suspended = false;

  constructor(private readonly config: TurnWatchdogConfig) {}

  /** A user prompt was dispatched to the brain; begin watching for a stall. */
  promptSent(): void {
    // A fresh user prompt means the machine is awake. Clearing here keeps a
    // dropped powerMonitor `resume` from disabling the watchdog for good.
    if (this.suspended) this.restartCompactionClock();
    this.suspended = false;
    this.active = true;
    this.paused = false;
    this.arm();
  }

  /** Exclude system sleep without losing the current turn or tool/modal wait. */
  suspend(): void {
    this.suspended = true;
    this.clearTimer();
  }

  /** Give an active model request a full silence window to recover after wake. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.restartCompactionClock();
    this.arm();
  }

  /**
   * Observe a brain -> shell event by its `type`. Resets the silence window on
   * normal activity, pauses across tool/modal waits, and disarms on terminal
   * events. With no turn in flight only compaction events count.
   */
  observe(eventType: string, uiMethod?: string): void {
    const isCompactionEvent = eventType === "compaction_start" || eventType === "compaction_end";
    if (isCompactionEvent) this.compacting = eventType === "compaction_start";
    if (eventType === "compaction_start") this.compactionStartedAt = Date.now();
    if (!this.active) {
      if (isCompactionEvent) this.arm();
      return;
    }
    switch (eventType) {
      case "agent_end":
      case "error":
        // Turn resolved (success or surfaced error) -- nothing to guard.
        this.stop();
        return;
      case "extension_ui_request":
        // Status, widget and notify updates land mid-compaction (a tool's status
        // is cleared a few seconds after it ends); only a dialog that waits on
        // the user may lift the compaction ceiling.
        if (this.compacting && !isDialogMethod(uiMethod)) return;
        this.paused = true;
        this.clearTimer();
        return;
      case "tool_execution_start":
        // Tool may run long; a modal may wait on the user indefinitely. Pause
        // until the brain produces output again.
        this.paused = true;
        this.clearTimer();
        return;
      case "tool_execution_update":
        // Liveness mid-tool, but the tool can still go silent afterward. Stay
        // paused for the whole tool window rather than re-arming here.
        return;
      case "tool_execution_end":
        // Back to waiting on the model.
        this.paused = false;
        this.arm();
        return;
      case "compaction_start":
        this.paused = false;
        this.arm();
        return;
      case "compaction_end":
        // Fires for success, failure and abort alike; each hands control back
        // to the turn, which is waiting on the model again.
        this.paused = false;
        this.arm();
        return;
      default:
        // Normal turn lifecycle / streaming (agent_start, message_*, turn_*,
        // text_*). Any such event also implicitly resumes after a modal.
        this.paused = false;
        this.arm();
        return;
    }
  }

  /** End the turn. A compaction still running stays on its own ceiling. */
  stop(): void {
    this.active = false;
    this.paused = false;
    this.arm();
  }

  /** The brain process is gone; no compaction it started can still be running. */
  reset(): void {
    this.compacting = false;
    this.stop();
  }

  /**
   * The brain exited and is being restarted. Its compaction_end will never come,
   * but an in-flight turn still needs watching on the normal window.
   */
  forgetCompaction(): void {
    if (!this.compacting) return;
    this.compacting = false;
    // Whatever dialog the dead brain was waiting on is gone with it.
    this.paused = false;
    this.arm();
  }

  // Sleep is excluded from the compaction ceiling as it is from the silence window.
  private restartCompactionClock(): void {
    if (this.compacting) this.compactionStartedAt = Date.now();
  }

  private arm(): void {
    this.clearTimer();
    if (!(this.active || this.compacting) || this.paused || this.suspended) return;
    const kind: TurnStallKind = this.compacting ? "compaction" : "silence";
    const timeoutMs = this.compacting
      ? Math.max(0, this.config.compactionTimeoutMs - (Date.now() - this.compactionStartedAt))
      : this.config.timeoutMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = false;
      this.paused = false;
      this.compacting = false;
      this.config.onTimeout(kind);
    }, timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function isDialogMethod(method: string | undefined): boolean {
  return method !== undefined && DIALOG_METHODS.has(method);
}
