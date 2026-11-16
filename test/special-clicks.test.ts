import { describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import {
  clickedScheme,
  linkScheme,
  watchSpecialClicks,
  type ClickSpecialInput,
  type SpecialClickEvent,
  type SpecialClickHost,
} from "../src/core/special-clicks";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag } from "./fake-window";
import { validator } from "./wire-validator";

const CONFIG = { schema_version: 1, site: "site_123", config_version: 7, consent: { declined_mode: "pings" } };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };
const START = 1_731_400_000_000;

const PHONE = "+46701234567";
const EMAIL = "anna.svensson@example.se";

/** Each element's tag name, attributes and parent, kept off the element so that reading them touches none of its properties. */
const nodes = new WeakMap<object, { tag: string; attrs: Record<string, string>; parent: FakeElement | null }>();

/** The page's Element: its prototype's closest and getAttribute read what nodes holds. */
class FakeElement {
  getAttribute(this: object, name: string): string | null {
    const attrs = nodes.get(this)?.attrs ?? {};
    return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null;
  }

  /** closest for the one selector the tag asks for: an <a> or <area> with an href. */
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

type Listener = (event: SpecialClickEvent) => void;

/** A booted tag with onClickSpecial on a window whose document the test clicks on. */
function clickPage(options: { onClickSpecial?: boolean } = {}) {
  const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
  const listeners: { type: string; listener: Listener; options: AddEventListenerOptions | undefined }[] = [];
  Object.assign(win.document, {
    addEventListener: (type: string, listener: Listener, opts?: AddEventListenerOptions) => {
      listeners.push({ type, listener, options: opts });
    },
  });
  Object.assign(win, { Element: FakeElement });
  const reports: ErrorReport[] = [];
  const clicks: ClickSpecialInput[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  const booted = boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: () => undefined,
    ...(options.onClickSpecial === false ? {} : { onClickSpecial: (input: ClickSpecialInput) => clicks.push(input) }),
    now: () => START,
  });
  const dispatch = (type: "click" | "auxclick", target: unknown, button?: number): void => {
    for (const entry of listeners) if (entry.type === type) entry.listener(button === undefined ? { target } : { target, button });
  };
  const click = (target: unknown): void => dispatch("click", target, 0);
  return { win, booted, reports, clicks, click, dispatch, listeners };
}

/** The wire event of a click_special, once identity and consent have made it one. */
function wireEvent(input: ClickSpecialInput) {
  return buildEvent({
    ...input,
    visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
    session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
    consent: { analytics: "granted", ads: "granted" },
  });
}

