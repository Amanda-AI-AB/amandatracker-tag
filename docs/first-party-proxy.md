# First-party reverse proxy

Serve the Amanda Tracker tag and its collection endpoint from your own website, through your own CDN or
web server. Visitors' browsers then talk only to your site. In Safari, the tracker's cookies keep their
full lifetime instead of expiring after 7 days.

This is a pattern you run on your own infrastructure. Amanda does not host it for you (see
[Why not a hosted tracking domain?](#why-not-a-hosted-tracking-domain)).

> **Availability.** The proxy works today for loading the tag, its config and sending events. The Safari
> cookie-lifetime benefit needs two changes that are still being built: the collector setting the cookies
> through your proxy (AAI-827), and the tag's `data-endpoint` attribute (AAI-828). This note goes away when
> both are live.

## What it does, and why

The tag stores two first-party cookies on your domain, and only when the visitor has granted analytics
consent:

| Cookie       | Holds                       | Lifetime            |
| ------------ | --------------------------- | ------------------- |
| `_amnda_id`  | a random visitor ID         | 13 months, rolling  |
| `_amnda_ses` | a random session ID         | 30 minutes, rolling |

Safari's Intelligent Tracking Prevention (ITP) caps every cookie that a script writes (`document.cookie`)
at **7 days**, or 24 hours when the visitor arrived from a link with tracking decoration. A returning
Safari visitor after a week is then counted as a new visitor.

Safari exempts cookies set by an **HTTP response** (`Set-Cookie`) from a server that is genuinely your
site's own. Since Safari 16.4 that means a server whose IP address shares the first half of your
website's IP address (the same IPv4 /16 or IPv6 /64). It does not mean a subdomain that is merely a DNS
alias for someone else's server.

With the proxy in place:

1. The page loads `a.js` from `https://www.example.com/amnda/a.js`, a path on your own site.
2. The tag sends events to `https://www.example.com/amnda/v1/e`.
3. Your CDN or web server forwards those requests to Amanda's collector.
4. When the visitor has granted analytics consent, the collector's response re-issues `_amnda_id` and
   `_amnda_ses` with `Set-Cookie`.
5. The browser receives that response from your own site's servers, so Safari keeps the cookie for its
   full lifetime.

**Consent is unchanged.**
- No cookie is set, by the tag or through the proxy, unless analytics consent is granted.
- When consent is withdrawn, the tag deletes both cookies straight away. The collector never marks them
  `HttpOnly`, so the tag can always remove them.
- The proxy changes where requests go, not what is collected or when.

## What you need

- A CDN, load balancer or web server that **already serves your website's pages**. The proxy must run on
  the same infrastructure, and so the same IP space, as your HTML. A proxy on a separate service, or on a
  separate subdomain served by another provider, does not get the Safari benefit.
- A path prefix on your site that nothing else uses. This guide uses **`/amnda/`**; any prefix works.
- Your site's public ID, from the Amanda portal.
- The collection host for your data region: **`eu.serversider.com`**.

## What the proxy must do

Forward every request under the prefix to the collection host, with the prefix removed:

| Your site                           | Collection host                                  |
| ----------------------------------- | ------------------------------------------------ |
| `/amnda/a.js`, `/amnda/a.<ver>.js`  | `https://eu.serversider.com/a.js`, `/a.<ver>.js` |
| `/amnda/cfg/*`                      | `https://eu.serversider.com/cfg/*`               |
| `/amnda/adapters/*`                 | `https://eu.serversider.com/adapters/*`          |
| `/amnda/v1/*`                       | `https://eu.serversider.com/v1/*`                |

The simplest way is to forward the whole prefix, as the examples below do. The proxy must also:

- **Connect over HTTPS, with SNI and `Host: eu.serversider.com`.** The collector refuses any other host.
- **Remove the `Cookie` header.** Your site's own cookies, such as logins and carts, must never leave your
  infrastructure. The tag sends the IDs the collector needs in the request body.
- **Remove the `Referer` header.** The tag asks for the page's origin alone, but a page's URL can carry
  personal data in its query (`/reset?email=…`), and the collector never needs it: it reads your host from
  `X-Forwarded-Host`.
- **Append the visitor's IP to `X-Forwarded-For`.** Append to it rather than replacing it. Amanda uses
  the IP in memory only, to derive country and region and to filter bots, and never stores it.
- **Set `X-Forwarded-Host` to your site's host** (e.g. `www.example.com`) and `X-Forwarded-Proto: https`.
  The collector sets cookies only for a host on your site's allowed-domain list in the Amanda portal, so
  add every host you proxy on to that list.
- **Pass the response back unchanged, `Set-Cookie` included.** Some CDNs drop `Set-Cookie` or rewrite its
  `Domain`; turn that off for this path.
- **Never cache `/amnda/v1/*`.**
- **Cache `a.js`, `cfg/*` and `adapters/*` for at most 5 minutes**, or simply follow the upstream
  `Cache-Control`. Site settings and the emergency kill switch reach visitors within 5 minutes, and a
  longer cache breaks that promise.
- **Allow `POST`** on `/amnda/v1/*`, and pass the body through unchanged.

## Install the tag from your proxy

Point both the script and its endpoint at your prefix:

```html
<script async src="/amnda/a.js" referrerpolicy="strict-origin" data-site="SITE_PUBLIC_ID" data-endpoint="/amnda"></script>
```

`referrerpolicy="strict-origin"` keeps the page's path and query out of the request for `a.js`, as the
tag itself does for every request it makes.

`data-endpoint` tells the tag to fetch its config and send its events through `/amnda` instead of the
collection host. If you install through Google Tag Manager, set the template's **Endpoint** field to
`/amnda`.

## Examples

### nginx

```nginx
location /amnda/ {
    proxy_pass https://eu.serversider.com/;          # the trailing slash strips /amnda
    proxy_ssl_server_name on;
    proxy_ssl_verify on;                             # nginx's default is off: accept no other certificate
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_verify_depth 3;
    proxy_set_header Host eu.serversider.com;
    proxy_set_header Cookie "";                      # never forward your site's cookies
    proxy_set_header Referer "";                     # nor the page's URL
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

**Keep `proxy_ssl_verify on`.** nginx does not check an upstream's TLS certificate unless you tell it to.
Without it, anyone on the path between your server and the collector can present any certificate, serve a
modified `a.js` from your own site to all of your visitors, and read every event.
`proxy_ssl_trusted_certificate` must point at your system's CA bundle, whose path differs per distribution:

| Distribution                       | CA bundle                            |
| ---------------------------------- | ------------------------------------ |
| Debian, Ubuntu, Alpine             | `/etc/ssl/certs/ca-certificates.crt` |
| RHEL, CentOS, Fedora, Amazon Linux | `/etc/pki/tls/certs/ca-bundle.crt`   |

nginx resolves a host name written literally in `proxy_pass` once, when it starts, and keeps using those
addresses until it reloads. If the collector's addresses change, requests fail until then. To have nginx
look the name up again, give it a `resolver` and put the host in a variable. With a variable, nginx no
longer strips the prefix for you, so a `rewrite` does it:

```nginx
location /amnda/ {
    resolver 127.0.0.53 valid=300s;                  # your own DNS resolver
    set $amnda_upstream eu.serversider.com;
    rewrite ^/amnda/(.*)$ /$1 break;                 # strip /amnda
    proxy_pass https://$amnda_upstream;
    # ...then the same proxy_ssl_* and proxy_set_header lines as above
}
```

nginx passes `Set-Cookie` through by default. Don't add `proxy_cookie_domain` or `proxy_hide_header
Set-Cookie` here. If this server has a `proxy_cache`, exclude `/amnda/v1/` from it.

If nginx sits behind another load balancer, make sure `$remote_addr` is the visitor's address
(`set_real_ip_from` / `real_ip_header`). Otherwise the load balancer's address is forwarded instead.

### Cloudflare Worker

Use this only when your website itself is served through Cloudflare. Route the Worker on
`www.example.com/amnda/*`.

```js
const UPSTREAM = "https://eu.serversider.com";
const PREFIX = "/amnda";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX + "/")) return new Response(null, { status: 404 });

    // Set the path on the upstream URL; never resolve it against UPSTREAM. A path such as
    // /amnda//evil.example/x would otherwise be read as protocol-relative, and reach another host.
    const target = new URL(UPSTREAM);
    target.pathname = url.pathname.slice(PREFIX.length);
    target.search = url.search;
    if (target.origin !== UPSTREAM) return new Response(null, { status: 400 });

    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("referer");
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip"));
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");

    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  },
};
```

The Worker returns the collector's response as it is, `Set-Cookie` and `Cache-Control` included. It
only ever forwards to `eu.serversider.com`: a path outside the prefix gets a 404, and any request whose
target would land on another origin gets a 400.

If you deployed an earlier version of this Worker that built its target with
`new URL(url.pathname.slice(PREFIX.length) + url.search, UPSTREAM)`, replace it with the one above. That
version followed paths such as `/amnda//other.example/x` to other hosts, and served their responses from
your site.

### Other CDNs

Any CDN that can route a path prefix to a different origin can do this; Fastly, Akamai, CloudFront and
Azure Front Door all can. Configure it the same way:

- an origin `eu.serversider.com` over HTTPS, with the host header set to it;
- a path rule `/amnda/*` that strips the prefix;
- the request-header rules above;
- caching off for `/amnda/v1/*`, at most 5 minutes elsewhere.

The proxy must run on the same CDN distribution as your website.

## Check it works

1. **The tag loads through your site:**

   ```sh
   curl -sI https://www.example.com/amnda/a.js                   # 200, content-type: text/javascript
   curl -s  https://www.example.com/amnda/cfg/SITE_PUBLIC_ID.json  # your site's config, as JSON
   ```

2. **Events go through your site.** Open the page with the browser's developer tools on the **Network**
   tab, and grant analytics consent in your consent banner. Requests go to `www.example.com/amnda/...`
   and none to `serversider.com`. `POST /amnda/v1/e` answers `2xx`.
3. **The cookies come from the server.** The response to `POST /amnda/v1/e` carries two `Set-Cookie`
   headers, `_amnda_id` and `_amnda_ses`, with `Domain=.example.com; Path=/; SameSite=Lax; Secure` and no
   `HttpOnly`.
4. **Safari keeps them.** In Safari, open Web Inspector → **Storage → Cookies**. `_amnda_id` expires in
   about 13 months, not in 7 days.
5. **Consent still rules.** Decline or withdraw consent: both cookies disappear, and further `/amnda/v1/e`
   responses carry no `Set-Cookie`.
6. **The site's events arrive.** The site's event debugger in the Amanda portal shows your test pageview.

### Troubleshooting

| Symptom                                       | Likely cause                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `a.js` returns 404 or your site's error page  | The prefix isn't stripped, or the route doesn't match `/amnda/*`.                    |
| TLS errors, or a 4xx from the collection host | The `Host` header isn't `eu.serversider.com`, or SNI is off.                         |
| nginx logs `upstream SSL certificate verify error` | `proxy_ssl_trusted_certificate` doesn't point at your system's CA bundle.       |
| `/v1/e` works but there's no `Set-Cookie`     | Consent isn't granted, `X-Forwarded-Host` is missing or not on the allowed-domain list, or the CDN strips `Set-Cookie`. |
| Safari still shows a 7-day expiry             | The proxy isn't on the same infrastructure as your pages (different IP space), or the cookie still comes from the script only. |
| All visitors appear to come from one place    | `X-Forwarded-For` holds your proxy's address, not the visitor's.                     |
| Settings changes take longer than 5 minutes   | The proxy caches `a.js` or `cfg/*` for longer than 5 minutes.                        |

## What the proxy is not

- **Not a way around consent.** The tag and the collector follow the visitor's consent exactly as without
  a proxy. The proxy only puts Amanda's requests on your own origin, where they belong as your
  first-party analytics.
- **Not a way to defeat browser privacy protections.** Safari keeps a server-set cookie because the
  server really is yours, not because it is disguised as yours.

## Why not a hosted tracking domain?

Some trackers offer a "custom tracking domain": you point a subdomain such as `t.example.com` at their
servers with a DNS CNAME. Amanda deliberately does not offer this, for two reasons:

1. **It doesn't deliver the benefit.** Safari detects CNAME cloaking and third-party IP addresses behind
   first-party names, and caps those cookies at 7 days anyway. Only a server that is genuinely yours, in
   your own IP space, lifts the cap. That is the proxy described here.
2. **It is an arms race we won't run.** The real draw of disguised tracking domains is dodging content
   blockers by rotating domains. A privacy-first product should not play that game against its own
   visitors' choices.

The customer-run reverse proxy is the supported alternative: it is genuinely first party, not a cloak.
