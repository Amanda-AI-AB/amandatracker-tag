// A stand-in for the browser's window, for the boot tests: the node test environment has no DOM.
// It has what the tag reads (the installing script tag through Document.prototype's currentScript
// getter, location, navigator, history and fetch), and history moves location as a browser's does.
import { vi } from "vitest";
import type { TagWindow } from "../src/core/boot";

export const PAGE = "https://shop.example.com";

/** A Document whose prototype's currentScript getter returns the script it was made with. */
export class FakeDocument {
  constructor(
    private readonly script: Element | null,
    readonly title = "Products",
    readonly referrer = "https://search.example/",
  ) {}

  get currentScript(): Element | null {
    return this.script;
  }
}

/** A <script> element with the attributes given. */
export function scriptTag(attributes: Record<string, string>, tagName = "SCRIPT"): Element {
  return {
    tagName,
    getAttribute: (name: string) => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null),
  } as unknown as Element;
}

export interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** A fetch response with body as its JSON. */
export function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

export interface FakeWindow extends TagWindow {
  readonly fetchMock: ReturnType<typeof vi.fn>;
  /** The page's Cookiebot, when a test installs one. */
  Cookiebot?: unknown;
  /** The page's OneTrust, its active groups and OptanonWrapper, when a test installs them. */
  OneTrust?: unknown;
  OnetrustActiveGroups?: unknown;
  OptanonWrapper?: unknown;
  /** The page's Usercentrics (its Browser UI), when a test installs one. */
  UC_UI?: unknown;
  /** Moves location to url, as the back button does, and fires popstate. */
  back(url: string): void;
  /** Fires the window event `type`, such as one a consent manager dispatches. */
  fire(type: string): void;
}

/**
 * A window on `href`, installed by `script`, whose fetch answers with `response`. Stubs the global
 * Document with FakeDocument, which the caller undoes with vi.unstubAllGlobals().
 */
export function fakeWindow(
  script: Element | null,
  response: FakeResponse | (() => Promise<FakeResponse>) = jsonResponse({}),
  href = `${PAGE}/products?id=1`,
): FakeWindow {
  vi.stubGlobal("Document", FakeDocument);
  const location = { href, origin: new URL(href).origin } as Location;
  const listeners: Record<string, (() => void)[]> = {};
  const move = (url?: string | URL | null): void => {
    if (url != null) (location as { href: string }).href = new URL(String(url), location.href).href;
  };
  const history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => move(url),
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => move(url),
  } as unknown as History;
  const fetchMock = vi.fn(typeof response === "function" ? response : async () => response);
  const win = {
    document: new FakeDocument(script) as unknown as Document,
    location,
    navigator: { language: "sv-SE" },
    history,
    fetch: fetchMock as unknown as typeof fetch,
    fetchMock,
    addEventListener: (type: string, listener: () => void) => {
      (listeners[type] = listeners[type] || []).push(listener);
    },
    back(url: string) {
      move(url);
      this.fire("popstate");
    },
    fire(type: string) {
      for (const listener of listeners[type] || []) listener();
    },
  };
  return win as unknown as FakeWindow;
}
