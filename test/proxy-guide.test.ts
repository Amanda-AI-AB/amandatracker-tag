import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Cloudflare Worker example in the first-party proxy guide, run as customers copy it.
const GUIDE = readFileSync(new URL("../docs/first-party-proxy.md", import.meta.url), "utf8");
const UPSTREAM = "https://eu.serversider.com";
const SITE = "https://www.customer.com";

function workerSource(): string {
  const section = GUIDE.split("### Cloudflare Worker")[1];
  if (section === undefined) throw new Error("the guide has no Cloudflare Worker section");
  const block = /```js\n([\s\S]*?)```/.exec(section);
  if (block === null) throw new Error("the Cloudflare Worker section has no js block");
  return block[1]!;
}

type Worker = { fetch(request: Request): Promise<Response> };

function loadWorker(fetchStub: (target: URL | string, init: RequestInit) => Promise<Response>): Worker {
  const source = workerSource();
  expect(source).toContain("export default {");
  const body = source.replace("export default {", "return {");
  return new Function("fetch", body)(fetchStub) as Worker;
}

async function run(path: string): Promise<{ status: number; targets: string[] }> {
  const targets: string[] = [];
  const worker = loadWorker(async (target) => {
    targets.push(String(target));
    return new Response("upstream", { status: 200 });
  });
  const response = await worker.fetch(new Request(SITE + path, { headers: { "cf-connecting-ip": "203.0.113.7" } }));
  return { status: response.status, targets };
}

