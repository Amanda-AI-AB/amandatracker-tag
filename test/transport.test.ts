import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { BatchSizeError, KEEPALIVE_BODY_LIMIT, REFERRER_POLICY } from "../src/core/endpoint";
import {
  createTransport,
  FLUSH_DELAY_MS,
  MAX_BATCH_ITEMS,
  RETRY_DELAYS_MS,
  type Transport,
  type TransportWindow,
} from "../src/core/transport";
import type { WireEvent, WirePing } from "../src/wire/generated";
import { EVENT, PING, validator } from "./wire-validator";

const ENDPOINT = "https://eu.serversider.com";
const URL_E = `${ENDPOINT}/v1/e`;
const validate = validator("batch.json");

const click = (n: number): WireEvent => ({ ...EVENT, type: "click", props: { n } }) as unknown as WireEvent;
const pageview = (): WireEvent => ({ ...EVENT }) as unknown as WireEvent;
const pingOf = (type: string): WirePing => ({ ...PING, type }) as unknown as WirePing;
/** An event of about 8 KiB as JSON: the transport sends what it is given, and doesn't check it. */
const big = (): WireEvent => ({ ...EVENT, type: "click", props: { text: "x".repeat(8 * 1024) } }) as unknown as WireEvent;

type Answer = { ok: boolean; status: number } | Error;

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
function harness(answers: Answer[] = [], options: { beacon?: boolean | "missing" } = {}): Harness {
  const queue = [...answers];
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const answer = queue.shift() ?? { ok: true, status: 204 };
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const beacon = vi.fn((_url: string, _body: string) => options.beacon !== false);
  const listeners: (() => void)[] = [];
  const win: TransportWindow = {
    fetch: fetchMock as unknown as typeof fetch,
    navigator: options.beacon === "missing" ? {} : { sendBeacon: beacon as unknown as (url: string) => boolean },
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

  it("drops a pagehide fetch that fails without retrying it, and reports a refused one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = harness([new TypeError("Failed to fetch"), { ok: false, status: 413 }], { beacon: false });
    t.transport.event(click(1));
    t.pagehide();
    t.transport.ping(pingOf("click"));
    t.pagehide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      `amanda: dropped a batch of 1 events to ${URL_E}: network error on pagehide`,
      expect.any(TypeError),
    );
    expect(t.reports).toEqual([
      { stage: "transport", name: "CollectorRefusedError", message: `POST ${URL_E}: HTTP 413, 1 pings dropped` },
    ]);
  });

  it("reports a pagehide batch over the keepalive limit instead of throwing, and still sends the others", () => {
    // Splitting the pagehide flush by size is AAI-893's: until then such a batch is reported, not sent.
    const t = harness([], { beacon: false });
    for (let n = 0; n < 9; n++) t.transport.event(big());
    for (let n = 0; n < 9; n++) t.transport.ping(pingOf("click"));
    expect(() => t.pagehide()).not.toThrow();
    expect(t.reports).toEqual([
      { stage: "transport", name: new BatchSizeError().name, message: expect.stringContaining(`over ${KEEPALIVE_BODY_LIMIT}`) },
    ]);
    expect(t.posted()).toHaveLength(1);
    expect(t.posted()[0]!.e).toHaveLength(9);
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
