import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { bodyBytes, KEEPALIVE_BODY_LIMIT, REFERRER_POLICY } from "../src/core/endpoint";
import {
  createTransport,
  FLUSH_DELAY_MS,
  MAX_BATCH_ITEMS,
  RETRY_DELAYS_MS,
  type Transport,
  type TransportWindow,
} from "../src/core/transport";
import type { WireEvent, WirePing } from "../src/wire/generated";
import { EVENT, PAGE_EXIT, PING, validator } from "./wire-validator";

const ENDPOINT = "https://eu.serversider.com";
const URL_E = `${ENDPOINT}/v1/e`;
const validate = validator("batch.json");

const click = (n: number): WireEvent => ({ ...EVENT, type: "click", props: { n } }) as unknown as WireEvent;
const pageview = (): WireEvent => ({ ...EVENT }) as unknown as WireEvent;
const pingOf = (type: string): WirePing => ({ ...PING, type }) as unknown as WirePing;
const pageExit = (): WireEvent => ({ ...PAGE_EXIT }) as unknown as WireEvent;
/** An event of about 8 KiB as JSON: the transport sends what it is given, and doesn't check it. */
const big = (): WireEvent => ({ ...EVENT, type: "click", props: { text: "x".repeat(8 * 1024) } }) as unknown as WireEvent;

/** A fetch's answer: a response, a rejection, or "pending", a request that stays in flight. */
type Answer = { ok: boolean; status: number } | Error | "pending";

interface Harness {
  transport: Transport;
  fetchMock: ReturnType<typeof vi.fn>;
  beacon: ReturnType<typeof vi.fn>;
  reports: ErrorReport[];
  pagehide(): void;
  /** The bodies posted with fetch, parsed. */
  posted(): { seq?: number; e: { type: string; props?: { n: number } }[] }[];
  inits(): RequestInit[];
}

