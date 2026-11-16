// A stand-in for document.cookie that keeps cookies as a browser does, for the identity tests: it
// refuses a cookie on a public suffix or on a domain the page isn't on, and a Secure cookie on an
// http: page; it matches a write to the cookie it replaces by name, domain and path; and it drops a
// cookie whose Max-Age has passed by the clock it is given. A server may set an HttpOnly cookie,
// which document.cookie neither shows nor overwrites.

/** The public suffixes this jar knows, as a browser's list would have them. */
export const PUBLIC_SUFFIXES = ["com", "se", "uk", "co.uk", "github.io"];

export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  /** The Domain attribute without its dot, or undefined for a host-only cookie. */
  readonly domain: string | undefined;
  readonly path: string;
  readonly expires: number;
  readonly secure: boolean;
  readonly sameSite: string | undefined;
  /** Set only by serverSet: document.cookie can't write HttpOnly. */
  readonly httpOnly?: boolean;
}

export class CookieJar {
  /** Every string written to document.cookie, in order, kept or not. */
  readonly writes: string[] = [];
  private cookies: StoredCookie[] = [];

  constructor(
    private readonly hostname: string,
    private readonly now: () => number = Date.now,
    private readonly https = true,
  ) {}

  /** The cookies the page sees now. */
  get cookie(): string {
    return this.live()
      .filter((c) => c.path === "/" && !c.httpOnly)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  set cookie(value: string) {
    this.writes.push(value);
    const [pair, ...attributes] = value.split(";").map((part) => part.trim());
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq);
    const cookieValue = pair!.slice(eq + 1);
    let domain: string | undefined;
    let path = "/";
    let maxAge = Infinity;
    let secure = false;
    let sameSite: string | undefined;
    for (const attribute of attributes) {
      const [key, val = ""] = attribute.split("=");
      const k = key!.toLowerCase();
      if (k === "domain") domain = val.replace(/^\./, "").toLowerCase();
      else if (k === "path") path = val;
      else if (k === "max-age") maxAge = Number(val);
      else if (k === "secure") secure = true;
      else if (k === "samesite") sameSite = val;
    }
    if (secure && !this.https) return;
    if (domain !== undefined) {
      if (PUBLIC_SUFFIXES.indexOf(domain) >= 0) return;
      if (domain !== this.hostname && !this.hostname.endsWith(`.${domain}`)) return;
    }
    const same = (c: StoredCookie): boolean => c.name === name && c.domain === domain && c.path === path;
    // A script can neither overwrite nor delete an HttpOnly cookie.
    if (this.cookies.some((c) => same(c) && c.httpOnly)) return;
    this.cookies = this.cookies.filter((c) => !same(c));
    if (maxAge <= 0) return;
    this.cookies.push({ name, value: cookieValue, domain, path, expires: this.now() + maxAge * 1000, secure, sameSite });
  }

  /** The cookies kept and not expired, with their attributes. */
  live(): StoredCookie[] {
    return this.cookies.filter((c) => c.expires > this.now());
  }

  /**
   * Puts a cookie in the jar as a server's Set-Cookie would, bypassing document.cookie: Secure and
   * SameSite=Lax, replacing the one of the same name, domain and path.
   */
  serverSet(cookie: Omit<StoredCookie, "expires" | "secure" | "sameSite"> & { maxAge: number }): void {
    const { maxAge, ...stored } = cookie;
    this.cookies = this.cookies.filter((c) => !(c.name === stored.name && c.domain === stored.domain && c.path === stored.path));
    this.cookies.push({ ...stored, expires: this.now() + maxAge * 1000, secure: true, sameSite: "Lax" });
  }
}
