// The visitor's identity (AAI-98): _amnda_id and _amnda_ses, written only under granted consent,
// on the site's registrable domain with the specified attributes and lifetimes, and deleted at once
// on withdrawal. The page's cookies are a CookieJar, which keeps them as a browser does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsent } from "../src/core/consent";
import {
  candidateDomains,
  createIdentity,
  parseSession,
  parseVisitor,
  readCookie,
  SESSION_COOKIE,
  SESSION_TIMEOUT_MS,
  VISITOR_COOKIE,
  VISITOR_MAX_AGE_S,
  type Identity,
  type Ids,
} from "../src/core/identity";
import { TRACKED_EVENT_PATTERN } from "../src/wire/generated";
import { CookieJar } from "./cookie-jar";

const UUID7 = new RegExp(TRACKED_EVENT_PATTERN.visitor_id);
const START = Date.UTC(2026, 10, 14, 10, 0, 0);
const MINUTE = 60_000;

let clock: number;

/** A page on url whose cookies are a jar, and the identity on it. */
function page(url = "https://shop.example.com/products", https = true): { jar: CookieJar; identity: Identity } {
  clock = START;
  const hostname = new URL(url).hostname;
  const jar = new CookieJar(hostname, () => clock, https);
  const identity = createIdentity({ document: jar, location: { href: url } }, { now: () => clock });
  return { jar, identity };
}