/** A transport on a stand-in window whose fetch gives each answer in turn, then 204s. */
function harness(answers: Answer[] = [], options: { beacon?: boolean | "missing"; webdriver?: unknown } = {}): Harness {
  const queue = [...answers];
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const answer = queue.shift() ?? { ok: true, status: 204 };
    if (answer === "pending") return new Promise<never>(() => undefined);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const beacon = vi.fn((_url: string, _body: string) => options.beacon !== false);
  const listeners: (() => void)[] = [];
  const win: TransportWindow = {
    fetch: fetchMock as unknown as typeof fetch,
    navigator: {
      ...(options.beacon === "missing" ? {} : { sendBeacon: beacon as unknown as (url: string) => boolean }),
      ...("webdriver" in options ? { webdriver: options.webdriver as boolean } : {}),
    },
    setTimeout: (handler, timeout) => setTimeout(handler, timeout),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    addEventListener: (_type, listener) => listeners.push(listener),
  };
  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1, () => 0);
  const transport = createTransport(win, ENDPOINT, boundary);
  return {
    transport,
    fetchMock,
    beacon,
    reports,
    pagehide: () => listeners.forEach((listener) => listener()),
    posted: () => fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string)),
    inits: () => fetchMock.mock.calls.map((call) => call[1]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("batching", () => {
  it("sends buffered events 2 s after the first of them, as one batch", async () => {
    const t = harness();
    t.transport.event(click(1));
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS / 2);
    t.transport.event(click(2));
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS / 2 - 1);
    expect(t.fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.fetchMock.mock.calls[0]![0]).toBe(URL_E);
    expect(t.posted()[0]!.e.map((e) => e.props!.n)).toEqual([1, 2]);
    expect(validate(t.posted()[0]), JSON.stringify(validate.errors)).toBe(true);
  });

  it("sends at once on the 10th buffered event", async () => {
    const t = harness();
    for (let n = 1; n <= MAX_BATCH_ITEMS; n++) t.transport.event(click(n));
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.posted()[0]!.e).toHaveLength(MAX_BATCH_ITEMS);
    t.transport.event(click(11));
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(t.posted().map((b) => b.e.length)).toEqual([MAX_BATCH_ITEMS, 1]);
  });

  it("sends a pageview at once, with the events buffered before it, by fetch and never sendBeacon", async () => {
    const t = harness();
    t.transport.event(click(1));
    t.transport.event(pageview());
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.beacon).not.toHaveBeenCalled();
    expect(t.posted()[0]!.e.map((e) => e.type)).toEqual(["click", "pageview"]);
    // the flush stopped the 2 s timer: nothing more goes
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends ordinary batches without keepalive, events with same-origin credentials and pings with none", async () => {
    const t = harness();
    t.transport.event(pageview());
    t.transport.ping(pingOf("pageview"));
    expect(t.inits()).toEqual([
      { method: "POST", body: expect.any(String), credentials: "same-origin", referrerPolicy: REFERRER_POLICY },
      { method: "POST", body: expect.any(String), credentials: "omit", referrerPolicy: REFERRER_POLICY },
    ]);
  });

  it("sends a batch over the keepalive limit as an ordinary batch", async () => {
    const t = harness();
    for (let n = 0; n < MAX_BATCH_ITEMS; n++) t.transport.event(big());
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect((t.inits()[0]!.body as string).length).toBeGreaterThan(64 * 1024);
    expect(t.inits()[0]!.keepalive).toBeUndefined();
    expect(t.reports).toEqual([]);
  });

  it("keeps events and pings in batches of their own, and never puts seq on a ping batch", async () => {
    const t = harness();
    t.transport.event(click(1));
    t.transport.ping(pingOf("click"));
    t.transport.ping(pingOf("pageview"));
    expect(t.posted()).toEqual([{ e: [expect.objectContaining({ type: "click" }), expect.objectContaining({ type: "pageview" })] }]);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    const [pings, events] = t.posted();
    expect(pings).not.toHaveProperty("seq");
    expect(events).toMatchObject({ seq: 1 });
    for (const batch of t.posted()) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("seq", () => {
  it("numbers the page's event batches from 1, in the order they are made", async () => {
    const t = harness();
    t.transport.event(pageview());
    t.transport.event(pageview());
    t.transport.event(click(1));
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    t.transport.event(click(2));
    t.pagehide();
    expect(t.posted().map((b) => b.seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(t.beacon.mock.calls[0]![1] as string).seq).toBe(4);
  });

  it("starts again at 1 on a new page load: it lives in the transport's memory only", () => {
    const first = harness();
    first.transport.event(pageview());
    const second = harness();
    second.transport.event(pageview());
    expect(first.posted()[0]!.seq).toBe(1);
    expect(second.posted()[0]!.seq).toBe(1);
  });
});

describe("webdriver (AAI-796)", () => {
  it("puts webdriver: true on every event batch when navigator.webdriver is true, by fetch and by beacon", () => {
    const t = harness([], { webdriver: true });
    t.transport.event(pageview());
    t.transport.event(click(1));
    t.pagehide();
    const beaconed = JSON.parse(t.beacon.mock.calls[0]![1] as string);
    expect(t.posted()[0]).toMatchObject({ seq: 1, webdriver: true });
    expect(beaconed).toMatchObject({ seq: 2, webdriver: true });
    for (const batch of [...t.posted(), beaconed]) expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["false", false],
    ["missing", undefined],
    ["not a boolean", "true"],
  ])("leaves webdriver out when navigator.webdriver is %s", (_name, value) => {
    const t = harness([], value === undefined ? {} : { webdriver: value });
    t.transport.event(pageview());
    expect(t.posted()[0]).not.toHaveProperty("webdriver");
    expect(validate(t.posted()[0]), JSON.stringify(validate.errors)).toBe(true);
  });

  it("never puts webdriver on a ping batch", async () => {
    const t = harness([], { webdriver: true });
    t.transport.ping(pingOf("pageview"));
    expect(t.posted()[0]).not.toHaveProperty("webdriver");
    expect(validate(t.posted()[0]), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("retries", () => {
  it("retries a batch twice on a network error or a 5xx, with backoff and the same seq, then drops it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness([new TypeError("Failed to fetch"), { ok: false, status: 503 }, { ok: false, status: 502 }]);
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]! - 1);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(3);

    expect(new Set(t.inits().map((init) => init.body)).size).toBe(1);
    expect(t.posted().map((b) => b.seq)).toEqual([1, 1, 1]);
    expect(warn).toHaveBeenCalledWith(`amanda: dropped a batch of 1 events to ${URL_E}: HTTP 502, after 3 tries`);
    expect(t.reports).toEqual([]);
    // the next batch takes the next seq: the dropped one shows as a gap
    t.transport.event(pageview());
    expect(t.posted()[3]!.seq).toBe(2);
  });

  it("stops retrying once a retry succeeds", async () => {
    const t = harness([{ ok: false, status: 500 }]);
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a batch the collector refuses, and reports it", async () => {
    const t = harness([{ ok: false, status: 400 }]);
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.reports).toEqual([
      { stage: "transport", name: "CollectorRefusedError", message: `POST ${URL_E}: HTTP 400, 1 events dropped` },
    ]);
  });

  it("reports a rejection that isn't a network error, and doesn't retry it", async () => {
    const t = harness([new RangeError("bad")]);
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.reports).toEqual([{ stage: "transport", name: "RangeError", message: "bad" }]);
  });
});

describe("pagehide", () => {
  it("sends buffered events with sendBeacon, at once", () => {
    const t = harness();
    t.transport.event(click(1));
    t.transport.event(click(2));
    t.pagehide();
    expect(t.fetchMock).not.toHaveBeenCalled();
    expect(t.beacon).toHaveBeenCalledTimes(1);
    const [url, body] = t.beacon.mock.calls[0]!;
    expect(url).toBe(URL_E);
    const batch = JSON.parse(body as string);
    expect(batch).toMatchObject({ seq: 1 });
    expect(batch.e).toHaveLength(2);
    expect(validate(batch)).toBe(true);
  });

  it("falls back to a keepalive fetch when sendBeacon refuses the batch or is missing", () => {
    for (const beacon of [false, "missing"] as const) {
      const t = harness([], { beacon });
      t.transport.event(click(1));
      t.pagehide();
      expect(t.fetchMock).toHaveBeenCalledTimes(1);
      expect(t.inits()[0]).toEqual({
        method: "POST",
        body: expect.any(String),
        credentials: "same-origin",
        referrerPolicy: REFERRER_POLICY,
        keepalive: true,
      });
      expect(t.posted()[0]).toMatchObject({ seq: 1 });
    }
  });

  it("sends pings with a keepalive fetch without credentials, never with sendBeacon, which sends cookies", () => {
    const t = harness();
    t.transport.ping(pingOf("click"));
    t.pagehide();
    expect(t.beacon).not.toHaveBeenCalled();
    expect(t.inits()[0]).toMatchObject({ credentials: "omit", keepalive: true });
    expect(t.posted()[0]).not.toHaveProperty("seq");
  });

  it("sends a batch awaiting its retry at once, with its seq, and never retries it again", async () => {
    const t = harness([{ ok: false, status: 503 }]);
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(0);
    t.transport.event(click(1));
    t.pagehide();
    expect(t.beacon.mock.calls.map((call) => JSON.parse(call[1] as string).seq)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops the 2 s timer: a flushed event isn't sent twice", async () => {
    const t = harness();
    t.transport.event(click(1));
    t.pagehide();
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(t.beacon).toHaveBeenCalledTimes(1);
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when nothing is buffered, and keeps working after the page comes back from the bfcache", async () => {
    const t = harness();
    t.pagehide();
    expect(t.beacon).not.toHaveBeenCalled();
    t.transport.event(pageview());
    expect(t.posted()[0]).toMatchObject({ seq: 1 });
  });

  it("drops a pagehide fetch that fails with and without keepalive, without a timed retry, and reports a refused one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness(
      [new TypeError("Failed to fetch"), { ok: false, status: 413 }, new TypeError("Failed to fetch")],
      { beacon: false },
    );
    t.transport.event(click(1));
    t.pagehide();
    t.transport.ping(pingOf("click"));
    t.pagehide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(3);
    expect(t.inits()[2]).not.toHaveProperty("keepalive");
    expect(warn).toHaveBeenCalledWith(
      `amanda: dropped a batch of 1 events to ${URL_E}: network error on pagehide, without keepalive`,
      expect.any(TypeError),
    );
    expect(t.reports).toEqual([
      { stage: "transport", name: "CollectorRefusedError", message: `POST ${URL_E}: HTTP 413, 1 pings dropped` },
    ]);
  });

});

describe("pagehide split by size (AAI-893)", () => {
  const bytesOf = (body: unknown): number => bodyBytes(body as string);
  const beaconed = (t: Harness): string[] => t.beacon.mock.calls.map((call) => call[1] as string);
  const fetched = (t: Harness): string[] => t.inits().map((init) => init.body as string);

  it("splits a keepalive fetch flush into bodies within the limit together, each with its own seq, and drops what doesn't fit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness([{ ok: false, status: 503 }], { beacon: false });
    // A batch of 3 big events (about 9.7 KiB each as JSON) awaits its retry, and 6 more are
    // buffered: about 87 KiB in all, of which 6 events fit in 60 KiB.
    for (let n = 0; n < 3; n++) t.transport.event(big());
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    for (let n = 0; n < 6; n++) t.transport.event(big());
    expect(() => t.pagehide()).not.toThrow();

    const bodies = fetched(t).slice(1);
    expect(bodies.length).toBe(2);
    expect(bodies.reduce((sum, body) => sum + bytesOf(body), 0)).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT);
    for (const init of t.inits().slice(1)) expect(init.keepalive).toBe(true);
    const batches = bodies.map((body) => JSON.parse(body));
    // The retry keeps its seq 1; 3 buffered events fit in a body with seq 2; the 3 left take seq 3.
    expect(batches.map((b) => [b.seq, b.e.length])).toEqual([
      [1, 3],
      [2, 3],
    ]);
    expect(warn).toHaveBeenCalledWith(
      `amanda: dropped 3 events to ${URL_E} on pagehide: over the keepalive limit of ${KEEPALIVE_BODY_LIMIT} bytes`,
    );
    expect(t.reports).toEqual([]);
    // After the bfcache, the next batch shows the dropped one as a gap.
    t.transport.event(pageview());
    expect(t.posted().at(-1)).toMatchObject({ seq: 4 });
  });

  it("drops an event too big on its own, without throwing, and still sends the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const huge = { ...EVENT, type: "click", props: { text: "x".repeat(KEEPALIVE_BODY_LIMIT) } } as unknown as WireEvent;
    const t = harness([], { beacon: false });
    t.transport.event(click(1));
    t.transport.event(huge);
    t.transport.event(click(2));
    expect(() => t.pagehide()).not.toThrow();
    expect(t.posted().map((b) => [b.seq, b.e.map((e) => e.props!.n)])).toEqual([
      [1, [1]],
      [3, [2]],
    ]);
    expect(warn).toHaveBeenCalledWith(
      `amanda: dropped 1 events to ${URL_E} on pagehide: over the keepalive limit of ${KEEPALIVE_BODY_LIMIT} bytes`,
    );
    expect(t.reports).toEqual([]);
  });

  it("splits sendBeacon bodies the same way", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness();
    for (let n = 0; n < 9; n++) t.transport.event(big());
    t.pagehide();
    expect(t.fetchMock).not.toHaveBeenCalled();
    const bodies = beaconed(t);
    expect(bodies.reduce((sum, body) => sum + bytesOf(body), 0)).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT);
    expect(bodies.map((body) => JSON.parse(body).seq)).toEqual([1]);
    expect(JSON.parse(bodies[0]!).e.length).toBe(6);
  });

  it("splits pings by size too, without seq", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bigPing = { ...PING, type: "click", page_path: `/${"p".repeat(20 * 1024)}` } as unknown as WirePing;
    const t = harness();
    for (let n = 0; n < 4; n++) t.transport.ping(bigPing);
    t.pagehide();
    const bodies = fetched(t);
    expect(bodies.reduce((sum, body) => sum + bytesOf(body), 0)).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT);
    expect(bodies.map((body) => JSON.parse(body).e.length)).toEqual([2]);
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("seq");
  });

  it("counts the tag's keepalive fetches still in flight against the next flush", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness(["pending"], { beacon: false });
    // A page_exit flush of 5 big events (about 48 KiB) stays in flight...
    for (let n = 0; n < 4; n++) t.transport.event(big());
    t.transport.event({ ...(big() as object), type: "page_exit", engagement_ms: 1 } as unknown as WireEvent);
    // ...so the pagehide flush has about 12 KiB left: 1 of 4 big events.
    for (let n = 0; n < 4; n++) t.transport.event(big());
    t.pagehide();
    const bodies = fetched(t);
    expect(bodies.reduce((sum, body) => sum + bytesOf(body), 0)).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT);
    expect(bodies.map((body) => JSON.parse(body).e.length)).toEqual([5, 1]);
  });

  it("frees a keepalive fetch's share once it settles", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness([], { beacon: false });
    for (let n = 0; n < 6; n++) t.transport.event(big());
    t.pagehide();
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 0; n < 6; n++) t.transport.event(big());
    t.pagehide();
    expect(t.posted().map((b) => b.e.length)).toEqual([6, 6]);
  });

  it("drops a batch awaiting its retry whose body is over the limit, instead of resending it with keepalive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness([{ ok: false, status: 503 }]);
    for (let n = 0; n < MAX_BATCH_ITEMS; n++) t.transport.event(big());
    await vi.advanceTimersByTimeAsync(0);
    t.pagehide();
    expect(t.beacon).not.toHaveBeenCalled();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^amanda: dropped a batch of 10 events to .*over the keepalive limit/));
    expect(t.reports).toEqual([]);
  });

  it("never resends a pagehide body that fetch rejected with keepalive, for its size or the network", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const quota = new TypeError("keepalive quota exceeded");
    const t = harness([quota, quota], { beacon: false });
    t.transport.event(big());
    t.transport.event(big());
    t.pagehide();
    await vi.advanceTimersByTimeAsync(60_000);
    t.pagehide();
    await vi.advanceTimersByTimeAsync(60_000);
    // The rejected body of 2 events, then its halves: the first rejected too, and resent once without keepalive.
    expect(t.inits().map((init) => [JSON.parse(init.body as string).e.length, init.keepalive])).toEqual([
      [2, true],
      [1, true],
      [1, true],
      [1, undefined],
    ]);
  });

  it("never retries an ordinary batch the collector refused for its size", async () => {
    const t = harness([{ ok: false, status: 413 }]);
    for (let n = 0; n < MAX_BATCH_ITEMS; n++) t.transport.event(big());
    await vi.advanceTimersByTimeAsync(60_000);
    t.pagehide();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.beacon).not.toHaveBeenCalled();
    expect(t.reports).toEqual([
      { stage: "transport", name: "CollectorRefusedError", message: `POST ${URL_E}: HTTP 413, 10 events dropped` },
    ]);
  });
});

