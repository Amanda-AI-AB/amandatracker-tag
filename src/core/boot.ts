// The tag's boot: read the installing script tag, fetch the site's config, then install the
// command queue, send the first pageview and follow the single-page app's route changes. The
// engagement clock runs from the page's load, and each hide sends a page_exit (engagement.ts). A
// config that pins the site to another build hands off to it instead (canary.ts). Every step runs
// inside the error boundary: a failure is reported, and the page never sees it.

import { ADAPTER_COMMAND } from "./adapter-api";
import { loadAdapter } from "./adapter-loader";
import { attributionOf } from "./attribution";
import type { ErrorBoundary } from "./boundary";
import { handOff, shouldHandOff } from "./canary";
import { bundleVersion, checkSiteId, customParams, errorSampleRate, fetchConfig, gpcHonored, identifyEnabled, type SiteConfig } from "./config";
import {
  consentCommand,
  createLadder,
  honorGpc,
  watchConsentMode,
  watchCmpAdapters,
  watchTcf,
  type CmpHost,
  type ConsentInput,
  type ConsentModeHost,
  type GpcHost,
  type TcfHost,
} from "./consent-sources";
import { ecommerceInput, watchEcommerce, type EcommerceHost, type EcommerceInput } from "./ecommerce";
import { pageExitInput, watchEngagement, type EngagementHost, type PageExitInput } from "./engagement";
import { currentScript, endpointFromScript } from "./endpoint";
import { formSubmitInput, watchForms, type FormHost, type FormSubmitInput } from "./forms";
import { IDENTIFY_COMMAND, identifyCommand, identifyInput, type IdentifyInput } from "./identify";
import { pageviewInput, watchRoutes, type PageSource, type PageviewInput, type RouteSource } from "./pageview";
import { PRIVACY_COMMAND, privacyCommand, type PrivacyHost } from "./privacy";
import { ensureStub, installCommands, type AmandaHost, type Command } from "./queue";
import { scrollDepthInput, watchScroll, type ScrollDepthInput, type ScrollHost, type ScrollReset } from "./scroll";
import type { TagTarget } from "./telemetry";

/** The browser globals the tag boots on: window, or a stand-in for it in tests. */
export interface TagWindow
  extends AmandaHost,
    PageSource,
    RouteSource,
    ConsentModeHost,
    TcfHost,
    GpcHost,
    EngagementHost,
    FormHost,
    ScrollHost,
    EcommerceHost,
    CmpHost,
    PrivacyHost {
  readonly document: Document;
  readonly location: Location;
  readonly navigator: PageSource["navigator"] & GpcHost["navigator"] & PrivacyHost["navigator"];
  fetch: typeof fetch;
  /** popstate, pagehide, pageshow and scroll, and the events of the consent managers the tag has adapters for. */
  addEventListener(type: string, listener: () => void): void;
}

