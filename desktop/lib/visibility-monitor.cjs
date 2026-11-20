'use strict';
// Read-only UI status monitoring. Hidden/suspended windows own no timer, and
// slow reads finish before another probe can begin.
class VisibilityMonitor {
  constructor({ read, onResult, shouldRun = () => true, interval = 5000,
    setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout }) {
    this.read = read;
    this.onResult = onResult;
    this.shouldRun = shouldRun;
    this.interval = interval;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.stopped = true;
    this.active = false;
    this.timer = null;
    this.inFlight = null;
    this.generation = 0;
    this.inFlightGeneration = 0;
    this.refreshPending = false;
  }

  clearScheduled() {
    this.clearTimer(this.timer);
    this.timer = null;
  }

  schedule() {
    this.clearScheduled();
    if (this.stopped || !this.active) return;
    const delay = typeof this.interval === 'function' ? this.interval() : this.interval;
    this.timer = this.setTimer(() => { this.timer = null; void this.refresh(); }, delay);
    this.timer?.unref?.();
  }

  start(active = true) {
    if (!this.stopped) return;
    this.stopped = false;
    this.active = active;
    this.schedule();
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.generation += 1;
    this.clearScheduled();
    if (active) void this.refresh();
  }

  refresh() {
    this.clearScheduled();
    if (this.stopped || !this.active) return Promise.resolve();
    if (this.inFlight) {
      this.refreshPending = this.inFlightGeneration !== this.generation;
      return this.inFlight;
    }
    if (!this.shouldRun()) { this.schedule(); return Promise.resolve(); }
    const generation = this.generation;
    this.inFlightGeneration = generation;
    const pending = Promise.resolve().then(async () => {
      if (this.stopped || !this.active || generation !== this.generation || !this.shouldRun()) return;
      const result = await this.read();
      if (!this.stopped && this.active && generation === this.generation && this.shouldRun()) await this.onResult(result);
    }).catch(() => {
      // A transient background read is retried on the next visible interval.
      // Explicit user operations keep their own error reporting.
    }).finally(() => {
      this.inFlight = null;
      if (this.refreshPending) { this.refreshPending = false; void this.refresh(); }
      else this.schedule();
    });
    this.inFlight = pending;
    return pending;
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    this.refreshPending = false;
    this.clearScheduled();
  }
}

module.exports = { VisibilityMonitor };
