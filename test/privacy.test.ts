import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { currentVisitorId, PRIVACY_DIALOG_ID, privacyCommand, TEXT, type PrivacyHost } from "../src/core/privacy";
import { fakeWindow, jsonResponse, scriptTag } from "./fake-window";

const VISITOR = "01932f6e-8a00-7000-8000-000000000001";
const CONFIG = { schema_version: 1, site: "site_123", config_version: 7 };
const SNIPPET = { src: "https://eu.serversider.com/a.js", "data-site": "site_123" };

/** Just enough of an element for the dialog: no layout, no HTML parser. */
class FakeElement {
  id = "";
  type = "";
  textContent: string | null = null;
  readonly style = { cssText: "" };
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  readonly attributes: Record<string, string> = {};
  private readonly listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(
    readonly tagName: string,
    private readonly page: FakePage,
  ) {}

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] = this.listeners[type] || []).push(listener);
  }
  /** Fires type on this element and its ancestors, as a bubbling event does. */
  fire(type: string, props: Record<string, unknown> = {}): void {
    const event = { target: this, ...props };
    for (let node: FakeElement | null = this; node; node = node.parentNode) {
      for (const listener of node.listeners[type] || []) listener(event);
    }
  }
  focus(): void {
    this.page.focused = this;
  }
  /** Every element below this one, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  querySelector(tag: string): FakeElement | null {
    return this.all().find((node) => node.tagName === tag.toUpperCase()) ?? null;
  }
}

/** A page with a body, its cookies, an optional Clipboard API and its selection. */
class FakePage implements PrivacyHost {
  focused: FakeElement | undefined;
  selected: FakeElement | undefined;
  readonly body: FakeElement = new FakeElement("BODY", this);
  readonly document: PrivacyHost["document"];
  readonly navigator: { clipboard?: { writeText: (text: string) => Promise<void> } };