describe("pagehide recovery from the shared keepalive quota (AAI-951)", () => {
  /** The Fetch spec's keepalive quota: every in-flight keepalive body of the document together. */
  const QUOTA = 64 * 1024;
  /** A third-party tag's beacon, already in flight when the page is hidden. */
  const THIRD_PARTY_BYTES = 8 * 1024;

  interface Sent {
    via: "beacon" | "fetch";
    keepalive: boolean;
    body: { seq?: number; e: unknown[] };
  }

  /**
   * A transport on a stand-in window whose sendBeacon and keepalive fetch share one 64 KiB quota
   * with a pending 8 KiB third-party request: one that would go over is refused (sendBeacon) or
   * rejected with a TypeError before sending (fetch), and one within it stays in flight. A fetch
   * without keepalive always gets a 204. `sent` lists what was sent, not what was refused.
   */
  function quotaHarness(options: { beacon?: boolean; reject?: (init: RequestInit) => Error | undefined } = {}) {
    let inFlight = THIRD_PARTY_BYTES;
    const sent: Sent[] = [];
    const take = (body: string): boolean => {
      const bytes = bodyBytes(body);
      if (inFlight + bytes > QUOTA) return false;
      inFlight += bytes;
      return true;
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const error = options.reject?.(init);
      if (error !== undefined) throw error;
      const body = init.body as string;
      if (init.keepalive === true) {
        if (!take(body)) throw new TypeError("Failed to fetch: keepalive quota exceeded");
        sent.push({ via: "fetch", keepalive: true, body: JSON.parse(body) });
        return new Promise<never>(() => undefined);
      }
      sent.push({ via: "fetch", keepalive: false, body: JSON.parse(body) });
      return { ok: true, status: 204 };
    });
    const beacon = vi.fn((_url: string, body: string) => {
      if (!take(body)) return false;
      sent.push({ via: "beacon", keepalive: true, body: JSON.parse(body) });
      return true;
    });
    const listeners: (() => void)[] = [];
    const win: TransportWindow = {
      fetch: fetchMock as unknown as typeof fetch,
      navigator: options.beacon === false ? {} : { sendBeacon: beacon as unknown as (url: string) => boolean },
      setTimeout: (handler, timeout) => setTimeout(handler, timeout),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      addEventListener: (_type, listener) => listeners.push(listener),
    };
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1, () => 0);
    const transport = createTransport(win, ENDPOINT, boundary);
    return { transport, fetchMock, sent, reports, pagehide: () => listeners.forEach((listener) => listener()) };
  }

  /** 6 events of about 9.6 KiB: a body within KEEPALIVE_BODY_LIMIT, but not beside the third party's 8 KiB. */
  const sixBigEvents = Array.from(
    { length: 6 },
    (_, n) => ({ ...EVENT, type: "click", props: { n, text: "x".repeat(9 * 1024) } }) as unknown as WireEvent,
  );
  const sixBig = (transport: Transport): void => sixBigEvents.forEach((event) => transport.event(event));

  it("is set up as the ticket says: the tag's body is within its limit, but not with the third party's", () => {
    const bytes = bodyBytes(JSON.stringify({ seq: 1, e: sixBigEvents }));
    expect(bytes).toBeLessThanOrEqual(KEEPALIVE_BODY_LIMIT);
    expect(bytes + THIRD_PARTY_BYTES).toBeGreaterThan(QUOTA);
  });
  const delivered = (sent: Sent[]): number[] =>
    sent.flatMap((s) => s.body.e.map((e) => (e as { props: { n: number } }).props.n)).sort();

  it("delivers a keepalive fetch's events in halves, and the half still rejected without keepalive", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = quotaHarness({ beacon: false });
    sixBig(t.transport);
    expect(() => t.pagehide()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(delivered(t.sent)).toEqual([0, 1, 2, 3, 4, 5]);
    // The 58 KiB body (seq 1) was rejected; its first half fits beside the third party, the second
    // doesn't, and goes without keepalive.
    expect(t.sent.map((s) => [s.body.seq, s.body.e.length, s.keepalive])).toEqual([
      [2, 3, true],
      [3, 3, false],
    ]);
    expect(t.reports).toEqual([]);
  });

  it("recovers a batch that sendBeacon refused and the keepalive fetch rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = quotaHarness();
    sixBig(t.transport);
    t.pagehide();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered(t.sent)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(t.sent.map((s) => [s.via, s.keepalive])).toEqual([
      ["fetch", true],
      ["fetch", false],
    ]);
  });

  it("recovers pings the same way, without seq and without credentials", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bigPing = { ...PING, type: "click", page_path: `/${"p".repeat(19 * 1024)}` } as unknown as WirePing;
    const t = quotaHarness();
    for (let n = 0; n < 3; n++) t.transport.ping(bigPing);
    t.pagehide();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((s) => s.body.e.length).reduce((a, b) => a + b, 0)).toBe(3);
    for (const s of t.sent) expect(s.body).not.toHaveProperty("seq");
    for (const init of t.fetchMock.mock.calls.map((call) => call[1])) expect(init.credentials).toBe("omit");
  });

  it("drops what is still rejected without keepalive, with a warning, and leaves its seq as a gap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = quotaHarness({
      beacon: false,
      reject: (init) => (init.keepalive === true ? undefined : new TypeError("Failed to fetch")),
    });
    sixBig(t.transport);
    expect(() => t.pagehide()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.sent.map((s) => s.body.seq)).toEqual([2]);
    expect(warn).toHaveBeenCalledWith(
      `amanda: dropped a batch of 3 events to ${URL_E}: network error on pagehide, without keepalive`,
      expect.any(TypeError),
    );
    expect(t.reports).toEqual([]);
    // Back from the bfcache, the next batch takes seq 4: seq 1 and 3 are the collector's gaps.
    t.transport.event(pageview());
    expect(JSON.parse(t.fetchMock.mock.calls.at(-1)![1].body as string)).toMatchObject({ seq: 4 });
  });

  it("reports a rejection that isn't a TypeError, and doesn't recover it", async () => {
    const t = quotaHarness({ beacon: false, reject: () => new RangeError("not a network error") });
    sixBig(t.transport);
    expect(() => t.pagehide()).not.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.reports).toEqual([{ stage: "transport", name: "RangeError", message: "not a network error" }]);
  });
});

