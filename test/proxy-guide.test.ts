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
});

describe("the proxy guide's nginx example", () => {
  function nginxBlock(): string {
    const section = GUIDE.split("### nginx")[1]?.split("### ")[0];
    if (section === undefined) throw new Error("the guide has no nginx section");
    const block = /```nginx\n([\s\S]*?)```/.exec(section);
    if (block === null) throw new Error("the nginx section has no nginx block");
    return block[1]!;
  }

  it("verifies the collector's certificate, which nginx does not by default", () => {
    const block = nginxBlock();
    expect(block).toMatch(/^\s*proxy_ssl_server_name on;/m);
    expect(block).toMatch(/^\s*proxy_ssl_verify on;/m);
    expect(block).toMatch(/^\s*proxy_ssl_trusted_certificate \S+;/m);
    expect(block).toMatch(/^\s*proxy_ssl_verify_depth \d+;/m);
  });
});
