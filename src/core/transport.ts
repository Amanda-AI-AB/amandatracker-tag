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
// An event batch already in flight then can't be called back, and behind a first-party proxy its
// response may carry the collector's Set-Cookie for the ids it holds (AAI-827), which the browser
// stores after the withdrawal deleted them: so once such a batch's fetch settles, its events go to
// the transport's afterWithdrawn option, which deletes them again (AAI-1128).
//
// Everything lives in memory: no cookie, localStorage or IndexedDB, so a visitor who declined
// accrues no storage, and what the page hasn't sent when it dies is lost. Loss is measured
// instead: each event batch carries seq, the page's batch counter, whose gaps the collector reads
// as lost batches (AAI-106), and page_id, a random UUIDv4 made once per pageload, and a new one when
// consent is granted again after a withdrawal (newPage, AAI-1156), which links the page's batches to
// each other. A ping batch carries neither (schema/v1/batch.json).
// An event batch from a browser that reports navigator.webdriver === true carries webdriver: true,
// for the collector's bot marking (AAI-76); a ping batch never does.

import type { EventBatch, PingBatch, WireEvent, WirePing } from "../wire/generated";
import { uuidv4 } from "../wire/payload";
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

export interface TransportOptions {
  /**
   * Called with the events of an event batch the visitor withdrew while its fetch was in flight,
   * once that fetch settles, however it settles: its response may have set the cookies again
   * (AAI-1128). It runs inside the boundary, before the batch's outcome is handled.
   */
  readonly afterWithdrawn?: (events: readonly WireEvent[]) => void;
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
   * that none goes after the decline, with a warning saying how many. Pings are left as they are.
   * An event batch whose fetch is already in flight can't be called back, but it is never sent
   * again: a 5xx or a network error drops it with a warning rather than retrying it (AAI-1206),
   * and a rejected pagehide fetch isn't recovered (split and sent again) (AAI-1204). Once its fetch
   * settles, its events go to the afterWithdrawn option (AAI-1128).
   */
  withdrawEvents(): void;
  /**
   * Starts a new page key: a fresh page_id, and seq again from 1, so that the event batches sent
   * from now on can't be joined to those sent before, and each key's seq stays gapless. Called
   * when consent is granted again after a withdrawal, with the fresh ids identity.renew() mints
   * (AAI-1156). A batch built before keeps the body it was built with, through every retry, and
   * the halves of its pagehide recovery keep its page_id, with seqs from its key (AAI-1204).
   */
  newPage(): void;
}

type Item = WireEvent | WirePing;

/**
 * A pagehide fetch's step: the first, with keepalive; a half of a rejected batch, with keepalive;
 * or the last, without it.
 */
type UnloadStep = "keepalive" | "split" | "plain";

/** A page key: the page_id event batches carry, and the seq counter of the batches under it. */
interface PageKey {
  readonly id: string;
  /** The seq of the last event batch built under this key. */
  seq: number;
}

/** One batch as sent: its body keeps its seq through every retry. */
interface Batch {
  readonly kind: BatchKind;
  readonly body: string;
  /** The items in body, which a rejected pagehide fetch splits into smaller batches. */
  readonly items: readonly Item[];
  /** The page key it was built under, which the halves of a split take too (AAI-1204). */
  readonly page: PageKey;
  /** The tries made so far. */
  tries: number;
  /** The pending retry's timer, while the batch awaits one. */
  timer?: unknown;
  /**
   * The visitor declined while its fetch was in flight: it isn't retried (AAI-1206), nor recovered
   * on pagehide (AAI-1204).
   */
  withdrawn?: boolean;
}

/**
 * The transport to endpoint's /v1/e. It listens for pagehide on win; its timers, responses and
 * pagehide flush run inside the boundary, as stage "transport", so nothing it does throws into
 * the page. A batch the collector refuses (a status other than 2xx or 5xx) is reported, as is any
 * failure inside a flush. A batch dropped after its retries, or on pagehide, is logged with
 * console.warn: a network failure isn't the tag's, and seq's gap counts the lost events.
 */
