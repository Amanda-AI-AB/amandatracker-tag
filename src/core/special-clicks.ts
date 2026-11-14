// Autocapture of clicks on tel: and mailto: links (01 §4): a click_special for each click, or
// middle click, on a link whose href is a tel: or mailto: URL, carrying in link_scheme the scheme,
// tel or mailto, and nothing else of the link. The address is never sent: a phone number or an
// email address leaving the browser would breach the privacy invariant (08 I4). The tag reads the
// href's scheme alone, up to its first colon, and keeps it only when it is one of the two: the wire
// schema's LinkScheme is a closed list, so nothing else could pass for it.
//
// The link is the clicked element or its closest <a> or <area> ancestor with an href, found and read
// through Element.prototype's closest and getAttribute, never through the element's own properties,
// which the page may have replaced. Its scheme is read as a browser's URL parser reads it: leading
// spaces and control characters skipped, tabs and newlines dropped, case ignored.
//
// The listener is on the document in the capture phase, so that a page that stops the click's
// propagation still has it counted. A click the page cancels counts too.

import type { LinkScheme } from "../wire/generated";
import type { ErrorBoundary } from "./boundary";
import { pageviewInput, type PageSource, type PageviewInput } from "./pageview";

/** A click_special's page fields, as pageviewInput reads them, and its link's scheme. */
export interface ClickSpecialInput extends Omit<PageviewInput, "type" | "referrer" | "attribution"> {
  readonly type: "click_special";
  readonly link_scheme: LinkScheme;
}

/** A click or auxclick, as the special-click watcher reads it: its target, and which button. */
export interface SpecialClickEvent {
  readonly target: unknown;
  readonly button?: number;
}

/** What the special-click watcher listens on: window, or a stand-in for it in tests. */
export interface SpecialClickHost {
  readonly document: {
    addEventListener(type: "click" | "auxclick", listener: (event: SpecialClickEvent) => void, options?: AddEventListenerOptions): void;
  };
  /** The page's Element: what tells an element from another target, and its closest and getAttribute. */
  readonly Element: (abstract new () => object) & { readonly prototype: Pick<Element, "closest" | "getAttribute"> };
}

/** The links a click_special is for, by the selector closest finds them with. */
const LINK_SELECTOR = "a[href], area[href]";

/** The click event's button: the primary one. */
const PRIMARY_BUTTON = 0;

/** The auxclick button of a middle click; auxclick also fires for the right button, which follows no link. */
const MIDDLE_BUTTON = 1;

/**
 * The scheme of href when it is tel or mailto, lower-cased and without its colon; otherwise
 * undefined, a relative href included. Reads nothing of href past its first colon.
 */
export function linkScheme(href: string): LinkScheme | undefined {
  // The URL parser skips leading C0 controls and spaces, and drops every tab and newline.
  const match = /^[\u0000- ]*([^:]*):/.exec(href);
  if (!match) return undefined;
  const scheme = match[1]!.replace(/[\t\n\r]/g, "").toLowerCase();
  return scheme === "tel" || scheme === "mailto" ? scheme : undefined;
}

/**
 * The scheme of the tel: or mailto: link that target is or is inside, read as the file's header
 * says; undefined for any other target.
 */
export function clickedScheme(host: SpecialClickHost, target: unknown): LinkScheme | undefined {
  const href = clickedHref(host, target);
  return href === undefined ? undefined : linkScheme(href);
}

/**
 * The href attribute of the <a> or <area> link that target is or is inside, read through
 * Element.prototype as the file's header says; undefined for any other target.
 */
export function clickedHref(host: SpecialClickHost, target: unknown): string | undefined {
  if (!(target instanceof host.Element)) return undefined;
  const link = host.Element.prototype.closest.call(target, LINK_SELECTOR);
  if (link === null) return undefined;
  const href = host.Element.prototype.getAttribute.call(link, "href");
  return href === null ? undefined : href;
}

/** The click_special of the page as it is now, for a link of scheme; empty fields are left out. */
export function clickSpecialInput(
  page: PageSource,
  site: string,
  tagVersion: string,
  scheme: LinkScheme,
  now: number = Date.now(),
): ClickSpecialInput {
  // A pageview's own fields stay with it: the click_special's type replaces its type.
  const { type, referrer, attribution, ...fields } = pageviewInput(page, site, tagVersion, "", now);
  return { ...fields, type: "click_special", link_scheme: scheme };
}

/**
 * Calls onClick with the scheme of each tel: or mailto: link the visitor clicks or middle-clicks, as
 * the file's header says. The listeners run inside the boundary, as stage "pageview": a
 * click_special belongs to the page's view, as a form_submit does.
 */
export function watchSpecialClicks(win: SpecialClickHost, boundary: ErrorBoundary, onClick: (scheme: LinkScheme) => void): void {
  watchLinkClicks(win, boundary, (href) => {
    const scheme = linkScheme(href);
    if (scheme !== undefined) onClick(scheme);
  });
}

/**
 * Calls onHref with the href of each link the visitor clicks or middle-clicks, found as the file's
 * header says: the listeners are on the document in the capture phase and passive, and run inside the
 * boundary, as stage "pageview". Shared by click_special and click_outbound (outbound.ts).
 */
export function watchLinkClicks(win: SpecialClickHost, boundary: ErrorBoundary, onHref: (href: string) => void): void {
  /** A listener for clicks of button: each event type counts one button, so no click counts twice. */
  const listener =
    (button: number) =>
    (event: SpecialClickEvent): void =>
      boundary.guard("pageview", () => {
        // A click event without a button, which only a page's script can dispatch, is a primary click.
        if ((event.button === undefined ? PRIMARY_BUTTON : event.button) !== button) return;
        const href = clickedHref(win, event.target);
        if (href !== undefined) onHref(href);
      });
  win.document.addEventListener("click", listener(PRIMARY_BUTTON), { capture: true, passive: true });
  win.document.addEventListener("auxclick", listener(MIDDLE_BUTTON), { capture: true, passive: true });
}
