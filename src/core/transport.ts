// The transport: it posts the tag's events and anonymous pings to POST <endpoint>/v1/e as batches
// (schema/v1/batch.json). A batch goes when 10 items are buffered, 2 s after the first of them, or
// at once for a pageview. A batch that meets a network error or a 5xx is retried twice, with
// backoff, and then dropped. On pagehide, and with a page_exit (engagement.ts), which comes as the
// page is hidden, every buffered item and every batch awaiting a retry goes with sendBeacon, or a
// keepalive fetch where the browser has no sendBeacon or refuses it.
// When the visitor declines, the events not sent yet are dropped instead (withdrawEvents, AAI-86).
//
// Everything lives in memory: no cookie, localStorage or IndexedDB, so a visitor who declined
// accrues no storage, and what the page hasn't sent when it dies is lost. Loss is measured
// instead: each event batch carries seq, the page's batch counter, whose gaps the collector reads
// as lost batches (AAI-106). A ping batch never carries seq (schema/v1/batch.json).
// An event batch from a browser that reports navigator.webdriver === true carries webdriver: true,
// for the collector's bot marking (AAI-76); a ping batch never does.

import type { EventBatch, PingBatch, WireEvent, WirePing } from "../wire/generated";
import { warn, type ErrorBoundary } from "./boundary";
import { batchRequestInit, eventsUrl, type BatchKind } from "./endpoint";

/** The most items in one batch (batch.json's maxItems). */
export const MAX_BATCH_ITEMS = 10;

/** How long the first buffered item waits for others before its batch goes. */
export const FLUSH_DELAY_MS = 2000;

/** The wait before each retry of a batch that met a network error or a 5xx: two retries. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/** The browser globals the transport uses: window, or a stand-in for it in tests. */
export interface TransportWindow {
  fetch: typeof fetch;
  readonly navigator: { sendBeacon?(url: string, data?: BodyInit | null): boolean; readonly webdriver?: boolean };
  setTimeout(handler: () => void, timeout: number): unknown;
  clearTimeout(handle: unknown): void;
  addEventListener(type: "pagehide", listener: () => void): void;
}

/** POST /v1/e answered with a status other than 2xx or 5xx: the collector refused what the tag sent. */
export class CollectorRefusedError extends Error {
  override name = "CollectorRefusedError";
}

export interface Transport {
  /**
   * Buffers a built event; a pageview, or the 10th buffered event, sends the batch at once, and a
   * page_exit sends everything buffered at once, as pagehide does.
   */
  event(event: WireEvent): void;
  /** Buffers a built ping, as event buffers an event; pings go in batches of their own. */
  ping(ping: WirePing): void;
  /**
   * The visitor declined: drops the buffered events and the event batches awaiting a retry, so
   * that none goes after the decline, with a warning saying how many. Pings, and a batch whose
   * request is already in flight, are left as they are.
   */
  withdrawEvents(): void;
}

/** One batch as sent: its body keeps its seq through every retry. */
interface Batch {
  readonly kind: BatchKind;
  readonly body: string;
  readonly size: number;
  /** The tries made so far. */
  tries: number;
  /** The pending retry's timer, while the batch awaits one. */
  timer?: unknown;
}

/**
 * The transport to endpoint's /v1/e. It listens for pagehide on win; its timers, responses and
 * pagehide flush run inside the boundary, as stage "transport", so nothing it does throws into
 * the page. A batch the collector refuses (a status other than 2xx or 5xx) is reported, as is any
 * failure inside a flush. A batch dropped after its retries, or on pagehide, is logged with
 * console.warn: a network failure isn't the tag's, and seq's gap counts the lost events.
 */