export interface BootOptions {
  readonly tagVersion: string;
  readonly boundary: ErrorBoundary;
  /** Where each pageview goes: the transport (createTransport), once identity and consent make it an event. */
  readonly onPageview: (input: PageviewInput) => void;
  /**
   * Where each page_exit goes (engagement.ts), as each pageview does: an event only, never a
   * ping. With it, the boot runs the engagement clock from the page's load, and hands over the
   * page_exits of hides after the tag booted. Without it, the tag tracks no engagement.
   */
  readonly onPageExit?: (input: PageExitInput) => void;
  /**
   * Where each form_submit goes (forms.ts), as each pageview does. With it, the booted tag hands
   * over a form_submit, with the form's id, name and action and never its fields' values, for each
   * form the page submits. Without it, the tag captures no form submission.
   */
  readonly onFormSubmit?: (input: FormSubmitInput) => void;
  /**
   * Where each scroll event goes (scroll.ts), as each pageview does. With it, the booted tag hands
   * over a scroll event the first time, in each pageview, the visitor scrolls to 25, 50, 75 and 90 %
   * of the page. Without it, the default, the tag measures no scroll depth.
   */
  readonly onScrollDepth?: (input: ScrollDepthInput) => void;
  /**
   * Where each mapped GA4 e-commerce event goes (ecommerce.ts), as each pageview does. With it, the
   * booted tag reads view_item, add_to_cart, begin_checkout and purchase from window.dataLayer,
   * those already there and those pushed later, and hands over each as the event its explicit
   * mapping makes of it. Without it, the default, the tag reads none of them.
   */
  readonly onEcommerce?: (input: EcommerceInput) => void;
  /**
   * Where each identify event goes (identify.ts), as each pageview does: an event only, never a
   * ping. With it, the booted tag has the `identify` command, which hands over one identify event
   * for each call with a ref it accepts, and only when the site's config turns identify on. Without
   * it, the tag has no `identify` command.
   */
  readonly onIdentify?: (input: IdentifyInput) => void;
  /**
   * The consent state machine for the booted site's config (createConsent, with the config's
   * declined mode). With it, the consent sources drive the machine: Global Privacy Control when the
   * config honors it, the `consent` command, Google Consent Mode, TCF v2.2 and the adapters of
   * consent managers it detects, loaded from the endpoint (consent-sources.ts). Without
   * it, the tag follows no consent source.
   */
  readonly consent?: (config: SiteConfig) => ConsentInput;
  /** Filled in as the boot resolves the endpoint and the site, for the tag errors' sink. */
  readonly target?: TagTarget;
  readonly now?: () => number;
}

/** A booted tag: where it sends, for which site, and with what settings. */
export interface Tag {
  readonly endpoint: string;
  readonly site: string;
  readonly config: SiteConfig;
}

/**
 * Boots the tag on win. Call it synchronously at a.js's top level: it reads
 * document.currentScript, which is null anywhere else. Returns the boot's remaining, asynchronous
 * part, which settles with the booted tag, or undefined when the tag didn't boot: its failure was
 * reported, another copy of a.js already runs on the page, or the config pinned another build, which
 * has loaded to run in its place. It never rejects and never throws.
 */
export function boot(win: TagWindow, options: BootOptions): Promise<Tag | undefined> {
  const { boundary, target, onPageExit } = options;
  const now = options.now || Date.now;
  /** The page_exits' destination, once the tag booted; until then a page_exit is dropped. */
  let exitTo: ((engagementMs: number) => void) | undefined;
  /** The installing script tag, a <script> element once endpointFromScript has accepted it. */
  let script: Element | undefined;
  const started = boundary.guard("boot", () => {
    if (!ensureStub(win)) return undefined;
    if (onPageExit) watchEngagement(win, boundary, (engagementMs) => exitTo?.(engagementMs), now);
    const current = currentScript(win.document);
    const endpoint = endpointFromScript(current, win.location);
    // endpointFromScript has checked that current is a <script> element.
    script = current!;
    if (target) target.endpoint = endpoint;
    const site = checkSiteId(script.getAttribute("data-site"));
    if (target) target.site = site;
    return fetchConfig(win.fetch.bind(win), endpoint, site).then((config) => ({ endpoint, site, config }));
  });
  if (started === undefined) return Promise.resolve(undefined);
  /** Starts the booted tag: from here on, this build runs on the page. */
  const run = (tag: Tag): Tag => {
    if (onPageExit) {
      exitTo = (engagementMs) => onPageExit(pageExitInput(win, tag.site, options.tagVersion, engagementMs, now()));
    }
    return start(win, tag, options);
  };
  return started.then(
    (tag) =>
      boundary.guard("boot", () => {
        const rate = errorSampleRate(tag.config);
        if (rate !== undefined) boundary.setSampleRate(rate);
        const pin = bundleVersion(tag.config);
        if (!shouldHandOff(pin, options.tagVersion, script!)) return run(tag);
        // The pinned build boots in this one's place, with the stub this one left. When it fails to
        // load, the failure is reported and this build runs, so the page is still tracked.
        return handOff(win.document, script!, tag.endpoint, pin!, options.tagVersion, win.location.origin).then(
          () => undefined,
          (error: unknown) => {
            boundary.report("boot", error);
            return boundary.guard("boot", () => run(tag));
          },
        );
      }),
    (error: unknown) => {
      boundary.report("config", error);
      return undefined;
    },
  );
}