  constructor(cookie: string, clipboard?: { writeText: (text: string) => Promise<void> }) {
    const body = this.body;
    this.document = {
      cookie,
      body,
      createElement: (tag: string) => new FakeElement(tag.toUpperCase(), this),
      getElementById: (id: string) => body.all().find((node) => node.id === id) ?? null,
    } as unknown as PrivacyHost["document"];
    this.navigator = clipboard ? { clipboard } : {};
  }
  getSelection() {
    return { selectAllChildren: (node: Node) => void (this.selected = node as unknown as FakeElement) };
  }
  dialog(): FakeElement | undefined {
    return this.body.children.find((node) => node.id === PRIVACY_DIALOG_ID);
  }
  texts(): string[] {
    return (this.dialog()?.all() ?? []).map((node) => node.textContent ?? "").filter((text) => text !== "");
  }
  button(label: string): FakeElement {
    const found = this.dialog()!.all().find((node) => node.tagName === "BUTTON" && node.textContent === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
  }
}

function setup(cookie: string, clipboard?: { writeText: (text: string) => Promise<void> }) {
  const reports: ErrorReport[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1, () => 0);
  const page = new FakePage(cookie, clipboard);
  const privacy = privacyCommand(page, boundary);
  return { page, privacy, reports };
}

/** Lets the promise chains the click started settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("currentVisitorId", () => {
  it("reads the visitor id of _amnda_id, without the cookie's format prefix", () => {
    expect(currentVisitorId({ cookie: `a=1; _amnda_id=v1.${VISITOR}; _amnda_ses=v1.x.1` })).toBe(VISITOR);
  });

  it("has none without the cookie, or with one this version didn't write", () => {
    expect(currentVisitorId({ cookie: "" })).toBeUndefined();
    expect(currentVisitorId({ cookie: "_amnda_id=v2.whatever" })).toBeUndefined();
  });
});

describe("amanda('privacy')", () => {
  it("shows the visitor their id with a copy button, and copies it", async () => {
    const writeText = vi.fn(async () => undefined);
    const { page, privacy, reports } = setup(`_amnda_id=v1.${VISITOR}`, { writeText });
    privacy();
    const dialog = page.dialog()!;
    const panel = dialog.children[0]!;
    expect(panel.attributes).toMatchObject({ role: "dialog", "aria-modal": "true" });
    expect(page.texts()).toEqual([TEXT.title, TEXT.intro, VISITOR, TEXT.copy, TEXT.close]);
    expect(page.focused).toBe(page.button(TEXT.copy));

    page.button(TEXT.copy).fire("click");
    await settle();
    expect(writeText).toHaveBeenCalledWith(VISITOR);
    expect(page.texts()).toContain(TEXT.copied);
    expect(reports).toEqual([]);
  });

  it("explains that no id exists without consent, and offers nothing to copy", () => {
    const { page, privacy } = setup("other=1");
    privacy();
    expect(page.texts()).toEqual([TEXT.title, TEXT.none, TEXT.close]);
    expect(page.focused).toBe(page.button(TEXT.close));
  });

  it("selects the id and asks the visitor to copy it when the browser refuses the copy", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { page, privacy, reports } = setup(`_amnda_id=v1.${VISITOR}`, {
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    });
    privacy();
    page.button(TEXT.copy).fire("click");
    await settle();
    expect(page.selected?.textContent).toBe(VISITOR);
    expect(page.texts()).toContain(TEXT.copyByHand);
    expect(console.warn).toHaveBeenCalledWith("amanda: could not copy the visitor ID", expect.any(Error));
    expect(reports).toEqual([]);
  });

  it("selects the id and asks the visitor to copy it on a page without the Clipboard API", () => {
    const { page, privacy } = setup(`_amnda_id=v1.${VISITOR}`);
    privacy();
    page.button(TEXT.copy).fire("click");
    expect(page.selected?.textContent).toBe(VISITOR);
    expect(page.texts()).toContain(TEXT.copyByHand);
  });

  it("closes on its close button, on Escape and on a click beside it", () => {
    const { page, privacy } = setup(`_amnda_id=v1.${VISITOR}`);
    privacy();
    page.button(TEXT.close).fire("click");
    expect(page.dialog()).toBeUndefined();

    privacy();
    page.dialog()!.children[0]!.fire("click");
    expect(page.dialog()).toBeDefined();
    page.dialog()!.fire("click");
    expect(page.dialog()).toBeUndefined();

    privacy();
    page.button(TEXT.copy).fire("keydown", { key: "Enter" });
    expect(page.dialog()).toBeDefined();
    page.button(TEXT.copy).fire("keydown", { key: "Escape" });
    expect(page.dialog()).toBeUndefined();
  });

  it("opens one dialog however often it is called", () => {
    const { page, privacy } = setup(`_amnda_id=v1.${VISITOR}`);
    privacy();
    page.focused = undefined;
    privacy();
    expect(page.body.children).toHaveLength(1);
    expect(page.focused).toBe(page.button(TEXT.copy));
  });

  it("never writes a cookie", () => {
    const { page, privacy } = setup("");
    privacy();
    expect(page.document.cookie).toBe("");
  });

  it("refuses arguments", () => {
    const { privacy } = setup("");
    expect(() => privacy({ lang: "sv" })).toThrow("takes no arguments");
  });
});

describe("the booted tag", () => {
  it("registers the privacy command, and reports a failure in it instead of throwing into the page", async () => {
    const reports: ErrorReport[] = [];
    const boundary = new ErrorBoundary((report) => reports.push(report), 1, () => 0);
    const win = fakeWindow(scriptTag(SNIPPET), jsonResponse(CONFIG));
    // The fake window's document has no body: opening the dialog fails, inside the boundary.
    await boot(win, { tagVersion: "0.0.0-test", boundary, onPageview: () => undefined });
    expect(() => win.amanda!("privacy")).not.toThrow();
    expect(reports).toEqual([expect.objectContaining({ stage: "command" })]);
    expect(reports[0]!.message).not.toContain("unknown command");
  });
});
