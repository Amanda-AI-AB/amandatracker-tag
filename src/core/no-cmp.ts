// The no-CMP policy (02 §4): what a site with no consent manager at all decides for the categories
// in no_cmp. The site picks it in its config (consent.no_cmp_policy, config.ts):
//
//   geo            -> the default: the collector's anonymous jurisdiction hint, GET /v1/policy
//                     (AAI-93), denied in the EEA, the UK and Switzerland and granted elsewhere;
//   assume_denied  -> always denied, the safest;
//   assume_granted -> always granted. Badged "check local law" in the control plane and accepted
//                     there explicitly; never the default, and never the recommendation in Germany.
//
// geo never assumes a grant: any answer but a well-formed 200 resolves to denied, and a failure
// that isn't the collector's own refusal (a network error, a 5xx, a malformed body) is reported
// to the error boundary as well. The hint is asked without cookies, before any consent is known.

import type { ErrorBoundary } from "./boundary";
import type { NoCmpDecision, NoCmpPolicy } from "./consent";
import { policyRequestInit, policyUrl } from "./endpoint";

export class PolicyError extends Error {
  override name = "PolicyError";

  constructor(
    message: string,
    /** The response's HTTP status, when the collector answered with something other than 200. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The collector's per-IP rate limit: an expected refusal, not the tag's failure, so not reported. */
const RATE_LIMITED = 429;

/**
 * The collector's jurisdiction hint: GET /v1/policy's `{"consent": "granted" | "denied"}`. Rejects
 * with PolicyError for a response other than 200 or a body of another shape, and with fetch's own
 * TypeError for a network failure.
 */
export async function fetchPolicyHint(fetchFn: typeof fetch, endpoint: string): Promise<NoCmpDecision> {
  const url = policyUrl(endpoint);
  const response = await fetchFn(url, policyRequestInit());
  if (response.status !== 200) throw new PolicyError(`GET ${url}: HTTP ${response.status}`, response.status);
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PolicyError(`GET ${url}: the body is not JSON`);
  }
  const consent = typeof json === "object" && json !== null ? (json as Record<string, unknown>).consent : undefined;
  if (consent !== "granted" && consent !== "denied") {
    throw new PolicyError(`GET ${url}: consent is not granted or denied: ${String(consent)}`);
  }
  return consent;
}

/**
 * Resolves the site's no-CMP policy to a decision. `geo` asks the collector (fetchPolicyHint), and
 * resolves to denied when that fails, reporting the failure to boundary unless the collector rate
 * limited it. Never rejects.
 */
export function resolveNoCmpPolicy(
  policy: NoCmpPolicy,
  fetchFn: typeof fetch,
  endpoint: string,
  boundary: ErrorBoundary,
): Promise<NoCmpDecision> {
  if (policy === "assume_denied") return Promise.resolve("denied");
  if (policy === "assume_granted") return Promise.resolve("granted");
  return fetchPolicyHint(fetchFn, endpoint).then(undefined, (error: unknown) => {
    if (!(error instanceof PolicyError && error.status === RATE_LIMITED)) {
      boundary.report("consent", error);
    }
    return "denied" as const;
  });
}
