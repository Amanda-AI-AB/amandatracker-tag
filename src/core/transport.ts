// The transport: it posts the tag's events and anonymous pings to POST <endpoint>/v1/e as batches
// (schema/v1/batch.json). A batch goes when 10 items are buffered, 2 s after the first of them, or
// at once for a pageview. A batch that meets a network error or a 5xx is retried twice, with
// backoff, and then dropped. On pagehide, and with a page_exit (engagement.ts), which comes as the
// page is hidden, every buffered item and every batch awaiting a retry goes with sendBeacon, or a
// keepalive fetch where the browser has no sendBeacon or refuses it. Both count against the
// browser's 64 KiB keepalive quota, so that flush is split into bodies that stay within
// KEEPALIVE_BODY_LIMIT together; what doesn't fit is dropped (AAI-893). The quota is shared with
// the page's other scripts, so a pagehide fetch within it can still be rejected: its events are
// sent once more in two smaller bodies, and a body rejected again once more without keepalive
// (AAI-951). An ordinary batch goes without keepalive, whatever its size.
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
import { batchRequestInit, bodyBytes, eventsUrl, KEEPALIVE_BODY_LIMIT, type BatchKind } from "./endpoint";

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

type Item = WireEvent | WirePing;

/**
 * A pagehide fetch's step: the first, with keepalive; a half of a rejected batch, with keepalive;
 * or the last, without it.
 */
type UnloadStep = "keepalive" | "split" | "plain";

/** One batch as sent: its body keeps its seq through every retry. */
interface Batch {
  readonly kind: BatchKind;
  readonly body: string;
  /** The items in body, which a rejected pagehide fetch splits into smaller batches. */
  readonly items: readonly Item[];
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
  /** The UTF-8 bytes of the tag's own keepalive fetches still in flight. */
  let keepaliveInFlight = 0;
  // Only a strict true marks the browser as automated: a missing or odd value sends nothing.
  const webdriver = win.navigator.webdriver === true;

  /** The body of a batch of `items`; `batchSeq` is the seq an event batch carries. */
  const bodyOf = (kind: BatchKind, items: readonly Item[], batchSeq: number): string => {
    if (kind === "pings") return JSON.stringify({ e: items } as PingBatch);
    const batch: EventBatch = { seq: batchSeq, e: items as EventBatch["e"] };
    if (webdriver) batch.webdriver = true;
    return JSON.stringify(batch);
  };

  /** A new batch of `items`; an event batch takes the next seq. */
  const newBatch = (kind: BatchKind, items: readonly Item[]): Batch => ({
    kind,
    body: bodyOf(kind, items, kind === "events" ? ++seq : 0),
    items,
    tries: 0,
  });

  const batchOf = (kind: BatchKind): Batch | undefined => {
    const items: Item[] = buffers[kind].splice(0);
    return items.length === 0 ? undefined : newBatch(kind, items);
  };

  /**
   * The buffered items of `kind` as batches for the unload flush, each body built greedily up to
   * MAX_BATCH_ITEMS while all of them fit in `budget.left` bytes together, which it takes from. An
   * item that doesn't fit, alone or after the others, is dropped, with a warning counting them;
   * each run of dropped events takes a seq of its own, which the collector reads as a lost batch.
   */
  const unloadBatchesOf = (kind: BatchKind, budget: { left: number }): Batch[] => {
    const items: Item[] = buffers[kind].splice(0);
    const batches: Batch[] = [];
    let chunk: Item[] = [];
    let body = "";
    let lost = 0;
    let inGap = false;
    // Bodies are built with seq + 1, the seq they take when closed.
    const close = (): void => {
      if (chunk.length === 0) return;
      if (kind === "events") seq++;
      batches.push({ kind, body, items: chunk, tries: 0 });
      budget.left -= bodyBytes(body);
      chunk = [];
    };
    for (const item of items) {
      if (chunk.length < MAX_BATCH_ITEMS) {
        const grown = bodyOf(kind, [...chunk, item], seq + 1);
        if (bodyBytes(grown) <= budget.left) {
          chunk.push(item);
          body = grown;
          inGap = false;
          continue;
        }
      }
      close();
      const alone = bodyOf(kind, [item], seq + 1);
      if (bodyBytes(alone) <= budget.left) {
        chunk = [item];
        body = alone;
        inGap = false;
        continue;
      }
      if (!inGap && kind === "events") seq++;
      inGap = true;
      lost++;
    }
    close();
    if (lost > 0) {
      warn(`amanda: dropped ${lost} ${kind} to ${url} on pagehide: over the keepalive limit of ${KEEPALIVE_BODY_LIMIT} bytes`);
    }
    return batches;
  };

