import { describe, expect, test } from "bun:test";
import {
  AUDIT_INSTRUCTIONS,
  applyAuditAnswer,
  auditCandidates,
  auditPrompt,
  candidatesToIssues,
  countBySeverity,
  maskSecrets,
  parseAuditAnswer,
} from "../../src/index";
import type { AuditInput, AuditRequest } from "../../src/index";
import { stableFileName } from "../../src/audit/text";

function req(over: Partial<AuditRequest>): AuditRequest {
  return {
    method: "GET",
    url: "https://www.example.com/",
    resourceType: "Document",
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "text/html",
    responseText: null,
    ...over,
  };
}

const SAFE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self'",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
};

function input(over: Partial<AuditInput>): AuditInput {
  return {
    origin: "https://www.example.com",
    requests: [req({ responseHeaders: SAFE_HEADERS })],
    scripts: [],
    sourceMappedScripts: [],
    cookies: [],
    storageKeys: [],
    isSiteHost: (host) =>
      host === "example.com" || host.endsWith(".example.com"),
    ...over,
  };
}

function rules(i: AuditInput): string[] {
  return auditCandidates(i).map((c) => c.rule);
}

// Stripe-shaped test keys are built at run time: a literal one in the source
// trips GitHub push protection.
const SK_LIVE = "sk_" + "live_";
const RK_LIVE = "rk_" + "live_";

describe("masking", () => {
  test("masks keys and URL passwords", () => {
    const text = `k="${SK_LIVE}abcdefghijklmnop1234" db="postgres://app:hunter22@db.internal/x"`;
    const masked = maskSecrets(text);
    expect(masked).not.toContain("abcdefghijklmnop");
    expect(masked).not.toContain("hunter22");
    expect(masked).toContain("sk_l…34");
  });

  test("masks Google tokens and any value under a secret-named key", () => {
    // Built at run time, like the Stripe keys above.
    const refresh = "1/" + "/0gUYQkaCLFni7CgYIARAAGBASNwF-L9Ir";
    const access = "ya2" + "9.a0AfB_byC1234567890abcdefghij";
    const fbSecret = "13aca571f6ed26c78e5dc1a72befb4c5";
    const text = `r={client_id:"284234693351270",client_secret:"${fbSecret}",refresh_token:"${refresh}",x:"${access}","password": "hunter2hunter2",grant_type:"authorization_code"}`;
    const masked = maskSecrets(text);
    for (const secret of [fbSecret, refresh, access, "hunter2hunter2"])
      expect(masked).not.toContain(secret);
    expect(masked).toContain('client_secret:"13ac…c5"');
    expect(masked).toContain('client_id:"284234693351270"');
    expect(masked).toContain('grant_type:"authorization_code"');
    expect(maskSecrets('client_secret:"GOCS…gf"')).toBe('client_secret:"GOCS…gf"');
  });

  test("stable file names drop build hashes", () => {
    expect(stableFileName("https://x.com/static/js/main.3f2a9c1b.js?v=2")).toBe(
      "main.js",
    );
    expect(stableFileName("chunk-AB12CD34.mjs")).toBe("chunk.mjs");
  });
});