describe("click_special (AAI-169)", () => {
  it("records the scheme and nothing else of a tel: or mailto: link: never the number or the address", async () => {
    const { booted, clicks, click, reports } = clickPage();
    await booted;

    click(element("a", { href: `tel:${PHONE}`, title: `Call ${PHONE}`, "data-phone": PHONE }));
    click(element("a", { href: `mailto:${EMAIL}?subject=Order%204711&body=Hi`, id: "contact" }));

    const page = { site_id: "site_123", tag_version: "0.2.0", client_ts: START, url: `${PAGE}/products?id=1`, page_title: "Products", language: "sv-SE" };
    expect(clicks).toEqual([
      { ...page, type: "click_special", link_scheme: "tel" },
      { ...page, type: "click_special", link_scheme: "mailto" },
    ]);
    const validate = validator("event.json");
    for (const input of clicks) {
      const event = wireEvent(input);
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
      // The event holds the envelope every event carries, and the scheme: no props, no link.
      expect(Object.keys(event).sort()).toEqual(
        [
          "client_ts",
          "consent",
          "event_id",
          "language",
          "link_scheme",
          "page_title",
          "schema_version",
          "session_id",
          "site_id",
          "tag_version",
          "type",
          "url",
          "visitor_id",
        ].sort(),
      );
      // The payload as it goes on the wire holds no part of the link's address.
      const payload = JSON.stringify(event);
      for (const secret of [PHONE, "46701234567", EMAIL, "anna.svensson", "example.se", "Order", "subject", "tel:", "mailto:"]) {
        expect(payload).not.toContain(secret);
      }
    }
    expect(reports).toEqual([]);
  });

  it("finds the link from an element inside it", async () => {
    const { booted, clicks, click } = clickPage();
    await booted;
    const link = element("a", { href: `tel:${PHONE}` });
    const icon = element("svg", {}, element("span", {}, link));

    click(icon);

    expect(clicks.map((c) => c.link_scheme)).toEqual(["tel"]);
  });

  it("captures an image map's <area> link too", async () => {
    const { booted, clicks, click } = clickPage();
    await booted;

    click(element("area", { href: `mailto:${EMAIL}` }));

    expect(clicks.map((c) => c.link_scheme)).toEqual(["mailto"]);
  });

  it("reads nothing of the link but its href, through the prototype's closest and getAttribute", async () => {
    const { booted, clicks, click } = clickPage();
    await booted;
    const read: PropertyKey[] = [];
    const target = element("a", { href: `tel:${PHONE}` });
    const link = new Proxy(target, {
      get(t, key, receiver) {
        read.push(key);
        return Reflect.get(t, key, receiver);
      },
    });
    nodes.set(link, nodes.get(target)!);
    const getAttribute = vi.spyOn(FakeElement.prototype, "getAttribute");

    click(link);

    expect(read).toEqual([]);
    expect(getAttribute.mock.calls.map(([name]) => name)).toEqual(["href"]);
    expect(clicks.map((c) => c.link_scheme)).toEqual(["tel"]);
    getAttribute.mockRestore();
  });

  it("is not fooled by a link whose own getAttribute or closest the page replaced", async () => {
    const { booted, clicks, click } = clickPage();
    await booted;
    const link = element("a", { href: `tel:${PHONE}` });
    Object.assign(link, { getAttribute: () => `mailto:${EMAIL}`, closest: () => null });

    click(link);

    expect(clicks.map((c) => c.link_scheme)).toEqual(["tel"]);
  });

  it.each([
    ["an https: link", "https://shop.example.com/contact"],
    ["a relative link", "/contact"],
    ["a relative link that looks like tel", "tel"],
    ["a fragment", "#tel:123"],
    ["an sms: link", `sms:${PHONE}`],
    ["a javascript: link", "javascript:void(0)"],
    ["a path holding tel:", "/x/tel:123"],
    ["a telephone-like scheme", `telx:${PHONE}`],
  ])("sends nothing for %s", async (_, href) => {
    const { booted, clicks, click, reports } = clickPage();
    await booted;

    click(element("a", { href }));

    expect(clicks).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("sends nothing for an element outside any link, a link without an href, or a target that isn't an element", async () => {
    const { booted, clicks, click, reports } = clickPage();
    await booted;

    click(element("button", { "data-href": `tel:${PHONE}` }));
    click(element("a", { name: "anchor" }));
    click({ href: `tel:${PHONE}` });
    click(null);

    expect(clicks).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("counts a middle click once, by its auxclick, and neither a right click nor a middle button's click event", async () => {
    const { booted, clicks, dispatch } = clickPage();
    await booted;
    const link = element("a", { href: `mailto:${EMAIL}` });

    dispatch("auxclick", link, 1);
    dispatch("auxclick", link, 2);
    dispatch("click", link, 1);
    // A click a page's script dispatches without a button is a primary click.
    dispatch("click", link);

    expect(clicks.map((c) => c.link_scheme)).toEqual(["mailto", "mailto"]);
  });

  it("listens on the document in the capture phase, so a page that stops the click's propagation is still counted", async () => {
    const { booted, listeners } = clickPage();
    await booted;

    expect(listeners.map(({ type, options }) => ({ type, options }))).toEqual([
      { type: "click", options: { capture: true, passive: true } },
      { type: "auxclick", options: { capture: true, passive: true } },
    ]);
  });

  it("captures no click without onClickSpecial", async () => {
    const { booted, listeners } = clickPage({ onClickSpecial: false });
    await booted;

    expect(listeners).toEqual([]);
  });

  it("starts capturing only once the tag has booted", () => {
    const { listeners } = clickPage();

    expect(listeners).toEqual([]);
  });

  it("reports a failure in the listener instead of throwing it into the page", () => {
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1);
    let click: Listener = () => undefined;
    const host: SpecialClickHost = {
      document: { addEventListener: (type, l) => (type === "click" ? (click = l) : undefined) },
      Element: FakeElement as unknown as SpecialClickHost["Element"],
    };
    watchSpecialClicks(host, boundary, () => {
      throw new TypeError("boom");
    });

    expect(() => click({ target: element("a", { href: `tel:${PHONE}` }), button: 0 })).not.toThrow();
    expect(reports).toEqual([{ stage: "pageview", name: "TypeError", message: "boom" }]);
  });
});

describe("linkScheme", () => {
  it.each([
    [`tel:${PHONE}`, "tel"],
    ["TEL:123", "tel"],
    [`Mailto:${EMAIL}`, "mailto"],
    ["mailto:", "mailto"],
    [`  \u0000tel:${PHONE}`, "tel"],
    [`t\ne\tl\r:${PHONE}`, "tel"],
    [`mail\nto:${EMAIL}`, "mailto"],
  ])("reads %j as %s, as a browser's URL parser does", (href, scheme) => {
    expect(linkScheme(href)).toBe(scheme);
  });

  it.each(["", "tel", ":tel", "x tel:1", "tel :1", "https://example.com/tel:1", `sms:${PHONE}`, "/tel:1"])("finds no tel or mailto scheme in %j", (href) => {
    expect(linkScheme(href)).toBeUndefined();
  });
});

describe("clickedScheme", () => {
  const host: SpecialClickHost = { document: { addEventListener: () => undefined }, Element: FakeElement as unknown as SpecialClickHost["Element"] };

  it("is the scheme of the link the target is in, and undefined for any other target", () => {
    expect(clickedScheme(host, element("span", {}, element("a", { href: `tel:${PHONE}` })))).toBe("tel");
    expect(clickedScheme(host, element("span"))).toBeUndefined();
    expect(clickedScheme(host, "tel:1")).toBeUndefined();
  });
});
