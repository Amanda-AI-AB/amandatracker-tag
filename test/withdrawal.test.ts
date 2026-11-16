// The withdrawal signal (AAI-785): schema/v1/withdrawal.json, the body of POST /v1/w, which a site
// whose config turns purge on withdrawal on sends with the visitor id before the tag deletes the
// visitor's cookies; buildWithdrawal, which shapes it; and withdrawalSender, which posts it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { DEFAULT_ENDPOINT, REFERRER_POLICY } from "../src/core/endpoint";
import { withdrawalSender } from "../src/core/withdrawal";
import { buildWithdrawal } from "../src/wire/payload";
import { EVENT, PING, validator, WITHDRAWAL } from "./wire-validator";

const validate = validator("withdrawal.json");
const ID = WITHDRAWAL.visitor_id;
const URL_W = `${DEFAULT_ENDPOINT}/v1/w`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wire schema v1: withdrawal (AAI-785)", () => {
  it("accepts a withdrawal signal", () => {
    expect(validate(WITHDRAWAL), JSON.stringify(validate.errors)).toBe(true);
  });

  it("requires each of its fields, the visitor id included", () => {
    for (const field of Object.keys(WITHDRAWAL)) {
      const { [field as keyof typeof WITHDRAWAL]: _, ...rest } = WITHDRAWAL;
      expect(validate(rest), field).toBe(false);
    }
  });

  it("carries nothing about the page, the session or the consent", () => {
    for (const extra of [
      { url: EVENT.url },
      { referrer: EVENT.referrer },
      { session_id: EVENT.session_id },
      { consent: EVENT.consent },
      { type: "pageview" },
      { path: "/" },
    ]) {
      expect(validate({ ...WITHDRAWAL, ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });

  it("rejects a visitor id that isn't a UUIDv7", () => {
    expect(validate({ ...WITHDRAWAL, visitor_id: "v1.01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01" })).toBe(false);
    expect(validate({ ...WITHDRAWAL, visitor_id: "visitor@example.com" })).toBe(false);
  });

  it("rides in a Pub/Sub message, apart from events and pings", () => {
    const pubsub = validator("pubsub-message.json");
    const message = { schema_version: 1, received_at: 1_731_400_000_123, region: "europe-west1", country: "SE", device_class: "mobile" };
    expect(pubsub({ ...message, event: WITHDRAWAL }), JSON.stringify(pubsub.errors)).toBe(true);
    expect(pubsub({ ...message, event: { ...PING, visitor_id: ID } })).toBe(false);
  });

  it("never rides in a batch to /v1/e", () => {
    const batch = validator("batch.json");
    expect(batch({ seq: 1, e: [WITHDRAWAL] })).toBe(false);
    expect(batch({ e: [WITHDRAWAL] })).toBe(false);
  });
});

describe("buildWithdrawal", () => {
  it("builds a signal the schema accepts, with a fresh UUIDv7 event id", () => {
    const signal = buildWithdrawal({ tag_version: "0.2.0", site_id: "site_123", visitor_id: ID, client_ts: 1_731_400_000_000 });
    expect(validate(signal), JSON.stringify(validate.errors)).toBe(true);
    expect(signal).toMatchObject({ schema_version: 1, visitor_id: ID, site_id: "site_123", client_ts: 1_731_400_000_000 });
  });

  it("refuses a visitor id the schema refuses", () => {
    expect(() => buildWithdrawal({ tag_version: "0.2.0", site_id: "site_123", visitor_id: "nope", client_ts: 1 })).toThrow("withdrawal.visitor_id");
  });
});

describe("withdrawalSender", () => {
  function sender(answer: () => Promise<Response>) {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => answer());
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    const send = withdrawalSender(fetchFn as unknown as typeof fetch, { endpoint: DEFAULT_ENDPOINT, site: "site_123", tagVersion: "0.2.0" }, boundary, () => 1_731_400_000_000);
    return { fetchFn, reports, send };
  }

  it("posts one signal with the visitor id to /v1/w, without cookies and with keepalive", async () => {
    const s = sender(async () => new Response(null, { status: 204 }));
    s.send(ID);
    await Promise.resolve();

    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = s.fetchFn.mock.calls[0]!;
    expect(url).toBe(URL_W);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: REFERRER_POLICY, keepalive: true });
    const body = JSON.parse(init.body as string);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body).toMatchObject({ site_id: "site_123", tag_version: "0.2.0", visitor_id: ID, client_ts: 1_731_400_000_000 });
    expect(s.reports).toEqual([]);
  });

  it("reports a refusal as a tag error", async () => {
    const s = sender(async () => new Response(null, { status: 400 }));
    s.send(ID);
    await vi.waitFor(() => expect(s.reports).toHaveLength(1));
    expect(s.reports[0]).toMatchObject({ stage: "transport", name: "CollectorRefusedError" });
  });

  it("logs a 5xx and a network error, without reporting them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const answer of [async () => new Response(null, { status: 503 }), async () => Promise.reject(new TypeError("offline"))]) {
      const s = sender(answer);
      s.send(ID);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(s.reports).toEqual([]);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