describe("code rules", () => {
  test("finds a live secret in first-party code, masked, and skips third-party code", () => {
    const key = `${SK_LIVE}51HxQabcdEFGHijklMNOPqrst`;
    const c = auditCandidates(
      input({
        scripts: [
          {
            file: "main.js",
            url: null,
            text: `const k = "${key}";`,
            firstParty: true,
          },
          {
            file: "widget.js",
            url: null,
            text: `const k = "${RK_LIVE}ZZZZZZZZZZZZZZZZZZZZ";`,
            firstParty: false,
          },
        ],
      }),
    ).filter((x) => x.rule === "secret-in-code");
    expect(c).toHaveLength(1);
    expect(c[0]!.severity).toBe("critical");
    expect(JSON.stringify(c[0])).not.toContain(key);
    expect(c[0]!.evidence[0]).toMatchObject({
      kind: "code",
      file: "main.js",
      line: 1,
    });
  });

  test("ignores placeholders and anon JWTs, flags service-role JWTs", () => {
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const anon = `eyJhbGciOiJIUzI1NiJ9.${b64({ role: "anon", iss: "supabase" })}.sigsigsigsigsig`;
    const service = `eyJhbGciOiJIUzI1NiJ9.${b64({ role: "service_role", iss: "supabase" })}.sigsigsigsigsig`;
    const found = (text: string) =>
      rules(
        input({
          scripts: [{ file: "a.js", url: null, text, firstParty: true }],
        }),
      );
    expect(found('password: "your_password_here"')).not.toContain(
      "secret-in-code",
    );
    expect(found(`const k="${anon}"`)).not.toContain("secret-in-code");
    expect(found(`const k="${service}"`)).toContain("secret-in-code");
  });

  test("DOM sinks need a tainted source nearby", () => {
    const tainted =
      'el.innerHTML = new URLSearchParams(location.search).get("q");';
    const constant = 'el.innerHTML = "<b>hi</b>";';
    const found = (text: string) =>
      rules(
        input({
          scripts: [{ file: "a.js", url: null, text, firstParty: true }],
        }),
      );
    expect(found(tainted)).toContain("dom-xss-sink");
    expect(found(constant)).not.toContain("dom-xss-sink");
    expect(
      found('location.href = new URLSearchParams(location.search).get("next")'),
    ).toContain("open-redirect");
  });

  test("message handlers without an origin check", () => {
    const found = (text: string) =>
      rules(
        input({
          scripts: [{ file: "a.js", url: null, text, firstParty: true }],
        }),
      );
    expect(
      found(
        'window.addEventListener("message", function(e){ run(e.data.cmd) })',
      ),
    ).toContain("postmessage-no-origin-check");
    expect(
      found(
        'window.addEventListener("message", function(e){ if (e.origin !== O) return; run(e.data) })',
      ),
    ).not.toContain("postmessage-no-origin-check");
  });

  test("tokens in web storage, public source maps, internal hosts", () => {
    const c = rules(
      input({
        storageKeys: ["access_token", "theme"],
        sourceMappedScripts: [
          "https://www.example.com/static/main.js",
          "https://cdn.other.com/x.js",
        ],
        scripts: [
          {
            file: "a.js",
            url: null,
            text: 'fetch("http://10.0.3.7:8080/api")',
            firstParty: true,
          },
        ],
      }),
    );
    expect(c).toContain("token-in-web-storage");
    expect(c).toContain("public-source-map");
    expect(c).toContain("internal-url-in-code");
  });
});

