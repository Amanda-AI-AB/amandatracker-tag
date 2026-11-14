// Proxied mode end to end (AAI-831): a site behind a first-party reverse proxy installs the tag with
// data-endpoint="/amnda" (docs/first-party-proxy.md). The boot, a consent manager's adapter, the
// consent machine, the identity and the transport are wired together as a.js is to wire them
// (AAI-964), on a stand-in window whose cookies are a CookieJar. The config, the adapter and the
// events all go through the proxy on the page's own origin; the pageview's batch goes by fetch with
// same-origin credentials, so the browser stores the cookies the collector re-issues with
// Set-Cookie (AAI-827); and a withdrawal deletes those cookies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCookiebot } from "../src/cmp/cookiebot";
import { connectAdapter } from "../src/core/adapter-api";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { declinedMode } from "../src/core/config";
import { createConsent, type ConsentMachine } from "../src/core/consent";
import { batchRequestInit, configRequestInit } from "../src/core/endpoint";
import { createIdentity, SESSION_COOKIE, VISITOR_COOKIE, VISITOR_MAX_AGE_S } from "../src/core/identity";
import type { PageviewInput } from "../src/core/pageview";
import { defaultTarget } from "../src/core/telemetry";
import { createTransport, type Transport } from "../src/core/transport";
import { buildEvent } from "../src/wire/payload";
import { CookieJar } from "./cookie-jar";
import { fakeWindow, jsonResponse, PAGE, scriptTag, type FakeWindow } from "./fake-window";
import { validator } from "./wire-validator";

const PROXY = `${PAGE}/amnda`;
const CONFIG_URL = `${PROXY}/cfg/site_123.json`;
const EVENTS_URL = `${PROXY}/v1/e`;
const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: "off" } };
const SNIPPET = { src: "/amnda/a.js", "data-site": "site_123", "data-endpoint": "/amnda" };

interface InjectedScript {
  src?: string;
  onload?: () => void;
}

/** window.Cookiebot: answered with these categories, or not answered yet. */
const cookiebot = (answer?: { statistics: boolean; marketing: boolean }) =>
  answer
    ? { hasResponse: true, consent: { necessary: true, preferences: false, ...answer } }
    : { hasResponse: false, consent: { necessary: true, preferences: false, statistics: false, marketing: false } };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A page on shop.example.com with Cookiebot, the tag installed through the proxy. Its proxy answers
 * the config with CONFIG and each batch with a 204; for a batch sent with credentials, the browser
 * stores the collector's Set-Cookie for the ids the batch's first event carries, as AAI-827 sets them.
 */
function page() {
  const jar = new CookieJar("shop.example.com", () => Date.now());
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(null, 404));
  win.fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url === CONFIG_URL) return jsonResponse(CONFIG);
    if (url !== EVENTS_URL) return jsonResponse(null, 404);
    if (init.credentials !== "omit") {
      const [event] = (JSON.parse(init.body as string) as { e: { visitor_id: string; session_id: string }[] }).e;
      jar.serverSet({ name: VISITOR_COOKIE, value: `v1.${event!.visitor_id}`, domain: "example.com", path: "/", maxAge: VISITOR_MAX_AGE_S });
      jar.serverSet({ name: SESSION_COOKIE, value: `v1.${event!.session_id}.${Date.now()}`, domain: "example.com", path: "/", maxAge: 1800 });
    }
    return jsonResponse(null, 204);
  });
  const beacon = vi.fn(() => true);
  const appended: InjectedScript[] = [];
  Object.assign(win, {
    navigator: { language: "sv-SE", sendBeacon: beacon },
    setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    Cookiebot: cookiebot(),
  });
  Object.assign(win.document, {
    createElement: () => ({}) as InjectedScript,
    head: { appendChild: (script: InjectedScript) => appended.push(script) },
  });

  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const target = defaultTarget();
  const identity = createIdentity({ document: jar, location: win.location });
  let transport: Transport | undefined;
  let machine: ConsentMachine<PageviewInput> | undefined;
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    target,
    onPageview: (input) => machine!.collect(input),
    consent: (config) => {
      // The transport goes to the endpoint the boot resolved from data-endpoint.
      transport = createTransport(win as unknown as Parameters<typeof createTransport>[0], target.endpoint, boundary);
      machine = createConsent<PageviewInput>({
        declinedMode: declinedMode(config),
        sink: {
          identified: (input, consent) => {
            const { visitorId, sessionId } = identity.ids();
            transport!.event(buildEvent({ ...input, visitor_id: visitorId, session_id: sessionId, consent }));
          },
          anonymous: () => undefined,
          withdraw: () => transport!.withdrawEvents(),
        },
        identity,
      });
      return machine;
    },
  });

  return {
    win,
    jar,
    booted,
    reports,
    appended,
    beacon,
    machine: () => machine!,
    /** The browser runs the Cookiebot adapter it was asked for: what src/adapters/cookiebot.ts does. */
    runAdapter: () => {
      connectAdapter(win, "cookiebot", (api) => watchCookiebot(win as FakeWindow, api));
      appended[0]!.onload!();
    },
    /** The visitor answers in Cookiebot's banner. */
    answer: (statistics: boolean) => {
      win.Cookiebot = cookiebot({ statistics, marketing: statistics });
      win.fire("CookiebotOnConsentReady");
    },
  };
}

describe('proxied mode: data-endpoint="/amnda"', () => {
  it("fetches the config, loads the adapter and posts events through the proxy, and withdrawal removes both cookies", async () => {
    const p = page();
    await p.booted;

    expect(p.win.fetchMock.mock.calls).toEqual([[CONFIG_URL, configRequestInit()]]);
    expect(p.appended.map((s) => s.src)).toEqual([`${PROXY}/adapters/0.0.0-test/cookiebot.js`]);

    p.runAdapter();
    p.answer(true);
    await vi.advanceTimersByTimeAsync(0);

    // The pending pageview goes at once, by fetch with same-origin credentials, never by sendBeacon.
    const calls = p.win.fetchMock.mock.calls as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([CONFIG_URL, EVENTS_URL]);
    const [, init] = calls[1]!;
    expect(init).toEqual(batchRequestInit(init.body as string, "events"));
    expect(init.credentials).toBe("same-origin");
    expect(p.beacon).not.toHaveBeenCalled();
    const batch = JSON.parse(init.body as string);
    const validate = validator("batch.json");
    expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
    expect(batch.e.map((e: { type: string }) => e.type)).toEqual(["pageview"]);

    // The browser now holds the collector's cookies, on the registrable domain, for the ids the tag sent.
    expect(p.jar.live().map((c) => [c.name, c.domain, c.path, c.value.split(".")[1]])).toEqual([
      [VISITOR_COOKIE, "example.com", "/", batch.e[0].visitor_id],
      [SESSION_COOKIE, "example.com", "/", batch.e[0].session_id],
    ]);

    p.answer(false);
    expect(p.machine().mode()).toBe("declined");
    expect(p.jar.live()).toEqual([]);
    expect(p.reports).toEqual([]);
  });
});
