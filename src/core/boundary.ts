// The error boundary: every entry point of the tag (its top-level boot, a command the site calls,
// a route change, a promise it awaits) runs inside it, so nothing the tag does throws into the
// host page. A failure is never dropped either: it goes to the boundary's report sink, sampled
// once per page and capped per page, so that a tag broken everywhere can't flood the collector.

/** Where in the tag a failure happened. */
export type Stage = "boot" | "config" | "command" | "pageview" | "route";

/** One failure, as the boundary hands it to its sink. */
export interface ErrorReport {
  readonly stage: Stage;
  readonly name: string;
  readonly message: string;
}

export type ReportSink = (report: ErrorReport) => void;

/** The most reports one page load hands its sink. */
export const MAX_REPORTS_PER_PAGE = 5;

/** The longest message a report carries, in UTF-16 units. */
export const MAX_REPORT_MESSAGE = 256;

export class ErrorBoundary {
  private readonly sampled: boolean;
  private reported = 0;

  /**
   * `sampleRate` is the share of page loads whose failures are reported, from 0 to 1; the page is
   * drawn once, with `random`, so a sampled page reports all its failures up to
   * MAX_REPORTS_PER_PAGE and any other reports none.
   */
  constructor(
    private readonly sink: ReportSink,
    sampleRate: number,
    random: () => number = Math.random,
  ) {
    this.sampled = random() < sampleRate;
  }

  /** Hands error to the sink, if this page is sampled and under its cap. Never throws. */
  report(stage: Stage, error: unknown): void {
    if (!this.sampled || this.reported >= MAX_REPORTS_PER_PAGE) return;
    this.reported++;
    const report = toReport(stage, error);
    try {
      this.sink(report);
    } catch (sinkError) {
      // The sink is the last place a failure can go: reporting its own failure would loop, and
      // throwing would reach the host page. The report is a side effect, so it is logged instead.
      warn("amanda: could not report a tag error", report, sinkError);
    }
  }

  /** Runs fn, and reports what it throws instead of throwing it; undefined when it threw. */
  guard<T>(stage: Stage, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.report(stage, error);
      return undefined;
    }
  }

  /** Reports a rejection of promise instead of leaving it unhandled. */
  watch(stage: Stage, promise: Promise<unknown>): void {
    promise.then(undefined, (error: unknown) => this.report(stage, error));
  }
}

function toReport(stage: Stage, error: unknown): ErrorReport {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { stage, name, message: message.slice(0, MAX_REPORT_MESSAGE) };
}

/** console.warn where the page has a console; a page without one gets nothing. */
export function warn(...args: unknown[]): void {
  if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(...args);
}