  const dropped = (batch: Batch, why: string, error?: unknown): void => {
    warn(`amanda: dropped a batch of ${batch.items.length} ${batch.kind} to ${url}: ${why}`, ...(error === undefined ? [] : [error]));
  };

  const refused = (batch: Batch, status: number): never => {
    throw new CollectorRefusedError(`POST ${url}: HTTP ${status}, ${batch.items.length} ${batch.kind} dropped`);
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

  /**
   * Sends one batch as the page goes, with sendBeacon, or a keepalive fetch where the browser has
   * no sendBeacon or refuses it. No timed retry can follow, since the page may not outlive it.
   */
  const postOnUnload = (batch: Batch): void => {
    // sendBeacon always sends the endpoint's cookies, which a ping must never carry (batchRequestInit).
    const beacon = win.navigator.sendBeacon;
    if (batch.kind === "events" && typeof beacon === "function" && beacon.call(win.navigator, url, batch.body)) return;
    sendOnUnload(batch, "keepalive");
  };

  /**
   * One pagehide fetch of `batch`, at `step` of its recovery (recoverOnUnload). A 5xx is dropped,
   * not retried, and a refusal is reported, at every step.
   */
  const sendOnUnload = (batch: Batch, step: UnloadStep): void => {
    const keepalive = step !== "plain";
    const init = batchRequestInit(batch.body, batch.kind, keepalive);
    const bytes = keepalive ? bodyBytes(batch.body) : 0;
    keepaliveInFlight += bytes;
    const sent = win.fetch(url, init).then(
      (response) => {
        keepaliveInFlight -= bytes;
        if (response.ok) return;
        if (response.status >= 500) return dropped(batch, `HTTP ${response.status} on pagehide`);
        refused(batch, response.status);
      },
      (error: unknown) => {
        keepaliveInFlight -= bytes;
        // fetch rejects with a TypeError for the keepalive quota and for a network error alike.
        if (!(error instanceof TypeError)) throw error;
        recoverOnUnload(batch, step, error);
      },
    );
    boundary.watch("transport", sent);
  };

  /**
   * A pagehide fetch of `batch` was rejected with `error`, most likely because the page's other
   * scripts had used the keepalive quota (KEEPALIVE_BODY_LIMIT), which fetch can't tell apart from
   * a network error. Its events go once more, in two smaller bodies, each a new batch with a seq of
   * its own, which leaves the rejected body's seq as a gap; a body rejected again, or a batch of
   * one item that can't be split, goes once more without keepalive, at best effort, as the page may
   * not outlive it. A body rejected without keepalive is dropped. The same body is never sent with
   * keepalive twice (AAI-893): each step is smaller than the last, or doesn't count against the quota.
   */
  const recoverOnUnload = (batch: Batch, step: UnloadStep, error: TypeError): void => {
    if (step === "plain") return dropped(batch, "network error on pagehide, without keepalive", error);
    if (step === "split" || batch.items.length === 1) return sendOnUnload(batch, "plain");
    const half = Math.ceil(batch.items.length / 2);
    for (const items of [batch.items.slice(0, half), batch.items.slice(half)]) {
      // Each half on its own: one that fails is reported, and the other still goes.
      boundary.guard("transport", () => sendOnUnload(newBatch(batch.kind, items), "split"));
    }
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

  /**
   * Sends every batch awaiting a retry and every buffered item as the page goes (postOnUnload),
   * in bodies that fit together, with the tag's keepalive fetches still in flight, within
   * KEEPALIVE_BODY_LIMIT. A batch awaiting a retry keeps its body and seq, and is dropped whole when
   * it doesn't fit. A beacon's bytes count only within its own flush: the page can't tell when the
   * browser has sent it.
   */
  const flushOnUnload = (): void => {
    stopTimer("events");
    stopTimer("pings");
    const budget = { left: KEEPALIVE_BODY_LIMIT - keepaliveInFlight };
    const batches: Batch[] = [];
    for (const batch of awaitingRetry) {
      win.clearTimeout(batch.timer);
      batch.timer = undefined;
      const bytes = bodyBytes(batch.body);
      if (bytes > budget.left) {
        dropped(batch, `${bytes} bytes on pagehide, over the keepalive limit of ${KEEPALIVE_BODY_LIMIT} bytes`);
        continue;
      }
      budget.left -= bytes;
      batches.push(batch);
    }
    awaitingRetry.clear();
    for (const kind of ["events", "pings"] as const) batches.push(...unloadBatchesOf(kind, budget));
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
