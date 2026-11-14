// Attribution capture (AAI-99): what the landing URL's query yields, the ads gate on click IDs, and
// the landing pageview carrying both through the boot, the consent machine and the payload builder
// to the event, as a.js is to wire them (AAI-964).
import { describe, expect, it } from "vitest";
import { attributionOf, CLICK_ID_PARAMS, gateClickIds, stripParams } from "../src/core/attribution";
import { boot } from "../src/core/boot";
import { ErrorBoundary, type ErrorReport } from "../src/core/boundary";
import { createConsent, type Consent, type ConsentMachine } from "../src/core/consent";
import type { PageviewInput } from "../src/core/pageview";
import { pingOf } from "../src/core/ping";
import type { WireEvent } from "../src/wire/generated";
import { buildEvent } from "../src/wire/payload";
import { fakeWindow, jsonResponse, PAGE, scriptTag } from "./fake-window";
import { validator } from "./wire-validator";

const LANDING =
  `${PAGE}/sale?utm_source=Google&utm_medium=cpc&utm_campaign=Summer%20Sale&utm_term=red+shoes` +
  "&utm_content=ad-1&utm_id=4711&utm_source_platform=Google%20Ads&utm_creative_format=video" +
  "&utm_marketing_tactic=remarketing&gclid=EAIaIQobChMI&gbraid=0AAAAA&wbraid=CjkKCQ&fbclid=IwAR0x" +
  "&msclkid=a1b2c3&ref=Partner-7&id=1#top";

const UTM = {
  source: "Google",
  medium: "cpc",
  campaign: "Summer Sale",
  term: "red shoes",
  content: "ad-1",
  id: "4711",
  source_platform: "Google Ads",
  creative_format: "video",
  marketing_tactic: "remarketing",
};
const CLICK_IDS = { gclid: "EAIaIQobChMI", gbraid: "0AAAAA", wbraid: "CjkKCQ", fbclid: "IwAR0x", msclkid: "a1b2c3" };

const GRANTED: Consent = { analytics: "granted", ads: "granted" };
const ADS_DENIED: Consent = { analytics: "granted", ads: "denied", source: "manual" };

describe("attributionOf", () => {
  it("reads the full UTM set, the M1 click IDs and the site's custom parameters", () => {
    expect(attributionOf(LANDING, ["ref"])).toEqual({ utm: UTM, click_ids: CLICK_IDS, custom: { ref: "Partner-7" } });
  });

  it("keeps values verbatim: Summer and summer stay distinct", () => {
    expect(attributionOf(`${PAGE}/?utm_campaign=Summer`, [])).toEqual({ utm: { campaign: "Summer" } });
    expect(attributionOf(`${PAGE}/?utm_campaign=summer`, [])).toEqual({ utm: { campaign: "summer" } });
    expect(attributionOf(`${PAGE}/?gclid=AbC-_x`, [])).toEqual({ click_ids: { gclid: "AbC-_x" } });
  });

  it("leaves out what is absent or empty, and gives nothing for a URL without any", () => {
    expect(attributionOf(`${PAGE}/?utm_source=&gclid=&utm_medium=email`, [])).toEqual({ utm: { medium: "email" } });
    expect(attributionOf(`${PAGE}/products?id=1`, ["ref"])).toBeUndefined();
    expect(attributionOf(`${PAGE}/`, [])).toBeUndefined();
  });

  it("reads only the custom parameters the config names", () => {
    expect(attributionOf(`${PAGE}/?ref=a&aff=b&other=c`, ["ref", "aff"])).toEqual({ custom: { ref: "a", aff: "b" } });
    expect(attributionOf(`${PAGE}/?ref=a`, [])).toBeUndefined();
  });

  it("leaves a custom name that is a UTM or a click ID to its own field, where the ads gate sees it", () => {
    expect(attributionOf(`${PAGE}/?gclid=g&utm_source=s&ref=r`, ["gclid", "utm_source", "ref"])).toEqual({
      utm: { source: "s" },
      click_ids: { gclid: "g" },
      custom: { ref: "r" },
    });
  });

  it("takes the first of a repeated parameter, and never reads the fragment", () => {
    expect(attributionOf(`${PAGE}/?utm_source=a&utm_source=b#utm_medium=c`, [])).toEqual({ utm: { source: "a" } });
  });
});

