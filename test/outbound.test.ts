import { describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { outboundHost, watchOutboundClicks, type ClickOutboundInput, type OutboundClickHost } from "../src/core/outbound";
import type { SpecialClickEvent } from "../src/core/special-clicks";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag, type FakeDocument } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, domains: ["example.de", "Checkout.Example.NET."] };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;
/** The page the fake window is on: shop.example.com. */
const PAGE_URL = `${PAGE}/products?id=1`;

/** Each element's tag name, attributes and parent, kept off the element. */
const nodes = new WeakMap<object, { tag: string; attrs: Record<string, string>; parent: FakeElement | null }>();

/** The page's Element: its prototype's closest and getAttribute read what nodes holds. */
class FakeElement {
  getAttribute(this: object, name: string): string | null {
    const attrs = nodes.get(this)?.attrs ?? {};
    return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null;
  }

  closest(this: object, selector: string): FakeElement | null {
    if (selector !== "a[href], area[href]") throw new Error(`unexpected selector ${selector}`);
    for (let node = this as FakeElement | null; node !== null; node = nodes.get(node)!.parent) {
      const { tag, attrs } = nodes.get(node)!;
      if ((tag === "a" || tag === "area") && "href" in attrs) return node;
    }
    return null;
  }
}

function element(tag: string, attrs: Record<string, string> = {}, parent: FakeElement | null = null): FakeElement {
  const node = new FakeElement();
  nodes.set(node, { tag, attrs, parent });
  return node;
}

const link = (href: string): FakeElement => element("a", { href });

type Listener = (event: SpecialClickEvent) => void;

/** A booted tag with onClickOutbound on a window whose document the test clicks on. */
function clickPage(options: { config?: object; onClickOutbound?: boolean } = {}) {
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(options.config ?? CONFIG));
  const listeners: { type: string; listener: Listener; options: AddEventListenerOptions | undefined }[] = [];
  Object.assign(win.document, {
    addEventListener: (type: string, listener: Listener, opts?: AddEventListenerOptions) => {
      listeners.push({ type, listener, options: opts });
    },
  });
  Object.assign(win, { Element: FakeElement });
  const reports: ErrorReport[] = [];
  const clicks: ClickOutboundInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: () => undefined,
    ...(options.onClickOutbound === false ? {} : { onClickOutbound: (input: ClickOutboundInput) => clicks.push(input) }),
    now: () => START,
  });
  const dispatch = (type: "click" | "auxclick", target: unknown, button?: number): void => {
    for (const entry of listeners) if (entry.type === type) entry.listener(button === undefined ? { target } : { target, button });
  };
  const click = (target: unknown): void => dispatch("click", target, 0);
  return { win, booted, reports, clicks, click, dispatch, listeners };
}

/** The wire event of a click_outbound, once identity and consent have made it one. */
function wireEvent(input: ClickOutboundInput) {
  return buildEvent({
    ...input,
    visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
    session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
    consent: { analytics: "granted", ads: "granted" },
  });
}