function value(jar: CookieJar, name: string): string | undefined {
  return readCookie(jar.cookie, name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("candidateDomains", () => {
  it.each([
    ["shop.example.com", ["example.com", "shop.example.com"]],
    ["example.com", ["example.com"]],
    ["www.shop.example.co.uk", ["co.uk", "example.co.uk", "shop.example.co.uk", "www.shop.example.co.uk"]],
    ["Shop.Example.COM.", ["example.com", "shop.example.com"]],
    ["localhost", [undefined]],
    ["192.168.0.10", [undefined]],
    ["[::1]", [undefined]],
  ] as const)("%s: %j", (hostname, domains) => {
    expect(candidateDomains(hostname)).toEqual(domains);
  });
});

describe("cookie values", () => {
  const ID = "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01";

  it("reads v1.<uuid> and v1.<uuid>.<ts>", () => {
    expect(parseVisitor(`v1.${ID}`)).toBe(ID);
    expect(parseSession(`v1.${ID}.1763114400000`)).toEqual({ id: ID, lastActivity: 1763114400000 });
  });

  it.each([undefined, "", ID, `v2.${ID}`, "v1.not-a-uuid", `v1.${ID.toUpperCase()}`, `v1.${ID}.1`])(
    "refuses %j as a visitor",
    (raw) => expect(parseVisitor(raw)).toBeUndefined(),
  );

  it.each([undefined, `v1.${ID}`, `v1.${ID}.`, `v1.${ID}.-1`, `v1.${ID}.1e3`, `v2.${ID}.1`, `v1.nope.1`])(
    "refuses %j as a session",
    (raw) => expect(parseSession(raw)).toBeUndefined(),
  );

  it("finds a cookie among others", () => {
    expect(readCookie("a=1; _amnda_id=v1.x; b=2", "_amnda_id")).toBe("v1.x");
    expect(readCookie("x_amnda_id=1", "_amnda_id")).toBeUndefined();
    expect(readCookie("", "_amnda_id")).toBeUndefined();
  });
});

describe("identity under granted consent", () => {
  it("writes nothing until it is asked for the ids", () => {
    const { jar } = page();
    expect(jar.writes).toEqual([]);
  });

  it("mints random UUIDv7 ids and stores them on the registrable domain with the specified attributes", () => {
    const { jar, identity } = page();
    const ids = identity.ids();

    expect(ids.visitorId).toMatch(UUID7);
    expect(ids.sessionId).toMatch(UUID7);
    expect(ids.visitorId).not.toBe(ids.sessionId);
    expect(jar.live().map(({ expires, ...c }) => ({ ...c, lifetime: expires - clock }))).toEqual([
      {
        name: VISITOR_COOKIE,
        value: `v1.${ids.visitorId}`,
        domain: "example.com",
        path: "/",
        secure: true,
        sameSite: "Lax",
        lifetime: 395 * 24 * 60 * MINUTE,
      },
      {
        name: SESSION_COOKIE,
        value: `v1.${ids.sessionId}.${START}`,
        domain: "example.com",
        path: "/",
        secure: true,
        sameSite: "Lax",
        lifetime: 30 * MINUTE,
      },
    ]);
    expect(jar.writes).toContain(
      `_amnda_id=v1.${ids.visitorId}; Max-Age=${VISITOR_MAX_AGE_S}; Domain=.example.com; Path=/; SameSite=Lax; Secure`,
    );
    expect(jar.writes).toContain(
      `_amnda_ses=v1.${ids.sessionId}.${START}; Max-Age=1800; Domain=.example.com; Path=/; SameSite=Lax; Secure`,
    );
  });

  it("keeps a 13-month visitor lifetime, under the 400 days browsers cap a cookie at", () => {
    expect(VISITOR_MAX_AGE_S / 86_400).toBe(395);
    expect(SESSION_TIMEOUT_MS).toBe(30 * MINUTE);
  });

  it("skips a public suffix: a .co.uk site's cookies go on its own registrable domain", () => {
    const { jar, identity } = page("https://www.shop.example.co.uk/");
    identity.ids();
    expect(jar.live().map((c) => c.domain)).toEqual(["example.co.uk", "example.co.uk"]);
  });

  it("probes the domain once per page and leaves no probe cookie", () => {
    const { jar, identity } = page();
    identity.ids();
    identity.ids();
    expect(jar.writes.filter((w) => w.startsWith("_amnda_probe=") && !w.includes("Max-Age=0"))).toHaveLength(1);
    expect(value(jar, "_amnda_probe")).toBeUndefined();
  });

  it("keeps a host-only cookie on localhost and an IP address", () => {
    for (const url of ["https://localhost:8080/", "https://192.168.0.10/"]) {
      const { jar, identity } = page(url);
      identity.ids();
      expect(jar.live().map((c) => c.domain)).toEqual([undefined, undefined]);
    }
  });

  it("rolls the session: the same while events come within 30 minutes, renewed with each", () => {
    const { jar, identity } = page();
    const first = identity.ids();
    clock += 29 * MINUTE;
    const second = identity.ids();
    clock += 29 * MINUTE;
    const third = identity.ids();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(value(jar, SESSION_COOKIE)).toBe(`v1.${first.sessionId}.${clock}`);
    expect(jar.live().find((c) => c.name === VISITOR_COOKIE)!.expires).toBe(clock + VISITOR_MAX_AGE_S * 1000);
  });

  it("starts a new session after 30 minutes without an event, for the same visitor", () => {
    const { identity } = page();
    const first = identity.ids();
    clock += 30 * MINUTE;
    const next = identity.ids();

    expect(next.visitorId).toBe(first.visitorId);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.sessionId).toMatch(UUID7);
  });

  it("starts a new session when the session cookie's last activity is 30 minutes old, though it is still there", () => {
    const { jar, identity } = page();
    const first = identity.ids();
    jar.cookie = `_amnda_ses=v1.${first.sessionId}.${START - 30 * MINUTE}; Max-Age=1800; Domain=.example.com; Path=/; SameSite=Lax; Secure`;
    expect(identity.ids().sessionId).not.toBe(first.sessionId);
  });

  it("recognises a returning visitor and continues their open session", () => {
    const { jar, identity } = page();
    const visitor = "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01";
    const sessionId = "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02";
    jar.serverSet({ name: VISITOR_COOKIE, value: `v1.${visitor}`, domain: "example.com", path: "/", maxAge: 86_400 });
    jar.serverSet({ name: SESSION_COOKIE, value: `v1.${sessionId}.${START - 5 * MINUTE}`, domain: "example.com", path: "/", maxAge: 1500 });

    expect(identity.ids()).toEqual({ visitorId: visitor, sessionId });
  });

  it("replaces a cookie it can't read with fresh ids", () => {
    const { jar, identity } = page();
    jar.serverSet({ name: VISITOR_COOKIE, value: "v1.garbage", domain: "example.com", path: "/", maxAge: 86_400 });
    const ids = identity.ids();
    expect(ids.visitorId).toMatch(UUID7);
    expect(value(jar, VISITOR_COOKIE)).toBe(`v1.${ids.visitorId}`);
  });

  it("mints a fresh visitor when another tab deleted the cookies: a withdrawn id never comes back", () => {
    const { jar, identity } = page();
    const first = identity.ids();
    jar.cookie = "_amnda_id=; Max-Age=0; Domain=.example.com; Path=/; SameSite=Lax; Secure";
    jar.cookie = "_amnda_ses=; Max-Age=0; Domain=.example.com; Path=/; SameSite=Lax; Secure";
    const next = identity.ids();
    expect(next.visitorId).not.toBe(first.visitorId);
    expect(next.sessionId).not.toBe(first.sessionId);
  });

  it("keeps the ids in memory for the page, and says so, when the browser keeps no cookie (an http: page)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { jar, identity } = page("http://shop.example.com/", false);
    const first = identity.ids();
    clock += 10 * MINUTE;
    const second = identity.ids();

    expect(jar.live()).toEqual([]);
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
    clock += 30 * MINUTE;
    expect(identity.ids().sessionId).not.toBe(first.sessionId);
  });

  it("never derives an id from the page: two visitors at the same moment get different ids", () => {
    const a = page().identity.ids();
    const b = page().identity.ids();
    expect(a.visitorId).not.toBe(b.visitorId);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe("withdrawal and renewal", () => {
  it("forget deletes both cookies at once", () => {
    const { jar, identity } = page();
    identity.ids();
    identity.forget();
    expect(jar.live()).toEqual([]);
  });

  it("forget also deletes the cookies the collector re-issued through a proxy, and host-only ones", () => {
    const { jar, identity } = page();
    jar.serverSet({ name: VISITOR_COOKIE, value: "v1.a", domain: "example.com", path: "/", maxAge: 86_400 });
    jar.serverSet({ name: SESSION_COOKIE, value: "v1.b.1", domain: "shop.example.com", path: "/", maxAge: 1800 });
    jar.serverSet({ name: VISITOR_COOKIE, value: "v1.c", domain: undefined, path: "/", maxAge: 86_400 });
    jar.serverSet({ name: "session", value: "login", domain: "example.com", path: "/", maxAge: 86_400 });

    identity.forget();
    expect(jar.live().map((c) => c.name)).toEqual(["session"]);
  });

  it("forget deletes both cookies exactly as the collector sets them through a proxy (AAI-827)", () => {
    const { jar, identity } = page();
    const { visitorId, sessionId } = identity.ids();
    // Set-Cookie: <name>=<the tag's value>; Domain=.<etld+1>; Path=/; Max-Age; SameSite=Lax; Secure, never HttpOnly
    jar.serverSet({ name: VISITOR_COOKIE, value: `v1.${visitorId}`, domain: "example.com", path: "/", maxAge: VISITOR_MAX_AGE_S });
    jar.serverSet({ name: SESSION_COOKIE, value: `v1.${sessionId}.${START}`, domain: "example.com", path: "/", maxAge: 1800 });
    expect(jar.live().map((c) => [c.name, c.domain, c.path])).toEqual([
      [VISITOR_COOKIE, "example.com", "/"],
      [SESSION_COOKIE, "example.com", "/"],
    ]);

    identity.forget();
    expect(jar.live()).toEqual([]);
  });

  it("can't reach an HttpOnly cookie, which is why the collector never sets one", () => {
    const { jar, identity } = page();
    jar.serverSet({ name: VISITOR_COOKIE, value: "v1.a", domain: "example.com", path: "/", maxAge: 86_400, httpOnly: true });
    identity.forget();
    expect(jar.live().map((c) => c.name)).toEqual([VISITOR_COOKIE]);
  });

  it("forget writes nothing when there are no cookies to delete", () => {
    const { jar, identity } = page();
    identity.forget();
    expect(jar.writes).toEqual([]);
  });

  it("forget says so when a cookie can't be deleted from here", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { jar, identity } = page();
    // One the deletion can't reach, as one on another path would be: the jar shows it to the page.
    jar.serverSet({ name: VISITOR_COOKIE, value: "v1.a", domain: "elsewhere.example.com", path: "/", maxAge: 86_400 });
    identity.forget();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("_amnda_id could not be deleted"));
  });

  it("renew mints and stores ids unrelated to the earlier ones", () => {
    const { jar, identity } = page();
    const first = identity.ids();
    identity.forget();
    identity.renew();
    const next = identity.ids();
    expect(next.visitorId).not.toBe(first.visitorId);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(value(jar, VISITOR_COOKIE)).toBe(`v1.${next.visitorId}`);
  });
});

describe("identity driven by the consent machine", () => {
  /** The machine with the identity as a.js is to wire it (AAI-964): identified items carry ids(). */
  function machine(declinedMode: "off" | "pings" = "off") {
    const p = page();
    const sent: Ids[] = [];
    const consent = createConsent<number>({
      declinedMode,
      sink: { identified: () => sent.push(p.identity.ids()), anonymous: () => undefined, withdraw: () => undefined },
      identity: p.identity,
    });
    return { ...p, consent, sent };
  }

  it("stores no cookie while consent is unknown, and none at all for a visitor who declines", () => {
    const { jar, consent } = machine("pings");
    consent.collect(1);
    expect(jar.writes).toEqual([]);
    consent.update({ analytics: "denied", ads: "denied" }, "manual");
    consent.collect(2);
    consent.pagehide();
    expect(jar.writes).toEqual([]);
  });

  it("stores the cookies on a grant, deletes them on withdrawal, and mints fresh ids on a new grant", () => {
    const { jar, consent, sent } = machine();
    consent.collect(1);
    consent.update({ analytics: "granted", ads: "granted" }, "manual");
    expect(sent).toHaveLength(1);
    expect(value(jar, VISITOR_COOKIE)).toBe(`v1.${sent[0]!.visitorId}`);
    expect(value(jar, SESSION_COOKIE)).toBe(`v1.${sent[0]!.sessionId}.${START}`);

    consent.update({ analytics: "denied" }, "manual");
    expect(jar.live()).toEqual([]);
    consent.collect(2);
    expect(jar.live()).toEqual([]);

    consent.update({ analytics: "granted" }, "manual");
    consent.collect(3);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.visitorId).not.toBe(sent[0]!.visitorId);
    expect(sent[1]!.sessionId).not.toBe(sent[0]!.sessionId);
    expect(value(jar, VISITOR_COOKIE)).toBe(`v1.${sent[1]!.visitorId}`);
  });

  it("an ads-only change keeps the visitor's cookies", () => {
    const { jar, consent, sent } = machine();
    consent.update({ analytics: "granted", ads: "granted" }, "manual");
    consent.collect(1);
    consent.update({ ads: "denied" }, "manual");
    consent.collect(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(value(jar, VISITOR_COOKIE)).toBe(`v1.${sent[0]!.visitorId}`);
  });
});
