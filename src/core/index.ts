// The a.js entry point: it boots the tag (src/core/boot.ts) synchronously at the IIFE's top level,
// where document.currentScript is the installing script tag, inside the error boundary.
//
// Still to come: the transport (AAI-68) takes the pageviews, posting batches to eventsUrl with
// batchRequestInit, naming each batch's kind, and splitting its pagehide flush by bodyBytes to stay
// within KEEPALIVE_BODY_LIMIT. Until it does, a pageview goes nowhere. Error reports go to the
// browser console until the telemetry endpoint they are to be sent to is decided (AAI-67).
import { boot, type TagWindow } from "./boot";
import { ErrorBoundary, warn, type ErrorReport } from "./boundary";
import { TAG_VERSION } from "./build-info";

const boundary = new ErrorBoundary((report: ErrorReport) => warn("amanda:", report), 1);

boundary.guard("boot", () =>
  boot(window as unknown as TagWindow, {
    tagVersion: TAG_VERSION,
    boundary,
    onPageview: () => undefined,
  }),
);