describe("click_outbound (AAI-167)", () => {
  it("records the hostname of an outbound link and nothing else of it", async () => {
    const { booted, clicks, click, reports } = clickPage();
    await booted;

    click(link("https://Partner.Example.org:8443/offer/4711?token=s3cret&email=anna%40example.se#pay"));

    const page = { site_id: "site_123", tag_version: "0.2.0", client_ts: START, url: PAGE_URL, page_title: "Products", language: "sv-SE" };
    expect(clicks).toEqual([{ ...page, type: "click_outbound", link_host: "partner.example.org" }]);
    const event = wireEvent(clicks[0]!);
    const validate = validator("event.json");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    const payload = JSON.stringify(event);
    for (const secret of ["offer", "4711", "token", "s3cret", "anna", "8443", "#pay", "https://partner"]) {
      expect(payload).not.toContain(secret);
    }
    expect(reports).toEqual([]);
  });

  it.each([
    ["the page's own host", `${PAGE}/cart`],
    ["a relative link", "/cart"],
    ["a protocol-relative link to the page's host", "//shop.example.com/cart"],
    ["a subdomain of the page's host", "https://cdn.shop.example.com/a.pdf"],
    ["a domain the config lists", "https://example.de/"],
    ["a subdomain of a domain the config lists", "http://www.example.de/kontakt"],
    ["a config domain given with upper case and a trailing dot", "https://checkout.example.net/pay"],
    ["the page's host with a trailing dot", "https://shop.example.com./"],
    ["a fragment", "#reviews"],
  ])("ignores a link to %s", async (_, href) => {
    const { booted, clicks, click, reports } = clickPage();
    await booted;

    click(link(href));

    expect(clicks).toEqual([]);
    expect(reports).toEqual([]);
  });

  it.each([
    ["the page's parent domain, which the config doesn't list", "https://example.com/", "example.com"],
    ["a sibling of the page's host", "https://blog.example.com/", "blog.example.com"],
    ["a host that only ends like a config domain", "https://notexample.de/", "notexample.de"],
    ["a host that holds a config domain as a label", "https://example.de.evil.test/", "example.de.evil.test"],
    ["a protocol-relative link elsewhere", "//partner.example.org/x", "partner.example.org"],
    ["an internationalised host, in punycode", "https://bücher.de/", "xn--bcher-kva.de"],
    ["an IP address", "http://192.0.2.1/", "192.0.2.1"],
    ["an IPv6 address", "http://[2001:DB8::1]/", "[2001:db8::1]"],
  ])("captures a link to %s", async (_, href, host) => {
    const { booted, clicks, click } = clickPage();
    await booted;

    click(link(href));

    expect(clicks.map((c) => c.link_host)).toEqual([host]);
  });

  it.each([
    ["a tel: link", "tel:+46701234567"],
    ["a mailto: link", "mailto:anna@example.org"],
    ["a javascript: link", "javascript:void(0)"],
    ["an ftp: link", "ftp://files.example.org/"],
    ["a malformed URL", "https://exa mple.org:99999/"],
  ])("sends nothing for %s", async (_, href) => {
    const { booted, clicks, click, reports } = clickPage();
    await booted;

    click(link(href));

    expect(clicks).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("resolves a relative link against a <base href>, as the browser follows it, and keeps the page's own host its own (AAI-1231)", async () => {
    const { win, booted, clicks, click, reports } = clickPage();
    await booted;
    (win.document as unknown as FakeDocument).base = "https://partner.example.org/shop/";

    click(link("offer"));
    click(link(`${PAGE}/cart`));

    expect(clicks.map((c) => c.link_host)).toEqual(["partner.example.org"]);
    expect(reports).toEqual([]);
  });

  it("finds the link from an element inside it, and captures an image map's <area>", async () => {
    const { booted, clicks, click } = clickPage();
    await booted;

    click(element("img", {}, link("https://partner.example.org/")));
    click(element("area", { href: "https://maps.example.org/" }));
    click(element("button", { "data-href": "https://partner.example.org/" }));

    expect(clicks.map((c) => c.link_host)).toEqual(["partner.example.org", "maps.example.org"]);
  });

  it("counts a middle click once, by its auxclick, and not a right click", async () => {
    const { booted, clicks, dispatch } = clickPage();
    await booted;
    const target = link("https://partner.example.org/");

    dispatch("auxclick", target, 1);
    dispatch("auxclick", target, 2);
    dispatch("click", target, 1);

    expect(clicks.map((c) => c.link_host)).toEqual(["partner.example.org"]);
  });

  it("leaves out, with a warning, a host the wire schema can't carry rather than send another", async () => {
    const { booted, clicks, click, reports } = clickPage();
    await booted;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    click(link("https://odd$host.example/"));

    expect(clicks).toEqual([]);
    expect(reports).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("odd");
    warn.mockRestore();
  });

  it("captures outbound clicks when the config sets no toggle and no domains: only the page's host is its own", async () => {
    const { booted, clicks, click } = clickPage({ config: { schema_version: 1, site: "site_123", config_version: 7 } });
    await booted;

    click(link("https://example.de/"));
    click(link("/cart"));

    expect(clicks.map((c) => c.link_host)).toEqual(["example.de"]);
  });

  it("captures them with features.outbound_clicks_enabled true", async () => {
    const { booted, clicks, click } = clickPage({ config: { ...CONFIG, features: { outbound_clicks_enabled: true } } });
    await booted;

    click(link("https://partner.example.org/"));

    expect(clicks).toHaveLength(1);
  });

  it("captures nothing, and listens for nothing, when the config turns it off", async () => {
    const { booted, clicks, click, listeners } = clickPage({ config: { ...CONFIG, features: { outbound_clicks_enabled: false } } });
    await booted;

    click(link("https://partner.example.org/"));

    expect(clicks).toEqual([]);
    expect(listeners).toEqual([]);
  });

  it("captures no click without onClickOutbound, and only once the tag has booted", async () => {
    const off = clickPage({ onClickOutbound: false });
    await off.booted;
    expect(off.listeners).toEqual([]);

    const early = clickPage();
    expect(early.listeners).toEqual([]);
    await early.booted;
    expect(early.listeners.map(({ type, options }) => ({ type, options }))).toEqual([
      { type: "click", options: { capture: true, passive: true } },
      { type: "auxclick", options: { capture: true, passive: true } },
    ]);
  });

  it("reports a failure in the listener instead of throwing it into the page", () => {
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    let click: Listener = () => undefined;
    const host: OutboundClickHost = {
      document: { addEventListener: (type, l) => (type === "click" ? (click = l) : undefined), baseURI: PAGE_URL },
      Element: FakeElement as unknown as OutboundClickHost["Element"],
      location: { href: PAGE_URL },
    };
    watchOutboundClicks(host, boundary, [], () => {
      throw new TypeError("boom");
    });

    expect(() => click({ target: link("https://partner.example.org/"), button: 0 })).not.toThrow();
    expect(reports).toEqual([{ stage: "pageview", name: "TypeError", message: "boom" }]);
  });
});

describe("outboundHost", () => {
  it("resolves a relative href against the page, as the browser follows it", () => {
    expect(outboundHost("../x", "https://a.example/b/c", "https://a.example/b/c", [])).toBeUndefined();
    expect(outboundHost("//b.example/x", "http://a.example/", "http://a.example/", [])).toBe("b.example");
  });

  it("resolves it against the document's base URL, and takes the page's own host from the page's URL (AAI-1231)", () => {
    expect(outboundHost("x", "https://b.example/", "https://a.example/", [])).toBe("b.example");
    expect(outboundHost("https://a.example/x", "https://b.example/", "https://a.example/", [])).toBeUndefined();
  });

  it("treats each own domain's subdomains as own, and nothing that merely ends with its name", () => {
    expect(outboundHost("https://x.y.example.de/", "https://a.example/", "https://a.example/", ["example.de"])).toBeUndefined();
    expect(outboundHost("https://myexample.de/", "https://a.example/", "https://a.example/", ["example.de"])).toBe("myexample.de");
  });
});