describe("stripParams", () => {
  it("drops the named parameters and leaves the rest exactly as written", () => {
    expect(stripParams(`${PAGE}/p?a=%20x+y&gclid=1&b=%E2%9C%93&fbclid=2#h`, CLICK_ID_PARAMS)).toBe(`${PAGE}/p?a=%20x+y&b=%E2%9C%93#h`);
  });

  it("drops the query mark when nothing is left, and keeps the fragment", () => {
    expect(stripParams(`${PAGE}/p?gclid=1&msclkid=2#h`, CLICK_ID_PARAMS)).toBe(`${PAGE}/p#h`);
  });

  it("matches a name however it is encoded, every time it repeats, and a name without a value", () => {
    expect(stripParams(`${PAGE}/?gcl%69d=1&x=1&gclid=2&gclid`, CLICK_ID_PARAMS)).toBe(`${PAGE}/?x=1`);
  });

  it("leaves a URL without them, a query in the fragment and a malformed escape alone", () => {
    for (const href of [`${PAGE}/p`, `${PAGE}/p?x=1`, `${PAGE}/p#?gclid=1`, `${PAGE}/p?%=1&x=%`]) {
      expect(stripParams(href, CLICK_ID_PARAMS)).toBe(href);
    }
  });
});

describe("gateClickIds", () => {
  const item = {
    url: `${PAGE}/sale?utm_source=g&gclid=G1#x`,
    referrer: `${PAGE}/home?fbclid=F1&q=1`,
    attribution: { utm: { source: "g" }, click_ids: { gclid: "G1" }, custom: { ref: "r" } },
  };

  it("leaves the item whole while ads isn't denied", () => {
    for (const ads of ["granted", "unknown", "no_cmp"] as const) {
      expect(gateClickIds(item, { analytics: "granted", ads })).toBe(item);
    }
  });

  it("under denied ads drops the click IDs only: from attribution, the url and the referrer", () => {
    expect(gateClickIds(item, ADS_DENIED)).toEqual({
      url: `${PAGE}/sale?utm_source=g#x`,
      referrer: `${PAGE}/home?q=1`,
      attribution: { utm: { source: "g" }, custom: { ref: "r" } },
    });
    expect(item.attribution.click_ids).toEqual({ gclid: "G1" });
  });

  it("drops attribution that held only click IDs", () => {
    const gated = gateClickIds({ url: `${PAGE}/?gclid=G1`, attribution: { click_ids: { gclid: "G1" } } }, ADS_DENIED);
    expect(gated).toEqual({ url: `${PAGE}/` });
    expect(gated).not.toHaveProperty("attribution");
  });
});

/** The tag booted on LANDING, its pageviews going through the consent machine to built events. */
async function landing(config: Record<string, unknown> = {}) {
  const win = fakeWindow(
    scriptTag({ src: "https://eu.serversider.com/a.js", "data-site": "site_123" }),
    jsonResponse({ schema_version: 1, site: "site_123", config_version: 1, custom_params: ["ref"], ...config }),
    LANDING,
  );
  const reports: ErrorReport[] = [];
  const events: WireEvent[] = [];
  const boundary = new ErrorBoundary((report) => reports.push(report), 1);
  let machine: ConsentMachine<PageviewInput> | undefined;
  await boot(win, {
    tagVersion: "0.2.0",
    boundary,
    onPageview: (input) => machine!.collect(input),
    consent: () => {
      machine = createConsent<PageviewInput>({
        declinedMode: "off",
        sink: {
          identified: (input, consent) =>
            events.push(
              buildEvent({
                ...gateClickIds(input, consent),
                visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
                session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
                consent,
              }),
            ),
          anonymous: () => undefined,
          withdraw: () => undefined,
        },
        identity: { forget: () => undefined, renew: () => undefined },
      });
      return machine;
    },
  });
  return { win, reports, events, consent: (signal: Partial<Consent>) => win.amanda!("consent", signal) };
}

