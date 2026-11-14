// The tag as it runs on a page: the boot (boot.ts) inside the error boundary, whose sampled reports
// go to the collector as tag errors (telemetry.ts), wired to the feed. Both of the tag's entry
// points start it here, so that they are one implementation: a.js (index.ts), which boots from its
// installing script tag, and the npm package's init (src/npm/index.ts, AAI-222), which boots from
// the site and endpoint the site's code gives it.
//
// Each pageview goes through the feed (feed.ts, AAI-964): the consent state machine for the site's
// config, which makes it an event with the visitor and session ids and the consent snapshot, or a
// ping in declined mode `pings`, for the transport to the booted tag's endpoint, or holds it while
// consent is undecided. The machine is boot's `consent` option, so the consent sources
// (consent-sources.ts: GPC, the `consent` command, Google Consent Mode, TCF and the adapters of the
// consent managers it detects, such as Cookiebot's, OneTrust's and Usercentrics') drive it
// (AAI-965). A page_exit (engagement.ts) goes through the feed too, as an event only: it never
// becomes a ping, whose field list has no engagement time (AAI-968). So does the site's own custom
// event, amanda('event', name, props) (custom-event.ts, AAI-979), whose props the ping's field list
// has no room for either. So do the GA4 e-commerce events the auto-map reads from the dataLayer
// (ecommerce.ts), on a site whose config turns it on (features.ga4_ecommerce_enabled, AAI-974): a
// purchase as a pageview goes, an event or a count-only ping; a view_item, an add_to_cart and a
// begin_checkout as events only.
//
// Still to come: a form_submit (forms.ts) goes as a page_exit does, an event only, and so do a
// click_special (special-clicks.ts), a click_outbound (outbound.ts) and an identify event
// (identify.ts), whose command refuses unless the site's config turns identify on. A purchase event
// (purchase.ts) goes as a pageview does: an event, or a count-only ping in declined mode `pings`.
// Until then, a form_submit, a click_special, a click_outbound, an identify event and a purchase
// event go nowhere. Scroll depth (scroll.ts) is off by default, and the tag passes no
// onScrollDepth: the per-site toggle that turns it on is AAI-791's.
import { boot, type Install, type Tag, type TagWindow } from "./boot";
import { ErrorBoundary, warn } from "./boundary";
import { TAG_VERSION } from "./build-info";
import { createFeed } from "./feed";
import { defaultTarget, ERROR_SAMPLE_RATE, tagErrorSink } from "./telemetry";

/**
 * Starts the tag on the page's window: from its installing script tag, which a.js must do
 * synchronously at its top level, or from install. Settles with the booted tag, or undefined when
 * it didn't boot (boot's result); undefined at once when the boot failed synchronously, which the
 * boundary reported. It never rejects and never throws.
 */
export function startTag(install?: Install): Promise<Tag | undefined> | undefined {
  const target = defaultTarget();
  const boundary = new ErrorBoundary(
    (report) => {
      if (typeof fetch !== "function") {
        warn("amanda: no fetch to report a tag error with", report);
        return;
      }
      tagErrorSink(fetch.bind(window), TAG_VERSION, target)(report);
    },
    ERROR_SAMPLE_RATE,
  );
  return boundary.guard("boot", () => {
    const win = window as unknown as TagWindow;
    const feed = createFeed(win, boundary, target, TAG_VERSION);
    return boot(win, {
      tagVersion: TAG_VERSION,
      boundary,
      target,
      ...(install ? { install } : {}),
      onPageview: feed.pageview,
      consent: feed.consent,
      onPageExit: feed.pageExit,
      onEvent: feed.event,
      onEcommerce: feed.ecommerce,
      onFormSubmit: () => undefined,
      onClickSpecial: () => undefined,
      onClickOutbound: () => undefined,
      onIdentify: () => undefined,
      onPurchase: () => undefined,
    });
  });
}
