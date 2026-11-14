// The a.js entry point: it boots the tag (src/core/boot.ts) synchronously at the IIFE's top level,
// where document.currentScript is the installing script tag, inside the error boundary, whose
// sampled reports go to the collector as tag errors (src/core/telemetry.ts).
//
// Each pageview goes through the feed (src/core/feed.ts, AAI-964): the consent state machine for
// the site's config, which makes it an event with the visitor and session ids and the consent
// snapshot, or a ping in declined mode `pings`, for the transport to the booted tag's endpoint, or
// holds it while consent is undecided. The machine is boot's `consent` option, so the consent
// sources (src/core/consent-sources.ts: GPC, the `consent` command, Google Consent Mode, TCF and the
// adapters of the consent managers it detects, such as Cookiebot's, OneTrust's and Usercentrics')
// drive it (AAI-965). A page_exit (src/core/engagement.ts) goes through the feed too, as an event
// only: it never becomes a ping, whose field list has no engagement time (AAI-968). So does the
// site's own custom event, amanda('event', name, props) (src/core/custom-event.ts, AAI-979), whose
// props the ping's field list has no room for either.
//
// Still to come: a form_submit (src/core/forms.ts) goes as a page_exit does, an event only, and so do a click_special
// (src/core/special-clicks.ts), a click_outbound (src/core/outbound.ts) and an identify event (src/core/identify.ts), whose command refuses
// unless the site's config turns identify on. A purchase event (src/core/purchase.ts) goes as a
// pageview does: an event, or a count-only ping in declined mode `pings`. Until then, a form_submit, a click_special, a click_outbound, an identify event and a purchase event go nowhere. Scroll depth
// (src/core/scroll.ts) is off by default, and a.js passes no onScrollDepth: the per-site toggle
// that turns it on is AAI-791's.
import { boot, type TagWindow } from "./boot";
import { ErrorBoundary, warn } from "./boundary";
import { TAG_VERSION } from "./build-info";
import { createFeed } from "./feed";
import { defaultTarget, ERROR_SAMPLE_RATE, tagErrorSink } from "./telemetry";

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

boundary.guard("boot", () => {
  const win = window as unknown as TagWindow;
  const feed = createFeed(win, boundary, target);
  return boot(win, {
    tagVersion: TAG_VERSION,
    boundary,
    target,
    onPageview: feed.pageview,
    consent: feed.consent,
    onPageExit: feed.pageExit,
    onEvent: feed.event,
    onFormSubmit: () => undefined,
    onClickSpecial: () => undefined,
    onClickOutbound: () => undefined,
    onIdentify: () => undefined,
    onPurchase: () => undefined,
  });
});