export function createTransport(win: TransportWindow, endpoint: string, boundary: ErrorBoundary): Transport {
  const url = eventsUrl(endpoint);
  const buffers: { events: WireEvent[]; pings: WirePing[] } = { events: [], pings: [] };
  const awaitingRetry = new Set<Batch>();
  const flushTimers: Record<BatchKind, unknown> = { events: undefined, pings: undefined };
  let seq = 0;
  // Only a strict true marks the browser as automated: a missing or odd value sends nothing.
  const webdriver = win.navigator.webdriver === true;

  const batchOf = (kind: BatchKind): Batch | undefined => {
    let body: string;
    let size: number;
    if (kind === "events") {
      const items = buffers.events.splice(0);
      if (items.length === 0) return undefined;
      const batch: EventBatch = { seq: ++seq, e: items as EventBatch["e"] };
      if (webdriver) batch.webdriver = true;
      body = JSON.stringify(batch);
      size = items.length;
    } else {
      const items = buffers.pings.splice(0);
      if (items.length === 0) return undefined;
      const batch: PingBatch = { e: items as PingBatch["e"] };
      body = JSON.stringify(batch);
      size = items.length;
    }
    return { kind, body, size, tries: 0 };
  };

  const dropped = (batch: Batch, why: string, error?: unknown): void => {
    warn(`amanda: dropped a batch of ${batch.size} ${batch.kind} to ${url}: ${why}`, ...(error === undefined ? [] : [error]));
  };

  const refused = (batch: Batch, status: number): never => {
    throw new CollectorRefusedError(`POST ${url}: HTTP ${status}, ${batch.size} ${batch.kind} dropped`);
  };

  const retryOrDrop = (batch: Batch, why: string, error?: unknown): void => {
    const delay = RETRY_DELAYS_MS[batch.tries - 1];
    if (delay === undefined) {
      dropped(batch, `${why}, after ${batch.tries} tries`, error);
      return;
    }
    awaitingRetry.add(batch);
    batch.timer = win.setTimeout(() => {
      boundary.guard("transport", () => {
        awaitingRetry.delete(batch);
        batch.timer = undefined;
        post(batch);
      });
    }, delay);
  };

  const post = (batch: Batch): void => {
    batch.tries++;
    const sent = win.fetch(url, batchRequestInit(batch.body, batch.kind)).then(
      (response) => {
        if (response.ok) return;
        if (response.status >= 500) return retryOrDrop(batch, `HTTP ${response.status}`);
        refused(batch, response.status);
      },
      (error: unknown) => {
        // fetch rejects with a TypeError on a network error; anything else isn't one, and is reported.
        if (!(error instanceof TypeError)) throw error;
        retryOrDrop(batch, "network error", error);
      },
    );
    boundary.watch("transport", sent);
  };

  /** Sends one batch as the page goes: no retry can follow, since the page may not outlive it. */
  const postOnUnload = (batch: Batch): void => {
    // sendBeacon always sends the endpoint's cookies, which a ping must never carry (batchRequestInit).
    const beacon = win.navigator.sendBeacon;
    if (batch.kind === "events" && typeof beacon === "function" && beacon.call(win.navigator, url, batch.body)) return;
    const sent = win.fetch(url, batchRequestInit(batch.body, batch.kind, true)).then(
      (response) => {
        if (response.ok) return;
        if (response.status >= 500) return dropped(batch, `HTTP ${response.status} on pagehide`);
        refused(batch, response.status);
      },
      (error: unknown) => {
        if (!(error instanceof TypeError)) throw error;
        dropped(batch, "network error on pagehide", error);
      },
    );
    boundary.watch("transport", sent);
  };

  const stopTimer = (kind: BatchKind): void => {
    if (flushTimers[kind] !== undefined) win.clearTimeout(flushTimers[kind]);
    flushTimers[kind] = undefined;
  };

  const flush = (kind: BatchKind): void => {
    stopTimer(kind);
    const batch = batchOf(kind);
    if (batch !== undefined) post(batch);
  };

  const buffered = (kind: BatchKind, type: string, size: number): void => {
    if (type === "pageview" || size >= MAX_BATCH_ITEMS) {
      flush(kind);
    } else if (flushTimers[kind] === undefined) {
      flushTimers[kind] = win.setTimeout(() => {
        flushTimers[kind] = undefined;
        boundary.guard("transport", () => flush(kind));
      }, FLUSH_DELAY_MS);
    }
  };

  /** Sends every buffered item and every batch awaiting a retry as the page goes (postOnUnload). */
  const flushOnUnload = (): void => {
    stopTimer("events");
    stopTimer("pings");
    const batches: Batch[] = [];
    for (const batch of awaitingRetry) {
      win.clearTimeout(batch.timer);
      batch.timer = undefined;
      batches.push(batch);
    }
    awaitingRetry.clear();
    for (const kind of ["events", "pings"] as const) {
      const batch = batchOf(kind);
      if (batch !== undefined) batches.push(batch);
    }
    // Each batch on its own: one that fails is reported, and the others still go.
    for (const batch of batches) boundary.guard("transport", () => postOnUnload(batch));
  };

  win.addEventListener("pagehide", () => {
    boundary.guard("transport", flushOnUnload);
  });

  return {
    event(event) {
      const size = buffers.events.push(event);
      // A page_exit is handed over as the page is hidden, whose timers may never run again.
      if (event.type === "page_exit") flushOnUnload();
      else buffered("events", event.type, size);
    },
    ping(ping) {
      buffered("pings", ping.type, buffers.pings.push(ping));
    },
    withdrawEvents() {
      stopTimer("events");
      const items = buffers.events.splice(0);
      if (items.length > 0) warn(`amanda: dropped ${items.length} buffered events: the visitor declined`);
      for (const batch of awaitingRetry) {
        if (batch.kind !== "events") continue;
        win.clearTimeout(batch.timer);
        awaitingRetry.delete(batch);
        dropped(batch, "the visitor declined");
      }
    },
  };
}