export function createTransport(
  win: TransportWindow,
  endpoint: string,
  boundary: ErrorBoundary,
  options: TransportOptions = {},
): Transport {
  const url = eventsUrl(endpoint);
  const buffers: { events: WireEvent[]; pings: WirePing[] } = { events: [], pings: [] };
  const awaitingRetry = new Set<Batch>();
  const flushTimers: Record<BatchKind, unknown> = { events: undefined, pings: undefined };
  /**
   * The pageload's key, on every event batch: one transport serves one pageload, and newPage
   * starts a new key when consent is granted again after a withdrawal.
   */
  let page: PageKey = { id: uuidv4(), seq: 0 };
  /** The event batches whose fetch is in flight, ordinary or on pagehide, which withdrawEvents marks. */
  const inFlight = new Set<Batch>();
  /** The UTF-8 bytes of the tag's own keepalive fetches still in flight. */
  let keepaliveInFlight = 0;
  // Only a strict true marks the browser as automated: a missing or odd value sends nothing.
  const webdriver = win.navigator.webdriver === true;

  /** The body of a batch of `items` under `key`; `batchSeq` is the seq an event batch carries. */
  const bodyOf = (kind: BatchKind, items: readonly Item[], key: PageKey, batchSeq: number): string => {
    if (kind === "pings") return JSON.stringify({ e: items } as PingBatch);
    const batch: EventBatch = { seq: batchSeq, page_id: key.id, e: items as EventBatch["e"] };
    if (webdriver) batch.webdriver = true;
    return JSON.stringify(batch);
  };

  /** A new batch of `items` under `key`, the current page key unless given; an event batch takes its next seq. */
  const newBatch = (kind: BatchKind, items: readonly Item[], key: PageKey = page): Batch => ({
    kind,
    body: bodyOf(kind, items, key, kind === "events" ? ++key.seq : 0),
    items,
    page: key,
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
    const key = page;
    const batches: Batch[] = [];
    let chunk: Item[] = [];
    let body = "";
    let lost = 0;
    let inGap = false;
    // Bodies are built with seq + 1, the seq they take when closed.
    const close = (): void => {
      if (chunk.length === 0) return;
      if (kind === "events") key.seq++;
      batches.push({ kind, body, items: chunk, page: key, tries: 0 });
      budget.left -= bodyBytes(body);
      chunk = [];
    };
    for (const item of items) {
      if (chunk.length < MAX_BATCH_ITEMS) {
        const grown = bodyOf(kind, [...chunk, item], key, key.seq + 1);
        if (bodyBytes(grown) <= budget.left) {
          chunk.push(item);
          body = grown;
          inGap = false;
          continue;
        }
      }
      close();
      const alone = bodyOf(kind, [item], key, key.seq + 1);
      if (bodyBytes(alone) <= budget.left) {
        chunk = [item];
        body = alone;
        inGap = false;
        continue;
      }
      if (!inGap && kind === "events") key.seq++;
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

  /**
   * A batch's fetch settled: it is no longer in flight, and an event batch the visitor withdrew
   * meanwhile goes to afterWithdrawn, whose failure is reported without stopping the batch's own
   * outcome.
   */
  const settled = (batch: Batch): void => {
    inFlight.delete(batch);
    const afterWithdrawn = options.afterWithdrawn;
    if (batch.withdrawn !== true || afterWithdrawn === undefined) return;
    boundary.guard("transport", () => afterWithdrawn(batch.items as readonly WireEvent[]));
  };

  const retryOrDrop = (batch: Batch, why: string, error?: unknown): void => {
    if (batch.withdrawn === true) return dropped(batch, `${why}, and the visitor declined since`, error);
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
    if (batch.kind === "events") inFlight.add(batch);
    const sent = win.fetch(url, batchRequestInit(batch.body, batch.kind)).then(
      (response) => {
        settled(batch);
        if (response.ok) return;
        if (response.status >= 500) return retryOrDrop(batch, `HTTP ${response.status}`);
        refused(batch, response.status);
      },
      (error: unknown) => {
        settled(batch);
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
    if (batch.kind === "events") inFlight.add(batch);
    const sent = win.fetch(url, init).then(
      (response) => {
        keepaliveInFlight -= bytes;
        settled(batch);
        if (response.ok) return;
        if (response.status >= 500) return dropped(batch, `HTTP ${response.status} on pagehide`);
        refused(batch, response.status);
      },
      (error: unknown) => {
        keepaliveInFlight -= bytes;
        settled(batch);
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
   * The halves are built under the rejected batch's page key, never a newer one (AAI-1204), and an
   * event batch the visitor withdrew while it was in flight is dropped rather than sent again.
   */
  const recoverOnUnload = (batch: Batch, step: UnloadStep, error: TypeError): void => {
    if (batch.withdrawn === true) return dropped(batch, "network error on pagehide, and the visitor declined since", error);
    if (step === "plain") return dropped(batch, "network error on pagehide, without keepalive", error);
    if (step === "split" || batch.items.length === 1) return sendOnUnload(batch, "plain");
    const half = Math.ceil(batch.items.length / 2);
    for (const items of [batch.items.slice(0, half), batch.items.slice(half)]) {
      // Each half on its own: one that fails is reported, and the other still goes.
      boundary.guard("transport", () => sendOnUnload(newBatch(batch.kind, items, batch.page), "split"));
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
      for (const batch of inFlight) batch.withdrawn = true;
    },
    newPage() {
      page = { id: uuidv4(), seq: 0 };
    },
  };
}