describe("traffic rules", () => {
  test("missing headers on most pages of a host", () => {
    const c = rules(
      input({ requests: [req({}), req({ url: "https://www.example.com/a" })] }),
    );
    expect(c).toEqual(
      expect.arrayContaining([
        "missing-csp",
        "missing-hsts",
        "missing-frame-protection",
        "missing-nosniff",
      ]),
    );
    expect(rules(input({}))).toEqual([]);
  });

  test("weak CSP, version banner", () => {
    const c = rules(
      input({
        requests: [
          req({
            responseHeaders: {
              "Strict-Transport-Security": "max-age=31536000",
              "X-Content-Type-Options": "nosniff",
              "content-security-policy":
                "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
              server: "nginx/1.18.0",
            },
          }),
        ],
      }),
    );
    expect(c).toContain("weak-csp");
    expect(c).toContain("version-disclosure");
  });

  test("a weak CSP is quoted by its script directive", () => {
    const long = `default-src 'self'; connect-src ${"https://a.example.com ".repeat(40)}; script-src 'self' 'unsafe-eval'; frame-ancestors 'none'`;
    const [weak] = auditCandidates(
      input({
        requests: [
          req({
            responseHeaders: {
              ...SAFE_HEADERS,
              "Content-Security-Policy": long,
            },
          }),
        ],
      }),
    ).filter((x) => x.rule === "weak-csp");
    expect(weak!.evidence[0]!.snippet).toBe(
      "content-security-policy: script-src 'self' 'unsafe-eval'",
    );
  });

  test("CORS with credentials, cookies, mixed content", () => {
    const c = rules(
      input({
        requests: [
          req({ responseHeaders: SAFE_HEADERS }),
          req({
            url: "https://api.example.com/v1/me",
            resourceType: "Fetch",
            mimeType: "application/json",
            responseHeaders: {
              "access-control-allow-origin": "null",
              "access-control-allow-credentials": "true",
            },
          }),
          req({
            url: "http://img.example.net/a.png",
            resourceType: "Image",
            mimeType: "image/png",
          }),
        ],
        cookies: [
          {
            domain: ".example.com",
            name: "session_id",
            path: "/",
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
          {
            domain: ".example.com",
            name: "csrftoken",
            path: "/",
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
          },
          {
            domain: ".tracker.com",
            name: "auth",
            path: "/",
            httpOnly: false,
            secure: false,
            sameSite: null,
          },
        ],
      }),
    );
    expect(c).toContain("cors-null-origin");
    expect(c.filter((r) => r === "insecure-session-cookie")).toHaveLength(1);
    expect(c).toContain("mixed-content");
  });

  test("API exposure: secret fields, personal data without credentials, verbose errors", () => {
    const api = (over: Partial<AuditRequest>) =>
      req({ resourceType: "XHR", mimeType: "application/json", ...over });
    const c = auditCandidates(
      input({
        requests: [
          req({ responseHeaders: SAFE_HEADERS }),
          api({
            url: "https://www.example.com/api/users/42",
            responseText: JSON.stringify({
              id: 42,
              email: "user1@example.com",
              password_hash: "$2b$...",
            }),
          }),
          api({
            url: "https://www.example.com/api/me",
            requestHeaders: { authorization: "<BEARER:ab12>" },
            responseText: JSON.stringify({ email: "user2@example.com" }),
          }),
          api({
            url: "https://www.example.com/api/search",
            status: 200,
            responseText: JSON.stringify({
              error: "SQLSTATE[42000]: Syntax error",
            }),
          }),
        ],
      }),
    );
    const byRule = new Map(c.map((x) => [x.rule, x]));
    expect(byRule.get("sensitive-field-in-response")?.severity).toBe("high");
    const pii = c.filter((x) => x.rule === "unauthenticated-pii");
    expect(pii).toHaveLength(1);
    expect(pii[0]!.cwe).toBe("CWE-639");
    expect(byRule.has("verbose-error")).toBe(true);
  });
});

describe("model review", () => {
  const candidates = auditCandidates(input({ requests: [req({})] }));

  test("candidates are numbered, sorted by severity and fingerprinted uniquely", () => {
    expect(candidates[0]!.id).toBe("c1");
    const fps = candidates.map((c) => c.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
    const ranks = candidates.map((c) =>
      ["critical", "high", "medium", "low", "info"].indexOf(c.severity),
    );
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(auditPrompt("https://www.example.com", candidates)).toContain(
      '"id":"c1"',
    );
  });

  test("parses fenced answers and rejects other shapes", () => {
    expect(
      parseAuditAnswer('```json\n{"issues":[{"id":"c1","keep":false}]}\n```'),
    ).toEqual([{ id: "c1", keep: false }]);
    expect(parseAuditAnswer("no json")).toBeNull();
    expect(parseAuditAnswer({ items: [] })).toBeNull();
    expect(
      parseAuditAnswer({ issues: [{ id: "c1", severity: "urgent" }] }),
    ).toEqual([{ id: "c1", keep: true }]);
  });

  test("applies keep, severity and text; never changes rule fields", () => {
    const issues = applyAuditAnswer(candidates, [
      { id: "c1", keep: false },
      { id: "c2", keep: true, severity: "medium", title: "Better title" },
    ]);
    expect(issues).toHaveLength(candidates.length - 1);
    expect(issues[0]).toMatchObject({
      severity: "medium",
      title: "Better title",
      rule: candidates[1]!.rule,
      fingerprint: candidates[1]!.fingerprint,
    });
    expect(issues[0]).not.toHaveProperty("id");
    expect(candidatesToIssues(candidates)).toHaveLength(candidates.length);
    expect(countBySeverity(issues).medium).toBeGreaterThan(0);
  });
});

test("client-code rules read original sources over the mapped built file", () => {
  const sink = "el.innerHTML = location.hash.slice(1);";
  const c = auditCandidates(
    input({
      scripts: [
        {
          file: "main.3f2a9c1b.js",
          url: null,
          text: sink,
          firstParty: true,
          mapped: true,
        },
        { file: "src/render.ts", url: null, text: sink, firstParty: true },
      ],
    }),
  ).filter((x) => x.rule === "dom-xss-sink");
  expect(c.map((x) => x.evidence[0]!.file)).toEqual(["src/render.ts"]);
});

describe("false positives seen on real sites", () => {
  const code = (text: string) =>
    rules(
      input({ scripts: [{ file: "a.js", url: null, text, firstParty: true }] }),
    );

  test("field-name maps are not secrets", () => {
    expect(
      code('{password:"passwordInput",email:"emailAddressInput"}'),
    ).not.toContain("secret-in-code");
    expect(code('const cfg={client_secret:"a8F3kq92LmZx7Qp1"}')).toContain(
      "secret-in-code",
    );
  });

  test("worker and bound handlers are not window message handlers", () => {
    expect(code("u.onmessage=function(e){var t=e.data.id}")).not.toContain(
      "postmessage-no-origin-check",
    );
    expect(
      code('self.addEventListener("message",function(e){go(e.data)})'),
    ).not.toContain("postmessage-no-origin-check");
    expect(
      code('window.addEventListener("message",this.handleMessage.bind(this))'),
    ).not.toContain("postmessage-no-origin-check");
    expect(code("window.onmessage=e=>go(e.data)")).toContain(
      "postmessage-no-origin-check",
    );
  });

  test("Web3Modal frame handlers bundled into site chunks are library code", () => {
    const w3m =
      "onFrameEvent:e=>{a.isClient&&window.addEventListener(`message`,({data:t})=>{if(!er(l.FRAME_EVENT_KEY,t))return;let n=$n.frameEvent.safeParse(t);n.success?e(n.data):console.warn(`W3mFrame: invalid frame event`)})}";
    expect(code(w3m)).not.toContain("postmessage-no-origin-check");
    expect(
      code(
        'window.addEventListener("message",({data:i})=>{if(!i.type?.includes(ut.APP_EVENT_KEY))return;r(i)})',
      ),
    ).not.toContain("postmessage-no-origin-check");
  });

  test("a navigation to the raw location.hash stays on the page", () => {
    expect(
      code(
        'mounted:function(){this.refreshAos(),location.hash&&(location.href=location.hash),c.track("pc home mounted","")}',
      ),
    ).not.toContain("open-redirect");
    expect(code("window.location = window.location.hash;")).not.toContain("open-redirect");
    expect(code("location.href = location.hash.slice(1);")).toContain("open-redirect");
    expect(code('location.replace(location.hash.replace("#", ""))')).toContain("open-redirect");
  });

  test("a redirect to a constant next to unrelated message data is not tainted", () => {
    expect(
      code("window.location.href=l.Z.HOME,(0,s.Z)().isNotEmpty(e.data.cart)"),
    ).not.toContain("open-redirect");
  });

  test("labels and sample values in translation files are not personal data", () => {
    const c = rules(
      input({
        requests: [
          req({ responseHeaders: SAFE_HEADERS }),
          req({
            url: "https://www.example.com/locales/en/home.json",
            resourceType: "Fetch",
            mimeType: "application/json",
            responseText: JSON.stringify({
              hero: { email: "user1@example.com", mobile: "+15550000001" },
            }),
          }),
        ],
      }),
    );
    expect(c).not.toContain("unauthenticated-pii");
  });

  test("addresses the site masked are not personal data", () => {
    const c = rules(
      input({
        requests: [
          req({ responseHeaders: SAFE_HEADERS }),
          req({
            url: "https://www.example.com/api/leaderboard",
            resourceType: "XHR",
            mimeType: "application/json",
            responseText: JSON.stringify({
              ranks: [
                { email: "masked1@example.com" },
                { email: "masked2@example.com" },
                { email: "ab***@gmail.com" },
              ],
            }),
          }),
        ],
      }),
    );
    expect(c).not.toContain("unauthenticated-pii");
  });

  test("the reviewer is told that pseudonymized values are real", () => {
    expect(AUDIT_INSTRUCTIONS).toContain("user<N>@example.com");
    expect(AUDIT_INSTRUCTIONS).toContain("masked<N>@example.com");
  });
});
