export type RetryControllableSession = {
  isStreaming: boolean;
  autoRetryEnabled: boolean;
  setAutoRetryEnabled(enabled: boolean): void;
};

export class InterruptRetryGuard {
  private suppressed = false;

  suppress(session: RetryControllableSession): void {
    if (!session.isStreaming || !session.autoRetryEnabled) return;
    session.setAutoRetryEnabled(false);
    this.suppressed = true;
  }

  restoreForRun(session: RetryControllableSession, signal: AbortSignal | undefined): void {
    if (!signal || signal.aborted) return;
    this.restore(session);
  }

  restore(session: RetryControllableSession): void {
    if (!this.suppressed) return;
    this.suppressed = false;
    session.setAutoRetryEnabled(true);
  }
}
