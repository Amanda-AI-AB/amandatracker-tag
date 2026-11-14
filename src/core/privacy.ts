// The privacy helper (AAI-178; 06 §5, 04 §7): `amanda('privacy')` shows the visitor their own
// visitor ID, with a button that copies it, in a dialog over the page. A site links it from its
// privacy policy (`<a href="#" onclick="amanda('privacy'); return false">`); the visitor hands the ID
// to the site, which looks them up in the DSAR tool by it.
//
// The ID shown is the visitor_id of the `_amnda_id` cookie, the UUID every identified event carries
// and the DSAR tool looks up, without the cookie's format prefix. The helper only reads the cookie:
// it never mints an ID nor writes a cookie, so it shows one only while analytics is granted (a
// denial deletes the cookie, identity.ts). Without one, it says that none exists without consent.
//
// The dialog is built with textContent alone, never HTML, and styled inline, so the page's own CSS
// changes it as little as it can. Its listeners run inside the boundary, as stage "command". A copy
// the browser refuses, or a page without the Clipboard API (a page on http:), selects the ID and
// asks the visitor to copy it themselves: the visitor is told, never left with a button that did
// nothing.

import { warn, type ErrorBoundary } from "./boundary";
import { parseVisitor, readCookie, VISITOR_COOKIE } from "./identity";
import { CommandError, type Command } from "./queue";

export const PRIVACY_COMMAND = "privacy";
/** The dialog's id: one dialog at a time, whatever the number of calls. */
export const PRIVACY_DIALOG_ID = "amanda-privacy";

/** The texts the dialog shows. */
export const TEXT = {
  title: "Your visitor ID",
  intro:
    "This site's analytics knows your browser by the ID below. To ask the site for a copy of your data, or to have it erased, give them this ID.",
  none: "There is no visitor ID for you on this site. One is created only once you consent to analytics, and it is deleted when you withdraw that consent.",
  copy: "Copy",
  copied: "Copied.",
  copyByHand: "Your browser didn't let the page copy it: the ID is selected, so copy it yourself.",
  close: "Close",
} as const;

/** The DOM the helper builds its dialog with: window, or a stand-in for it in tests. */
export interface PrivacyHost {
  readonly document: Pick<Document, "cookie" | "createElement" | "getElementById" | "body">;
  readonly navigator: { readonly clipboard?: Pick<Clipboard, "writeText"> };
  getSelection(): Pick<Selection, "selectAllChildren"> | null;
}

/** The visitor ID the page's `_amnda_id` cookie holds, or undefined when it holds none. */
export function currentVisitorId(doc: Pick<Document, "cookie">): string | undefined {
  return parseVisitor(readCookie(doc.cookie, VISITOR_COOKIE));
}

const OVERLAY_STYLE =
  "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);font:15px/1.5 system-ui,sans-serif";
const PANEL_STYLE =
  "box-sizing:border-box;max-width:28em;width:calc(100% - 2em);margin:1em;padding:1.25em 1.5em;background:#fff;color:#111;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.3);text-align:left";
const ID_STYLE =
  "display:block;margin:.75em 0;padding:.5em;background:#f3f3f3;color:#111;border-radius:4px;font:14px/1.4 ui-monospace,monospace;word-break:break-all;user-select:all";
const BUTTON_STYLE = "margin:.5em .5em 0 0;padding:.4em 1em;font:inherit;cursor:pointer";

/**
 * The `privacy` command: opens the dialog, or focuses the one already open. It takes no arguments.
 */
export function privacyCommand(win: PrivacyHost, boundary: ErrorBoundary): Command {
  return (...args: unknown[]) => {
    if (args.length > 0) throw new CommandError("amanda('privacy') takes no arguments");
    const doc = win.document;
    const open = doc.getElementById(PRIVACY_DIALOG_ID);
    if (open) {
      open.querySelector("button")?.focus();
      return;
    }
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text?: string): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag);
      node.style.cssText = style;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const listen = (node: HTMLElement, type: string, listener: (event: Event) => void): void => {
      node.addEventListener(type, (event) => boundary.guard("command", () => listener(event)));
    };

    const overlay = element("div", OVERLAY_STYLE);
    overlay.id = PRIVACY_DIALOG_ID;
    const panel = element("div", PANEL_STYLE);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", `${PRIVACY_DIALOG_ID}-title`);
    const title = element("h2", "margin:0 0 .5em;font-size:1.2em;color:inherit", TEXT.title);
    title.id = `${PRIVACY_DIALOG_ID}-title`;
    panel.appendChild(title);

    const close = (): void => {
      overlay.parentNode?.removeChild(overlay);
    };
    const closeButton = element("button", BUTTON_STYLE, TEXT.close);
    closeButton.type = "button";
    listen(closeButton, "click", close);
    listen(overlay, "click", (event) => {
      if (event.target === overlay) close();
    });
    listen(overlay, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") close();
    });

    const id = currentVisitorId(doc);
    let first: HTMLButtonElement = closeButton;
    if (id === undefined) {
      panel.appendChild(element("p", "margin:0", TEXT.none));
    } else {
      panel.appendChild(element("p", "margin:0", TEXT.intro));
      const code = element("code", ID_STYLE, id);
      panel.appendChild(code);
      const status = element("p", "margin:0 0 .25em;min-height:1.5em", "");
      status.setAttribute("role", "status");
      panel.appendChild(status);
      const byHand = (): void => {
        win.getSelection()?.selectAllChildren(code);
        status.textContent = TEXT.copyByHand;
      };
      const copyButton = element("button", BUTTON_STYLE, TEXT.copy);
      copyButton.type = "button";
      listen(copyButton, "click", () => {
        const clipboard = win.navigator.clipboard;
        if (!clipboard) {
          byHand();
          return;
        }
        // From Promise.resolve, so that a writeText that throws is a refusal, as one that rejects is.
        Promise.resolve(id)
          .then((text) => clipboard.writeText(text))
          .then(
            () => {
              status.textContent = TEXT.copied;
            },
            (error: unknown) => {
              // The browser's refusal (no permission, the page not focused), not the tag's failure.
              warn("amanda: could not copy the visitor ID", error);
              boundary.guard("command", byHand);
            },
          );
      });
      panel.appendChild(copyButton);
      first = copyButton;
    }
    panel.appendChild(closeButton);
    overlay.appendChild(panel);
    doc.body.appendChild(overlay);
    first.focus();
  };
}