describe("the landing pageview", () => {
  it("carries the attribution unmodified, and the wire schema accepts it", async () => {
    const page = await landing();
    page.consent({ analytics: "granted", ads: "granted" });

    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.attribution).toEqual({ utm: UTM, click_ids: CLICK_IDS, custom: { ref: "Partner-7" } });
    expect(page.events[0]!.url).toBe(LANDING.replace("#top", ""));
    const validate = validator("event.json");
    expect(validate(page.events[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(page.reports).toEqual([]);
  });

  it("under denied ads and granted analytics drops the click IDs only, the url's included", async () => {
    const page = await landing();
    page.consent({ analytics: "granted", ads: "denied" });

    const event = page.events[0]!;
    expect(event.attribution).toEqual({ utm: UTM, custom: { ref: "Partner-7" } });
    for (const name of CLICK_ID_PARAMS) expect(event.url).not.toContain(`${name}=`);
    expect(event.url).toContain("utm_campaign=Summer%20Sale");
    expect(event.url).toContain("ref=Partner-7");
    const validate = validator("event.json");
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it("is the only pageview that carries attribution: a route change is no landing", async () => {
    const page = await landing();
    page.consent({ analytics: "granted", ads: "granted" });
    page.win.history.pushState(null, "", "/cart?utm_source=internal");

    expect(page.events).toHaveLength(2);
    expect(page.events[1]!).not.toHaveProperty("attribution");
    // The previous URL is the route change's referrer, whole while ads is granted.
    expect(page.events[1]!.referrer).toBe(LANDING.replace("#top", ""));
  });

  it("drops the referrer's click IDs under denied ads", async () => {
    const page = await landing();
    page.consent({ analytics: "granted", ads: "denied" });
    page.win.history.pushState(null, "", "/cart");

    expect(page.events[1]!.referrer).not.toContain("gclid");
    expect(page.events[1]!.referrer).toContain("utm_source=Google");
  });

  it("reads no custom parameter when the config names none", async () => {
    const page = await landing({ custom_params: undefined });
    page.consent({ analytics: "granted", ads: "granted" });

    expect(page.events[0]!.attribution).toEqual({ utm: UTM, click_ids: CLICK_IDS });
  });

  it("never reaches an anonymous ping: no click IDs, and only the ping's frozen UTM fields", () => {
    const pageview: PageviewInput = {
      type: "pageview",
      site_id: "site_123",
      tag_version: "0.2.0",
      client_ts: 1,
      url: LANDING,
      attribution: { utm: UTM, click_ids: CLICK_IDS, custom: { ref: "Partner-7" } },
    };
    const ping = pingOf(pageview);

    expect(ping).not.toHaveProperty("attribution");
    expect(JSON.stringify(ping)).not.toMatch(/EAIaIQobChMI|Partner-7|remarketing/);
  });

  it("is cut, not refused, when a value is over the URL's cap", () => {
    const event = buildEvent({
      type: "pageview",
      site_id: "site_123",
      tag_version: "0.2.0",
      client_ts: 1,
      url: `${PAGE}/`,
      visitor_id: "01934f6c-8d2a-7b3c-8d4e-5f6a7b8c9d01",
      session_id: "01934f6c-8d2a-7b3c-ad4e-5f6a7b8c9d02",
      consent: GRANTED,
      attribution: { utm: { campaign: "c".repeat(3000) }, click_ids: { gclid: "g".repeat(3000) }, custom: { ref: "r".repeat(3000) } },
    });
    expect(event.attribution!.utm!.campaign).toHaveLength(2048);
    expect(event.attribution!.click_ids!.gclid).toHaveLength(2048);
    expect(event.attribution!.custom!.ref).toHaveLength(2048);
  });
});
