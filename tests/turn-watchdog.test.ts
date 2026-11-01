import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnWatchdog } from "../app/src/main/turn-watchdog.js";

const TIMEOUT = 1000;
const COMPACTION_TIMEOUT = TIMEOUT * 30;

describe("TurnWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make() {
    const onTimeout = vi.fn();
    const watchdog = new TurnWatchdog({
      timeoutMs: TIMEOUT,
      compactionTimeoutMs: COMPACTION_TIMEOUT,
      onTimeout,
    });
    return { watchdog, onTimeout };
  }

  it("fires onTimeout when the brain goes silent after a prompt", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();

    vi.advanceTimersByTime(TIMEOUT);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not fire while a turn is idle (no prompt in flight)", () => {
    const { watchdog, onTimeout } = make();

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("ignores events observed before a prompt is sent", () => {
    const { watchdog, onTimeout } = make();

    // A stray lifecycle event with no active turn must not arm the watchdog.
    watchdog.observe("agent_start");
    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("resets the silence window each time the brain emits an event", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();

    // Events keep arriving just before each deadline -> never fires.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(TIMEOUT - 1);
      watchdog.observe("message_update");
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // ...then the brain goes silent for a full window.
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("disarms on agent_end (normal completion)", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("agent_end");

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("disarms on a surfaced error event", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("error");

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("pauses for the whole tool-execution window so long tools don't false-fire", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("tool_execution_start");

    // Tool runs far longer than the silence window, emitting nothing or only
    // sporadic progress -- must not be mistaken for a stalled provider call.
    vi.advanceTimersByTime(TIMEOUT * 10);
    watchdog.observe("tool_execution_update");
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    // Once the tool finishes we're waiting on the model again -> re-armed.
    watchdog.observe("tool_execution_end");
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("pauses while a UI modal is open and resumes when the brain continues", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.observe("extension_ui_request");

    // User takes their time answering the modal; brain is blocked on stdin.
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    // Brain resumes (emits lifecycle activity) -> watchdog re-arms.
    watchdog.observe("message_update");
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("stop() disarms an in-flight turn", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.stop();

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("only fires once per stalled turn", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();

    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("excludes system sleep and gives the model a full recovery window after wake", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    vi.advanceTimersByTime(TIMEOUT - 1);
    watchdog.suspend();
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.resume();
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not rearm for late brain events while the system is suspended", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.suspend();
    watchdog.observe("message_update");
    watchdog.observe("tool_execution_end");
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.resume();
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it.each(["tool_execution_start", "extension_ui_request"])(
    "preserves a %s wait across sleep and wake",
    (event) => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe(event);
      watchdog.suspend();
      vi.advanceTimersByTime(TIMEOUT * 10);
      watchdog.resume();
      vi.advanceTimersByTime(TIMEOUT * 10);
      expect(onTimeout).not.toHaveBeenCalled();

      watchdog.observe("tool_execution_end");
      vi.advanceTimersByTime(TIMEOUT);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["agent_end", "error", "stop"])(
    "does not revive a turn that receives %s during sleep",
    (event) => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.suspend();
      if (event === "stop") watchdog.stop();
      else watchdog.observe(event);
      watchdog.resume();
      vi.advanceTimersByTime(TIMEOUT * 10);
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );

  it("recovers on the next prompt if the OS never delivers resume", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    watchdog.suspend();
    watchdog.observe("agent_end");
    // No resume() -- the user just types again once the machine is back.
    watchdog.promptSent();
    vi.advanceTimersByTime(TIMEOUT);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not arm when an idle system wakes", () => {
    const { watchdog, onTimeout } = make();
    watchdog.suspend();
    watchdog.resume();
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("handles repeated sleep cycles without duplicate timers or extra resume delays", () => {
    const { watchdog, onTimeout } = make();
    watchdog.promptSent();
    for (let i = 0; i < 3; i++) {
      watchdog.suspend();
      watchdog.suspend();
      vi.advanceTimersByTime(TIMEOUT * 10);
      watchdog.resume();
      vi.advanceTimersByTime(TIMEOUT - 1);
    }
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.resume();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TIMEOUT * 10);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  describe("compaction (#616)", () => {
    it("does not kill a compaction that outlives the silence window", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");

      // One long summarization call with no events, well past the normal window.
      vi.advanceTimersByTime(COMPACTION_TIMEOUT - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      // Compaction finished; back to waiting on the model under the normal window.
      watchdog.observe("compaction_end");
      vi.advanceTimersByTime(TIMEOUT - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("silence");
    });

    it("still fires, naming compaction, when a compaction never ends", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");

      vi.advanceTimersByTime(COMPACTION_TIMEOUT);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("compaction");

      // A late compaction_end from the abandoned turn must not rearm anything.
      watchdog.observe("compaction_end");
      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 2);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("returns to the normal window when an aborted compaction ends", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT * 5);

      // The user pressed Stop: pi aborts the summarization and reports it.
      watchdog.observe("compaction_end");
      watchdog.observe("agent_end");
      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("treats silence after an aborted compaction as an ordinary stall", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT * 5);
      // Stopped mid-compaction, but no agent_end follows.
      watchdog.observe("compaction_end");

      vi.advanceTimersByTime(TIMEOUT);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("silence");
    });

    it("lets a compaction that starts after the turn ended finish quietly", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("agent_end");
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(COMPACTION_TIMEOUT - 1);
      watchdog.observe("compaction_end");

      // No turn is in flight, so nothing is left to time.
      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("still fires when a compaction that started after the turn ended wedges", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("agent_end");
      watchdog.observe("compaction_start");

      vi.advanceTimersByTime(COMPACTION_TIMEOUT);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("keeps timing a post-turn compaction across a handled command's stop()", () => {
      const { watchdog, onTimeout } = make();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT);
      watchdog.stop();

      // Measured from compaction_start, not restarted by the stop.
      vi.advanceTimersByTime(COMPACTION_TIMEOUT - TIMEOUT - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("does not count sleep against the ceiling when the OS never delivers resume", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      watchdog.suspend();
      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 2);

      watchdog.promptSent();
      vi.advanceTimersByTime(COMPACTION_TIMEOUT - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("does not let streaming events extend the compaction ceiling", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(COMPACTION_TIMEOUT / 2);
      watchdog.observe("message_update");

      vi.advanceTimersByTime(COMPACTION_TIMEOUT / 2);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("ignores other events during a post-turn compaction", () => {
      const { watchdog, onTimeout } = make();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT);
      watchdog.observe("extension_ui_request", "confirm");
      watchdog.observe("message_update");

      vi.advanceTimersByTime(COMPACTION_TIMEOUT - TIMEOUT);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("does not time a post-turn compaction across a reset", () => {
      const { watchdog, onTimeout } = make();
      watchdog.observe("compaction_start");
      watchdog.reset();

      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("keeps the compaction ceiling across sleep and wake", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      watchdog.suspend();
      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 2);
      watchdog.resume();

      vi.advanceTimersByTime(COMPACTION_TIMEOUT - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("keeps the compaction ceiling when a follow-up prompt is queued mid-compaction", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT * 5);

      // The user types while waiting; pi queues it as a follow-up.
      watchdog.promptSent();
      vi.advanceTimersByTime(COMPACTION_TIMEOUT - TIMEOUT * 5 - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("applies the ceiling to a prompt sent during a compaction that began after agent_end", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("agent_end");
      // pi's post-run threshold compaction: the turn looks finished to the UI.
      watchdog.observe("compaction_start");
      watchdog.promptSent();

      vi.advanceTimersByTime(COMPACTION_TIMEOUT - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      watchdog.observe("compaction_end");
      vi.advanceTimersByTime(TIMEOUT);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("silence");
    });

    it("keeps the compaction ceiling across a handled command's stop()", () => {
      const { watchdog, onTimeout } = make();
      watchdog.observe("compaction_start");
      watchdog.promptSent();
      watchdog.stop();

      watchdog.promptSent();
      vi.advanceTimersByTime(TIMEOUT * 5);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("does not let status or notify updates lift the compaction ceiling", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT);
      watchdog.observe("extension_ui_request", "setStatus");
      watchdog.observe("extension_ui_request", "notify");
      watchdog.observe("extension_ui_request");

      vi.advanceTimersByTime(COMPACTION_TIMEOUT - TIMEOUT);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("pauses for a dialog opened during compaction", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      watchdog.observe("extension_ui_request", "confirm");

      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 3);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("gives the next prompt the normal window after a compaction stall with no compaction_end", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(COMPACTION_TIMEOUT);
      expect(onTimeout).toHaveBeenCalledWith("compaction");

      // The abort never landed, so the user retries against the same wedged brain.
      watchdog.promptSent();
      vi.advanceTimersByTime(TIMEOUT - 1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenLastCalledWith("silence");
    });

    it("times the compaction again once its dialog is answered", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      watchdog.observe("extension_ui_request", "confirm");
      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 3);
      // The brain says nothing until compaction_end, so only the answer can lift the pause.
      watchdog.dialogAnswered();

      vi.advanceTimersByTime(COMPACTION_TIMEOUT - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledWith("compaction");
    });

    it("stays paused when a dialog is answered mid-tool", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("tool_execution_start");
      watchdog.observe("extension_ui_request", "confirm");
      watchdog.dialogAnswered();

      vi.advanceTimersByTime(TIMEOUT * 5);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("keeps watching a turn on the normal window after a crashed brain's compaction is forgotten", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      vi.advanceTimersByTime(TIMEOUT * 5);
      watchdog.forgetCompaction();

      vi.advanceTimersByTime(TIMEOUT);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith("silence");
    });

    it("watches the turn again when the brain crashes during a dialog mid-compaction", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      watchdog.observe("extension_ui_request", "confirm");
      watchdog.forgetCompaction();

      vi.advanceTimersByTime(TIMEOUT);
      expect(onTimeout).toHaveBeenCalledWith("silence");
    });

    it("does not arm when forgetting a compaction outside a turn", () => {
      const { watchdog, onTimeout } = make();
      watchdog.observe("compaction_start");
      watchdog.forgetCompaction();

      vi.advanceTimersByTime(COMPACTION_TIMEOUT * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("forgets a compaction when the brain process is reset", () => {
      const { watchdog, onTimeout } = make();
      watchdog.promptSent();
      watchdog.observe("compaction_start");
      watchdog.reset();

      watchdog.promptSent();
      vi.advanceTimersByTime(TIMEOUT);
      expect(onTimeout).toHaveBeenCalledWith("silence");
    });
  });
});