describe("the proxy guide's Cloudflare Worker", () => {
  it("forwards the prefix's paths to the collection host, the prefix removed", async () => {
    expect(await run("/amnda/v1/e")).toEqual({ status: 200, targets: [`${UPSTREAM}/v1/e`] });
    expect(await run("/amnda/a.js?v=1")).toEqual({ status: 200, targets: [`${UPSTREAM}/a.js?v=1`] });
  });

  it.each([
    "/amnda//evil.example/x.html",
    "/amnda/%5Cevil.example/x",
    "/amnda/\\evil.example/x",
    "/amnda///evil.example/x",
    "/amnda//evil.example:443/x?y=1",
  ])("never leaves the collection host for %s", async (path) => {
    const { targets } = await run(path);
    for (const target of targets) expect(new URL(target).origin).toBe(UPSTREAM);
  });

  it.each(["/amndaX/v1/e", "/amnda", "/other/v1/e"])("refuses %s outside the prefix", async (path) => {
    expect(await run(path)).toEqual({ status: 404, targets: [] });
  });

  it("drops the site's cookies and the page's URL, and forwards the visitor's address", async () => {
    let sent: Headers | undefined;
    const worker = loadWorker(async (_target, init) => {
      sent = new Headers(init.headers);
      return new Response(null, { status: 204 });
    });
    await worker.fetch(
      new Request(`${SITE}/amnda/v1/e`, {
        method: "POST",
        body: "{}",
        headers: {
          cookie: "session=secret",
          referer: `${SITE}/reset?email=a@b.example`,
          "cf-connecting-ip": "203.0.113.7",
        },
      }),
    );
    expect(sent?.get("cookie")).toBeNull();
    expect(sent?.get("referer")).toBeNull();
    expect(sent?.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(sent?.get("x-forwarded-host")).toBe("www.customer.com");
  });

  it("appends the visitor's address to X-Forwarded-For rather than replacing it", async () => {
    let sent: Headers | undefined;
    const worker = loadWorker(async (_target, init) => {
      sent = new Headers(init.headers);
      return new Response(null, { status: 204 });
    });
    await worker.fetch(
      new Request(`${SITE}/amnda/v1/e`, {
        method: "POST",
        body: "{}",
        headers: { "x-forwarded-for": "198.51.100.1, 192.0.2.9", "cf-connecting-ip": "203.0.113.7" },
      }),
    );
    // The right-most entry, the one the collector reads, is the address the proxy saw.
    expect(sent?.get("x-forwarded-for")).toBe("198.51.100.1, 192.0.2.9, 203.0.113.7");
  });

  it("forwards only the allowlisted request headers, never Authorization", async () => {
    let sent: Headers | undefined;
    const worker = loadWorker(async (_target, init) => {
      sent = new Headers(init.headers);
      return new Response(null, { status: 204 });
    });
    await worker.fetch(
      new Request(`${SITE}/amnda/v1/e`, {
        method: "POST",
        body: "{}",
        headers: {
          authorization: "Basic dXNlcjpwYXNz",
          "x-site-secret": "s3cret",
          "content-type": "text/plain;charset=UTF-8",
          "user-agent": "Mozilla/5.0 test",
          "accept-language": "sv-SE",
          origin: SITE,
          "cf-connecting-ip": "203.0.113.7",
        },
      }),
    );
    expect(sent?.get("authorization")).toBeNull();
    expect(sent?.get("x-site-secret")).toBeNull();
    expect(sent?.get("cf-connecting-ip")).toBeNull();
    expect(sent?.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(sent?.get("user-agent")).toBe("Mozilla/5.0 test");
    expect(sent?.get("accept-language")).toBe("sv-SE");
    expect(sent?.get("origin")).toBe(SITE);
  });

  it("passes back only the tracker's Set-Cookie headers, and the rest of the response", async () => {
    const upstreamHeaders = new Headers({ "cache-control": "no-store", "content-type": "application/json" });
    upstreamHeaders.append("set-cookie", "_amnda_id=v1; Domain=.customer.com; Path=/; SameSite=Lax; Secure");
    upstreamHeaders.append("set-cookie", "session=attacker; Domain=.customer.com; Path=/; HttpOnly; Secure");
    upstreamHeaders.append("set-cookie", "_amnda_ses=s1; Domain=.customer.com; Path=/; SameSite=Lax; Secure");
    upstreamHeaders.append("set-cookie", "_amnda_idx=other; Path=/");
    const worker = loadWorker(async () => new Response("{}", { status: 202, headers: upstreamHeaders }));
    const response = await worker.fetch(new Request(`${SITE}/amnda/v1/e`, { method: "POST", body: "{}" }));
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("{}");
    expect(response.headers.getSetCookie()).toEqual([
      "_amnda_id=v1; Domain=.customer.com; Path=/; SameSite=Lax; Secure",
      "_amnda_ses=s1; Domain=.customer.com; Path=/; SameSite=Lax; Secure",
    ]);
  });
});

describe("the proxy guide's nginx example", () => {
  function nginxSection(): string {
    const section = GUIDE.split("### nginx")[1]?.split("### ")[0];
    if (section === undefined) throw new Error("the guide has no nginx section");
    return section;
  }

  function nginxBlock(): string {
    const block = /```nginx\n([\s\S]*?)```/.exec(nginxSection());
    if (block === null) throw new Error("the nginx section has no nginx block");
    return block[1]!;
  }

  type NjsRequest = { headersOut: Record<string, string[] | undefined> };

  function cookieFilter(): (r: NjsRequest) => void {
    const block = /```js\n([\s\S]*?)```/.exec(nginxSection());
    if (block === null) throw new Error("the nginx section has no njs block");
    expect(block[1]).toContain("export default {");
    const body = block[1]!.replace("export default {", "return {");
    return (new Function(body)() as { keepTrackerCookies: (r: NjsRequest) => void }).keepTrackerCookies;
  }

  it("verifies the collector's certificate, which nginx does not by default", () => {
    const block = nginxBlock();
    expect(block).toMatch(/^\s*proxy_ssl_server_name on;/m);
    expect(block).toMatch(/^\s*proxy_ssl_verify on;/m);
    expect(block).toMatch(/^\s*proxy_ssl_trusted_certificate \S+;/m);
    expect(block).toMatch(/^\s*proxy_ssl_verify_depth \d+;/m);
  });

  it("forwards only the request headers it sets, never Authorization or Cookie", () => {
    const block = nginxBlock();
    expect(block).toMatch(/^\s*proxy_pass_request_headers off;/m);
    expect(block).not.toMatch(/^\s*proxy_set_header (Authorization|Cookie|Referer) \$/im);
    expect(block).toMatch(/^\s*js_header_filter amnda\.keepTrackerCookies;/m);
  });

  it("filters the response's Set-Cookie headers down to the tracker's", () => {
    const keep = cookieFilter();
    const r: NjsRequest = {
      headersOut: {
        "Set-Cookie": ["_amnda_id=v1; Path=/", "session=attacker; Path=/; HttpOnly", "_amnda_ses=s1; Path=/"],
      },
    };
    keep(r);
    expect(r.headersOut["Set-Cookie"]).toEqual(["_amnda_id=v1; Path=/", "_amnda_ses=s1; Path=/"]);

    const others: NjsRequest = { headersOut: { "Set-Cookie": ["session=attacker; Path=/"] } };
    keep(others);
    expect("Set-Cookie" in others.headersOut).toBe(false);

    const none: NjsRequest = { headersOut: {} };
    keep(none);
    expect(none.headersOut).toEqual({});
  });
});
