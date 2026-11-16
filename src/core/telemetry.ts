// Sends the error boundary's reports to the collector as tag errors (schema/v1/tag-error.json),
// POST <endpoint>/v1/t, in every consent state: a tag error carries nothing about the visitor
// or the page, and goes without cookies. The boundary samples and caps them; this sends each one.

import { buildTagError } from "../wire/payload";
import { warn, type ErrorReport } from "./boundary";
import { DEFAULT_ENDPOINT, tagErrorRequestInit, tagErrorsUrl } from "./endpoint";

/** The share of page loads that report their failures, until the site's config sets another. */
export const ERROR_SAMPLE_RATE = 0.1;

/**
 * Where tag errors go and for which site, as far as the boot has got: the default collection host
 * and no site until it has resolved data-endpoint and data-site. A failure to resolve data-endpoint
 * is reported to the default host, never to the value it refused.
 */
export interface TagTarget {
  endpoint: string;
  site?: string;
}

export function defaultTarget(): TagTarget {
  return { endpoint: DEFAULT_ENDPOINT };
}

/**
 * A report sink that posts each report with fetchFn to target's endpoint. The send is a side
 * effect: a request that fails, or a response other than 2xx, is logged with console.warn, never
 * reported again (which would loop) or thrown.
 */
export function tagErrorSink(fetchFn: typeof fetch, tagVersion: string, target: TagTarget): (report: ErrorReport) => void {
  return (report) => {
    const body = JSON.stringify(
      buildTagError({
        tag_version: tagVersion,
        ...(target.site === undefined ? {} : { site_id: target.site }),
        stage: report.stage,
        name: report.name,
        message: report.message,
      }),
    );
    const url = tagErrorsUrl(target.endpoint);
    fetchFn(url, tagErrorRequestInit(body)).then(
      (response) => {
        if (!response.ok) warn(`amanda: POST ${url}: HTTP ${response.status}`, report);
      },
      (error: unknown) => warn(`amanda: POST ${url} failed`, report, error),
    );
  };
}