/**
 * Runs the booted tag: Global Privacy Control, when the site honors it, so that nothing grants
 * before it denies; Consent Mode's state as the dataLayer has it so far, the TCF consent manager's
 * when the page has one, the adapter of a consent manager the page has or loads later (Cookiebot, OneTrust, Usercentrics),
 * which signals once it has loaded and connected through the `adapter` command, then the site's queued
 * commands (they may set what the pageview carries, such as consent; `privacy` shows the visitor
 * their ID, privacy.ts; `identify`, when the site turns it on, links the visitor to the site's
 * pseudonymous ref, identify.ts), then the first pageview,
 * the landing, which alone carries the landing URL's attribution (attribution.ts), then a pageview
 * on each route change, a form_submit for each form the page submits (forms.ts), and, when it is
 * turned on, a scroll event for each depth threshold the visitor reaches in each pageview (scroll.ts)
 * and the GA4 e-commerce events of the dataLayer, mapped to the tag's (ecommerce.ts).
 */
function start(win: TagWindow, tag: Tag, options: BootOptions): Tag {
  const { boundary, tagVersion, onPageview } = options;
  const now = options.now || Date.now;
  let lastUrl: string | undefined;
  /** Starts the scroll depth's count over, once the watcher runs (onScrollDepth). */
  let resetScroll: ScrollReset | undefined;
  const pageview = (): void => {
    boundary.guard("pageview", () => {
      const landing = lastUrl === undefined;
      const input = pageviewInput(win, tag.site, tagVersion, lastUrl === undefined ? win.document.referrer : lastUrl, now());
      lastUrl = input.url;
      // A new pageview's thresholds fire again, even if handing over its pageview fails.
      if (resetScroll) resetScroll();
      const attribution = landing ? attributionOf(input.url, customParams(tag.config)) : undefined;
      onPageview(attribution === undefined ? input : { ...input, attribution });
    });
  };
  // The privacy helper is there in every consent state: it only reads the visitor's ID (privacy.ts).
  const commands: Record<string, Command> = { pageview, [PRIVACY_COMMAND]: privacyCommand(win, boundary) };
  if (options.consent) {
    const ladder = createLadder(options.consent(tag.config));
    if (gpcHonored(tag.config)) boundary.guard("consent", () => honorGpc(win, ladder));
    boundary.guard("consent", () => watchConsentMode(win, boundary, ladder));
    boundary.guard("consent", () => watchTcf(win, boundary, ladder));
    const adapter = boundary.guard("consent", () =>
      watchCmpAdapters(win, boundary, ladder, (name) => loadAdapter(win.document, tag.endpoint, name, win.location.origin)),
    );
    if (adapter) commands[ADAPTER_COMMAND] = adapter;
    commands.consent = consentCommand(ladder);
  }
  const { onIdentify } = options;
  if (onIdentify) {
    commands[IDENTIFY_COMMAND] = identifyCommand(identifyEnabled(tag.config), (ref) =>
      onIdentify(identifyInput(win, tag.site, tagVersion, ref, now())),
    );
  }
  installCommands(win, commands, boundary);
  pageview();
  watchRoutes(win, boundary, pageview);
  const { onFormSubmit } = options;
  if (onFormSubmit) {
    boundary.guard("pageview", () =>
      watchForms(win, boundary, (props) => onFormSubmit(formSubmitInput(win, tag.site, tagVersion, props, now()))),
    );
  }
  const { onScrollDepth } = options;
  if (onScrollDepth) {
    resetScroll = boundary.guard("pageview", () =>
      watchScroll(win, boundary, (threshold) => onScrollDepth(scrollDepthInput(win, tag.site, tagVersion, threshold, now()))),
    );
  }
  const { onEcommerce } = options;
  if (onEcommerce) {
    boundary.guard("pageview", () =>
      watchEcommerce(win, boundary, (mapping) => onEcommerce(ecommerceInput(win, tag.site, tagVersion, mapping, now()))),
    );
  }
  return tag;
}