describe("page_exit (AAI-105)", () => {
  it("sends a page_exit at once with sendBeacon, with the events buffered before it, as pagehide does", async () => {
    const t = harness();
    t.transport.event(click(1));
    t.transport.event(pageExit());
    expect(t.fetchMock).not.toHaveBeenCalled();
    expect(t.beacon).toHaveBeenCalledTimes(1);
    const [url, body] = t.beacon.mock.calls[0]!;
    expect(url).toBe(URL_E);
    const batch = JSON.parse(body as string);
    expect(batch).toMatchObject({ seq: 1, e: [{ type: "click" }, { type: "page_exit", engagement_ms: 42_500 }] });
    expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    // The 2 s timer is stopped: nothing goes twice.
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(t.beacon).toHaveBeenCalledTimes(1);
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it("sends a batch awaiting its retry with it, and the buffered pings by keepalive fetch", async () => {
    const t = harness([{ ok: false, status: 503 }]);
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(0);
    t.transport.ping(pingOf("click"));
    t.transport.event(pageExit());
    expect(t.beacon.mock.calls.map((call) => JSON.parse(call[1] as string).seq)).toEqual([1, 2]);
    expect(t.inits()[1]).toMatchObject({ credentials: "omit", keepalive: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a keepalive fetch when sendBeacon refuses it, and keeps working after the page is shown again", () => {
    const t = harness([], { beacon: false });
    t.transport.event(pageExit());
    expect(t.inits()[0]).toMatchObject({ credentials: "same-origin", keepalive: true });
    expect(t.posted()[0]).toMatchObject({ seq: 1, e: [{ type: "page_exit" }] });
    t.transport.event(pageview());
    expect(t.posted()[1]).toMatchObject({ seq: 2, e: [{ type: "pageview" }] });
    expect(t.inits()[1]).not.toHaveProperty("keepalive");
  });

  it("never puts more than 10 events in its batch", () => {
    const t = harness();
    for (let n = 1; n <= MAX_BATCH_ITEMS + 3; n++) t.transport.event(click(n));
    t.transport.event(pageExit());
    const batch = JSON.parse(t.beacon.mock.calls[0]![1] as string);
    expect(batch.e.length).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
    expect(validate(batch)).toBe(true);
  });
});

describe("withdrawEvents", () => {
  it("drops the buffered events and stops their timer, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness();
    t.transport.event(click(1));
    t.transport.event(click(2));
    t.transport.withdrawEvents();
    await vi.advanceTimersByTimeAsync(60_000);
    t.pagehide();
    expect(t.fetchMock).not.toHaveBeenCalled();
    expect(t.beacon).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("amanda: dropped 2 buffered events: the visitor declined");
  });

  it("drops an event batch awaiting its retry: it is neither retried nor sent on pagehide", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness([{ ok: false, status: 503 }]);
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(0);
    t.transport.withdrawEvents();
    await vi.advanceTimersByTimeAsync(60_000);
    t.pagehide();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.beacon).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(`amanda: dropped a batch of 1 events to ${URL_E}: the visitor declined`);
    expect(t.reports).toEqual([]);
  });

  it("keeps pings, buffered or awaiting a retry, and the events that come after", async () => {
    const t = harness([{ ok: false, status: 503 }]);
    t.transport.ping(pingOf("pageview"));
    await vi.advanceTimersByTimeAsync(0);
    t.transport.ping(pingOf("click"));
    t.transport.withdrawEvents();
    t.transport.event(pageview());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.posted().map((batch) => batch.e.map((item) => item.type))).toEqual([["pageview"], ["pageview"], ["pageview"], ["click"]]);
    expect(t.posted()[1]).toMatchObject({ seq: 1 });
  });

  it("warns about nothing when nothing waits", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    harness().transport.withdrawEvents();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("storage", () => {
  it("never touches localStorage, IndexedDB or cookies", () => {
    const touched: string[] = [];
    const names = ["localStorage", "sessionStorage", "indexedDB", "document"];
    const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    for (const name of names) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get: () => {
          touched.push(name);
          return undefined;
        },
      });
    }
    try {
      const t = harness([], { beacon: false });
      t.transport.event(click(1));
      t.transport.ping(pingOf("click"));
      t.pagehide();
    } finally {
      names.forEach((name, i) => {
        const descriptor = saved[i];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      });
    }
    expect(touched).toEqual([]);
  });
});
