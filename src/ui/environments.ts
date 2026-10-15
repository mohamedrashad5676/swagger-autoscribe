/**
 * Postman-style variables and environments for Swagger UI.
 *
 * A small script is injected into the docs page (`customJsStr`). It
 *  - adds an environment picker + "Variables" manager to the page,
 *  - replaces `{{name}}` in every request Swagger UI sends (URL, query, path, headers, JSON / form body, the Authorize dialog),
 *  - fills variables from responses (login -> `token`) with configurable capture rules,
 *  - supports dynamic variables (`{{$guid}}`, `{{$timestamp}}`, …), secrets, import / export of Postman environment files.
 * Everything lives in the browser (localStorage); nothing is sent anywhere.
 */

export interface EnvironmentCapture {
  /** Variable to fill (e.g. `token`). */
  variable: string;
  /** Path inside the JSON response body (`data.accessToken`, `items[0].id`). */
  from: string;
  /** Only responses whose URL contains this text (or matches `/regex/`). */
  urlIncludes?: string;
  /** Only this HTTP method (case-insensitive). */
  method?: string;
  /** Store as a global instead of in the active environment. */
  scope?: 'environment' | 'global';
  /** Mask the value in the manager. Default: true for names containing token / secret / password / key. */
  secret?: boolean;
}

export interface EnvironmentsOptions {
  enabled?: boolean;
  /** Environments offered out of the box: `{ Local: { baseUrl: 'http://localhost:3000' }, Staging: { … } }`. Users can edit / add more. */
  environments?: Record<string, Record<string, string>>;
  /** Variables available in every environment. */
  globals?: Record<string, string>;
  /** Extra capture rules (the automatic detection below needs none). `false` removes them. */
  captures?: EnvironmentCapture[] | false;
  /**
   * Automatic detection (all editable from the UI, all on by default):
   *  - `tokens`: finds the access / refresh token in any auth-like JSON response whatever the key is called (JWT shape, `token`-ish keys, `Authorization` response header);
   *  - `ids`: `id` / `…Id` / `_id` of a response fill the matching route variable (`POST /plans` -> `{{id}}` for `/plans/{id}`);
   *  - `fill`: empty path / query inputs are pre-filled from the variable with the same name.
   */
  auto?: false | { tokens?: boolean; tokenVariable?: string; refreshVariable?: string; authUrls?: string; ids?: boolean; fill?: boolean };
  /** Environment selected the first time. Default: the first one. */
  active?: string;
  /**
   * Variable that, when set in the active environment, replaces the origin of every API request
   * (needs CORS on the target). Default `baseUrl`; `false` turns the rewrite off.
   */
  baseUrlVariable?: string | false;
  /**
   * Adds `Authorization: <scheme> {{<variable>}}` to requests that carry no Authorization header once that variable has a value.
   * Default `{ variable: 'token', scheme: 'Bearer' }`; `false` turns it off.
   */
  authorization?: { variable?: string; scheme?: string } | false;
}

/** Common shapes of login / refresh responses (plain, `{ data: … }` envelopes, snake_case). */
export const defaultCaptures: EnvironmentCapture[] = [
  { variable: 'token', from: 'data.accessToken', urlIncludes: '/login' },
  { variable: 'token', from: 'accessToken', urlIncludes: '/login' },
  { variable: 'token', from: 'data.access_token', urlIncludes: '/login' },
  { variable: 'token', from: 'access_token', urlIncludes: '/login' },
  { variable: 'token', from: 'token', urlIncludes: '/login' },
  { variable: 'token', from: 'data.accessToken', urlIncludes: '/refresh' },
  { variable: 'token', from: 'accessToken', urlIncludes: '/refresh' },
];

// The function below is serialised with toString() and runs in the browser: keep it self-contained (no imports, no TS-only helpers).
/* eslint-disable */
function client(cfg: any): void {
  const w: any = (globalThis as any).window ?? globalThis;
  const doc: any = w.document;
  if (!doc || w.__autodocEnv) return;
  var pickerReady = false; // set once the picker below is built (refresh() runs earlier)
  const KEY = 'autodoc-env:' + w.location.pathname;
  const SECRET = /token|secret|password|passwd|key|authorization/i;
  const VAR = /\{\{\s*([\w$.\-]+)\s*\}\}/g;

  const load = (): any => {
    try {
      return JSON.parse(w.localStorage.getItem(KEY) || 'null');
    } catch (e) {
      return null;
    }
  };
  const persist = (): void => {
    try {
      w.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* storage blocked: works for this page view only */
    }
  };
  const row = (key: string, value: string): any => ({ key, value, secret: SECRET.test(key), enabled: true });

  const state: any = load() || { envs: {}, globals: [], active: '', captures: [] };
  // Seed: add what the project configured, never overwrite what the user changed.
  for (const name of Object.keys(cfg.environments || {})) {
    state.envs[name] = state.envs[name] || [];
    for (const k of Object.keys(cfg.environments[name])) {
      if (!state.envs[name].some((r: any) => r.key === k)) state.envs[name].push(row(k, cfg.environments[name][k]));
    }
  }
  for (const k of Object.keys(cfg.globals || {})) {
    if (!state.globals.some((r: any) => r.key === k)) state.globals.push(row(k, cfg.globals[k]));
  }
  if (!state.seeded) {
    state.captures = (cfg.captures || []).map((c: any) => ({ ...c, enabled: true }));
    state.seeded = true;
  }
  if (!Object.keys(state.envs).length) state.envs['Default'] = [];
  // Automatic detection settings: the project's defaults fill what the user never touched.
  state.auto = { ...cfg.auto, ...(state.auto || {}) };
  const routeParams: string[] = cfg.routeParams || [];
  // Every `{param}` of the routes is a variable of every environment (empty until a response or the user fills it).
  const ensureRouteParams = (): void => {
    for (const name of Object.keys(state.envs)) {
      for (const k of routeParams) {
        if (!state.envs[name].some((r: any) => r.key === k)) state.envs[name].push({ key: k, value: '', secret: false, enabled: true, route: true });
      }
    }
  };
  ensureRouteParams();
  if (!state.envs[state.active]) state.active = (cfg.active && state.envs[cfg.active] ? cfg.active : Object.keys(state.envs)[0]);

  const rand = (n: number): string => {
    let s = '';
    const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  };
  const dynamic = (name: string): string | undefined => {
    switch (name) {
      case '$guid':
      case '$uuid':
        return w.crypto && w.crypto.randomUUID ? w.crypto.randomUUID() : rand(8) + '-' + rand(4) + '-' + rand(4) + '-' + rand(4) + '-' + rand(12);
      case '$timestamp':
        return String(Math.floor(Date.now() / 1000));
      case '$isoTimestamp':
        return new Date().toISOString();
      case '$randomInt':
        return String(Math.floor(Math.random() * 1000));
      case '$randomString':
        return rand(10);
      case '$randomEmail':
        return rand(8) + '@example.com';
      default:
        return undefined;
    }
  };
  const lookup = (name: string): string | undefined => {
    const find = (rows: any[]): string | undefined => {
      for (const r of rows || []) if (r.enabled !== false && r.key === name) return String(r.value);
      return undefined;
    };
    const fromEnv = find(state.envs[state.active]);
    if (fromEnv !== undefined) return fromEnv;
    const g = find(state.globals);
    if (g !== undefined) return g;
    return dynamic(name);
  };
  const subst = (text: string, encode?: boolean): string =>
    text.replace(VAR, (m: string, name: string) => {
      const v = lookup(name);
      if (v === undefined) return m;
      return encode ? encodeURIComponent(v) : v;
    });
  const hasVar = (t: string): boolean => /\{\{|%7B%7B/i.test(t);
  const substUrl = (url: string): string => {
    let out = url;
    if (/%7B%7B/i.test(out)) {
      out = out.replace(/%7B%7B(.+?)%7D%7D/gi, (m: string, inner: string) => {
        let name = inner;
        try {
          name = decodeURIComponent(inner);
        } catch (e) {
          /* keep */
        }
        const v = lookup(name.trim());
        return v === undefined ? m : encodeURIComponent(v);
      });
    }
    return /\{\{/.test(out) ? subst(out, true) : out;
  };

  // ---------------------------------------------------------------- request / response hooks
  const baseVar: string | false = cfg.baseUrlVariable;
  const authCfg: any = cfg.authorization;
  // The docs' own files (`/api/docs`, `/api/docs/swagger-ui-bundle.js`, `/api/docs-json`) are never re-targeted.
  const docsPath = w.location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '');
  const isDocsAsset = (path: string): boolean => !!docsPath && (path === docsPath || path.indexOf(docsPath + '/') === 0 || path.indexOf(docsPath + '-') === 0);
  // `localhost:5000`, `http://localhost:5000/`, `api.example.com` -> a usable base URL.
  const normalizeBase = (raw: string | undefined): URL | undefined => {
    if (!raw) return undefined;
    let t = String(raw).trim();
    if (!t) return undefined;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/i.test(t) ? 'http://' : w.location.protocol + '//') + t.replace(/^\/+/, '');
    try {
      return new URL(t);
    } catch (e) {
      return undefined;
    }
  };
  const knownOrigins = new Set<string>([w.location.origin].concat(cfg.serverOrigins || []));
  const currentBase = (): URL | undefined => (baseVar ? normalizeBase(lookup(baseVar)) : undefined);
  const rewriteOrigin = (url: string): string => {
    const b = currentBase();
    if (!b) return url;
    try {
      const u = new URL(url, w.location.href);
      if (u.origin === b.origin && (b.pathname === '/' || u.pathname.indexOf(b.pathname) === 0)) return url; // already there
      // Only requests to the API: the page's own origin or a server declared in the document.
      if (!knownOrigins.has(u.origin) || isDocsAsset(u.pathname)) return url;
      return b.origin + b.pathname.replace(/\/$/, '') + u.pathname + u.search;
    } catch (e) {
      return url;
    }
  };
  const mapHeaders = (h: any): any => {
    if (!h) return h;
    const out = new Headers(h);
    out.forEach((v: string, k: string) => {
      if (hasVar(v)) out.set(k, subst(v));
    });
    if (authCfg && !out.has('authorization')) {
      const t = lookup((state.auto && state.auto.tokenVariable) || authCfg.variable);
      if (t) out.set('Authorization', (authCfg.scheme ? authCfg.scheme + ' ' : '') + t);
    }
    return out;
  };
  const mapBody = (b: any): any => {
    if (typeof b === 'string') return hasVar(b) ? subst(b) : b;
    if (b && typeof b.forEach === 'function' && typeof b.append === 'function' && typeof b.get === 'function' && !(b instanceof Blob)) {
      // FormData / URLSearchParams: substitute string fields only.
      try {
        const keys: string[] = [];
        b.forEach((_: any, k: string) => keys.push(k));
        for (const k of keys) {
          const v = b.get(k);
          if (typeof v === 'string' && hasVar(v)) b.set(k, subst(v));
        }
      } catch (e) {
        /* leave */
      }
    }
    return b;
  };

  const getPath = (obj: any, path: string): any => {
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[p];
    }
    return cur;
  };
  const urlMatches = (rule: string | undefined, url: string): boolean => {
    if (!rule) return true;
    const m = /^\/(.+)\/([a-z]*)$/.exec(rule);
    if (m) {
      try {
        return new RegExp(m[1], m[2]).test(url);
      } catch (e) {
        return false;
      }
    }
    return url.indexOf(rule) >= 0;
  };
  const setVar = (rule: any, value: string, source?: string): void => {
    const rows = rule.scope === 'global' ? state.globals : state.envs[state.active];
    const hit = rows.find((r: any) => r.key === rule.variable);
    if (hit) hit.value = value;
    else rows.push({ key: rule.variable, value, secret: rule.secret !== undefined ? rule.secret : SECRET.test(rule.variable), enabled: true });
    persist();
    toast('{{' + rule.variable + '}} \u2190 ' + (source || rule.from || 'response'));
    refresh();
    fillInputs();
  };
  const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
  const leaves = (o: any, path: string, depth: number, out: any[]): void => {
    if (o === null || typeof o !== 'object' || depth > 4) return;
    if (Array.isArray(o)) {
      o.slice(0, 3).forEach((x: any, i: number) => leaves(x, path + '[' + i + ']', depth + 1, out));
      return;
    }
    for (const k of Object.keys(o)) {
      const v = o[k];
      const p = path ? path + '.' + k : k;
      if (typeof v === 'string' || typeof v === 'number') out.push({ path: p, key: k, value: v, depth });
      else leaves(v, p, depth + 1, out);
    }
  };
  const jwtInfo = (t: string): any => {
    try {
      const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(w.atob(b + '==='.slice((b.length + 3) % 4)));
    } catch (e) {
      return {};
    }
  };
  // Finds access / refresh tokens in a response whatever their key is called.
  const detectTokens = (url: string, json: any, res: Response): any => {
    const a = state.auto;
    let authUrl = false;
    try {
      authUrl = new RegExp(a.authUrls, 'i').test(url);
    } catch (e) {
      authUrl = false;
    }
    const found: any[] = [];
    const list: any[] = [];
    leaves(json, '', 0, list);
    for (const c of list) {
      if (typeof c.value !== 'string') continue;
      let v = c.value.replace(/^Bearer\s+/i, '');
      if (/\s/.test(v) || v.length < 16) continue;
      if (/type|expir|ttl|scope|url|uri/i.test(c.key)) continue;
      const jwt = JWT.test(v);
      const named = /token|jwt|bearer|session|access|auth/i.test(c.key);
      if (!(jwt ? authUrl || named : authUrl && named)) continue;
      found.push({ ...c, value: v, jwt, info: jwt ? jwtInfo(v) : {} });
    }
    // Response headers
    for (const h of ['authorization', 'x-access-token', 'x-auth-token']) {
      const hv = res.headers.get(h);
      if (hv && hv.length >= 16) found.push({ path: 'header ' + h, key: h, value: hv.replace(/^Bearer\s+/i, ''), jwt: false, info: {}, depth: 0 });
    }
    if (!found.length) return {};
    const isRefresh = (c: any): boolean => /refresh/i.test(c.key) || /refresh/i.test(String(c.info.type || c.info.typ || c.info.token_use || c.info.tokenType || ''));
    const refresh = found.filter(isRefresh);
    let access = found.filter((c) => !isRefresh(c) && !/id[_-]?token/i.test(c.key));
    // Two unlabeled JWTs: the one that expires first is the access token.
    const unlabeled = access.filter((c) => c.jwt && !/access/i.test(c.key));
    if (!refresh.length && unlabeled.length > 1 && access.length === unlabeled.length) {
      unlabeled.sort((x: any, y: any) => (x.info.exp || 0) - (y.info.exp || 0));
      refresh.push(unlabeled[unlabeled.length - 1]);
      access = unlabeled.slice(0, unlabeled.length - 1);
    }
    const rank = (c: any): number => (/access/i.test(c.key) ? 0 : /^(token|jwt|authtoken|auth_token|bearer)$/i.test(c.key) ? 1 : c.jwt ? 2 : 3) * 10 + c.depth;
    access.sort((x: any, y: any) => rank(x) - rank(y));
    return { access: access[0], refresh: refresh[0] };
  };
  const detectIds = (json: any): any[] => {
    const wanted = new Set<string>(routeParams);
    // Only the resource itself (or its `data` envelope / first item): ids of nested children are other resources.
    let base = json && typeof json === 'object' && !Array.isArray(json) && json.data !== undefined && json.data !== null && typeof json.data === 'object' ? json.data : json;
    if (Array.isArray(base)) base = base[0];
    const out: any[] = [];
    if (!base || typeof base !== 'object') return out;
    for (const k of Object.keys(base)) {
      const v = base[k];
      const name = k === '_id' ? 'id' : k;
      if (!wanted.has(name) || (typeof v !== 'string' && typeof v !== 'number') || v === '') continue;
      out.push({ name, value: String(v), path: k });
    }
    return out;
  };
  const capture = async (url: string, method: string, res: Response): Promise<void> => {
    if (!res.ok) return;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('json') < 0) {
      if (state.auto.tokens) {
        const t = detectTokens(url, {}, res);
        if (t.access) setVar({ variable: state.auto.tokenVariable, scope: 'environment', secret: true }, t.access.value, t.access.path);
      }
      return;
    }
    let json: any;
    try {
      json = await res.clone().json();
    } catch (e) {
      return;
    }
    const rules = (state.captures || []).filter((c: any) => c.enabled !== false && c.variable && c.from);
    if (state.auto.tokens) {
      const t = detectTokens(url, json, res);
      if (t.access) setVar({ variable: state.auto.tokenVariable, scope: 'environment', secret: true }, t.access.value, t.access.path);
      if (t.refresh && state.auto.refreshVariable) setVar({ variable: state.auto.refreshVariable, scope: 'environment', secret: true }, t.refresh.value, t.refresh.path);
    }
    if (state.auto.ids) {
      for (const d of detectIds(json)) setVar({ variable: d.name, scope: 'environment', secret: false }, d.value, d.path);
    }
    const done = new Set<string>();
    for (const rule of rules) {
      if (done.has(rule.variable)) continue;
      if (rule.method && rule.method.toLowerCase() !== method.toLowerCase()) continue;
      if (!urlMatches(rule.urlIncludes, url)) continue;
      const v = getPath(json, rule.from);
      if (v === undefined || v === null || typeof v === 'object') continue;
      done.add(rule.variable);
      setVar(rule, String(v));
    }
  };

  const nativeFetch = w.fetch.bind(w);
  w.fetch = async function (input: any, init?: any): Promise<Response> {
    let url: string = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url ? input.url : '';
    let method = ((init && init.method) || (input && input.method) || 'GET') as string;
    let nextInit: any = init;
    let nextInput: any = input;
    try {
      const newUrl = rewriteOrigin(substUrl(url));
      if (typeof input === 'string' || input instanceof URL) {
        nextInput = newUrl;
        nextInit = init ? { ...init, headers: mapHeaders(init.headers), body: mapBody(init.body) } : init;
        if (!nextInit && authCfg) nextInit = { headers: mapHeaders({}) };
      } else if (input && typeof input.clone === 'function') {
        const h = mapHeaders(input.headers);
        let body: any = undefined;
        if (!/^(GET|HEAD)$/i.test(method)) {
          const txt = await input.clone().text();
          body = hasVar(txt) ? subst(txt) : txt;
        }
        nextInput = new Request(newUrl, { method, headers: h, body, credentials: input.credentials, mode: input.mode, signal: input.signal });
        nextInit = init;
      }
      url = newUrl;
    } catch (e) {
      nextInput = input;
      nextInit = init;
    }
    const res: Response = await nativeFetch(nextInput, nextInit);
    try {
      void capture(url, method, res);
    } catch (e) {
      /* never break the page */
    }
    return res;
  };

  // Pre-fill empty path / query inputs from the variable with the same name (only inputs the user did not type into).
  function reassert(input: any, name: string, v: string): void {
    if (!input.isConnected || input.dataset.adeUser || input.dataset.adeVal !== v || lookup(name) !== v) return;
    setNative(input, v);
  }
  // Right before Swagger UI reads the form (Execute), make sure its state holds what the inputs show.
  doc.addEventListener(
    'click',
    (e: any) => {
      const btn = e.target && e.target.closest ? e.target.closest('.opblock .execute') : null;
      if (!btn) return;
      const block = btn.closest('.opblock');
      block.querySelectorAll('tr[data-param-name] input[type=text]').forEach((input: any) => {
        const v = input.dataset.adeVal;
        if (v && !input.dataset.adeUser && input.value === v) setNative(input, v);
      });
    },
    true,
  );
  let fillQueued = false;
  function fillInputs(): void {
    if (!state.auto.fill || fillQueued) return;
    fillQueued = true;
    w.requestAnimationFrame(() => {
      fillQueued = false;
      const trs = doc.querySelectorAll('.opblock-body tr[data-param-name]');
      trs.forEach((tr: any) => {
        const input = tr.querySelector('input[type=text]:not([disabled])');
        if (!input) return;
        const name = tr.getAttribute('data-param-name');
        const where = tr.getAttribute('data-param-in');
        if (where !== 'path' && where !== 'query') return;
        const v = lookup(name);
        if (v === undefined || v === '') return;
        // Never over a value the user typed; the spec's example or our previous fill is fair game.
        if (input.dataset.adeUser) return;
        if (input.value === v && input.dataset.adeVal === v) return;
        input.dataset.adeVal = v;
        setNative(input, v);
        // Swagger UI sets its own example shortly after Try it out opens: say it again once it settled.
        for (const ms of [120, 500, 1500]) w.setTimeout(() => reassert(input, name, v), ms);
      });
    });
  }
  doc.addEventListener(
    'input',
    (e: any) => {
      if (e.isTrusted && e.target && e.target.closest && e.target.closest('tr[data-param-name]')) e.target.dataset.adeUser = '1';
    },
    true,
  );
  new w.MutationObserver(() => { fillInputs(); reviewFields(); }).observe(doc.documentElement, { childList: true, subtree: true });

  // ---------------------------------------------------------------- UI
  const css = `
.ade-bar{position:fixed;top:10px;right:14px;z-index:9999;display:flex;gap:6px;align-items:center;font:13px/1.2 system-ui,sans-serif;background:var(--ade-bg);color:var(--ade-fg);border:1px solid var(--ade-line);border-radius:8px;padding:5px 8px;box-shadow:0 2px 10px rgba(0,0,0,.15)}
.ade-bar select,.ade-modal select,.ade-modal input[type=text],.ade-modal input[type=password]{background:var(--ade-bg);color:var(--ade-fg);border:1px solid var(--ade-line);border-radius:5px;padding:4px 6px;font:inherit}
.ade-btn{background:var(--ade-accent);color:#fff;border:0;border-radius:5px;padding:5px 10px;font:inherit;cursor:pointer}
.ade-btn.ghost{background:transparent;color:var(--ade-fg);border:1px solid var(--ade-line)}
.ade-btn.danger{background:#c0392b}
.ade-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center}
.ade-modal{background:var(--ade-bg);color:var(--ade-fg);width:min(860px,94vw);max-height:88vh;overflow:auto;border-radius:10px;padding:16px 18px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.ade-modal h3{margin:0 0 8px;font-size:16px}.ade-modal table{width:100%;border-collapse:collapse}
.ade-modal td,.ade-modal th{padding:3px 4px;text-align:left;vertical-align:middle}.ade-modal td input[type=text],.ade-modal td input[type=password]{width:100%;box-sizing:border-box}
.ade-tabs{display:flex;gap:4px;margin:8px 0}.ade-tabs button{flex:0}.ade-tabs .on{background:var(--ade-accent);color:#fff}
.ade-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0}.ade-hint{opacity:.7;font-size:12px;margin:6px 0}
.ade-toast{position:fixed;bottom:18px;right:18px;z-index:10001;background:#2d7d46;color:#fff;border-radius:6px;padding:8px 12px;font:13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.ade-pop{position:fixed;z-index:10002;background:var(--ade-bg);color:var(--ade-fg);border:1px solid var(--ade-line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3);max-height:260px;overflow:auto;min-width:300px;font:13px/1.3 system-ui,sans-serif;padding:3px}
.ade-item{display:flex;gap:8px;align-items:center;padding:5px 8px;border-radius:5px;cursor:pointer}.ade-item.on,.ade-item:hover{background:var(--ade-accent);color:#fff}
.ade-key{font-weight:600;font-family:ui-monospace,monospace}.ade-val{margin-left:auto;opacity:.8;font-family:ui-monospace,monospace;font-size:12px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ade-tag{font-size:10px;text-transform:uppercase;border-radius:4px;padding:1px 5px;background:rgba(127,127,127,.25)}
.ade-xbtn{position:fixed;z-index:9998;width:26px;height:20px;padding:0;border:1px solid var(--ade-line);border-radius:4px;background:var(--ade-bg);color:var(--ade-accent);font:600 11px ui-monospace,monospace;cursor:pointer}
.ade-ok{outline:2px solid #2e9e5b!important;outline-offset:-1px}.ade-warn{outline:2px solid #e0a100!important;outline-offset:-1px}.ade-bad{outline:2px solid #d64545!important;outline-offset:-1px}
.ade-hintfloat{position:fixed;z-index:9997;font:12px/1.3 ui-monospace,monospace;color:#fff;border-radius:4px;padding:3px 8px;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ade-hintfloat.ok{background:#2e9e5b}.ade-hintfloat.warn{background:#b88500}.ade-hintfloat.bad{background:#d64545}
.ade-selbtn{position:fixed;z-index:10002}
.ade-form{position:fixed;z-index:10003;background:var(--ade-bg);color:var(--ade-fg);border:1px solid var(--ade-line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:10px 12px;width:340px;font:13px/1.4 system-ui,sans-serif}
.ade-form input[type=text],.ade-form select{width:100%;box-sizing:border-box;background:var(--ade-bg);color:var(--ade-fg);border:1px solid var(--ade-line);border-radius:5px;padding:4px 6px;font:inherit}
:root{--ade-bg:#fff;--ade-fg:#222;--ade-line:#c9ced6;--ade-accent:#3b7ddd}
@media (prefers-color-scheme:dark){:root{--ade-bg:#1f2329;--ade-fg:#e6e8eb;--ade-line:#444b55;--ade-accent:#4a8be0}}`;
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.appendChild(style);

  const el = (tag: string, props?: any, kids?: any[]): any => {
    const n = doc.createElement(tag);
    for (const k of Object.keys(props || {})) {
      if (k === 'text') n.textContent = props[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), props[k]);
      else if (k === 'class') n.className = props[k];
      else n[k] = props[k];
    }
    for (const c of kids || []) if (c) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    return n;
  };
  function toast(msg: string): void {
    const t = el('div', { class: 'ade-toast', text: msg });
    doc.body.appendChild(t);
    w.setTimeout(() => t.remove(), 2200);
  }

  const bar = el('div', { class: 'ade-bar' });
  const select = el('select', {
    title: 'Active environment',
    onchange: (e: any) => {
      state.active = e.target.value;
      persist();
      updateTarget();
      fillInputs();
    },
  });
  bar.appendChild(el('span', { text: 'Env' }));
  bar.appendChild(select);
  const target = el('span', { style: 'opacity:.75;font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' });
  bar.appendChild(target);
  bar.appendChild(el('button', { class: 'ade-btn', text: 'Variables', onclick: () => openManager() }));
  function updateTarget(): void {
    const b = currentBase();
    target.textContent = b ? '\u2192 ' + b.origin + b.pathname.replace(/\/$/, '') : '';
    target.title = b ? 'Requests are sent to ' + b.href + ' (variable {{' + baseVar + '}})' : '';
  }
  function refresh(): void {
    updateTarget();
    reviewFields();
    select.textContent = '';
    for (const name of Object.keys(state.envs)) {
      const o = el('option', { text: name, value: name });
      if (name === state.active) o.selected = true;
      select.appendChild(o);
    }
  }
  refresh();

  let modal: any = null;
  let tab: 'env' | 'globals' | 'captures' = 'env';
  const close = (): void => {
    if (modal) modal.remove();
    modal = null;
    refresh();
  };
  function openManager(): void {
    if (modal) modal.remove();
    const box = el('div', { class: 'ade-modal' });
    modal = el('div', {
      class: 'ade-back',
      onmousedown: (e: any) => {
        if (e.target === modal) {
          persist();
          close();
        }
      },
    }, [box]);
    doc.body.appendChild(modal);
    render(box);
  }

  function varTable(rows: any[]): any {
    const tbody = el('tbody');
    let filter = '';
    const draw = (): void => {
      tbody.textContent = '';
      rows.forEach((r: any, i: number) => {
        if (filter && r.key.toLowerCase().indexOf(filter) < 0) return;
        const val = el('input', { type: r.secret ? 'password' : 'text', value: r.value, oninput: (e: any) => { r.value = e.target.value; updateTarget(); fillInputs(); reviewFields(); } });
        const sec = el('input', {
          type: 'checkbox',
          checked: !!r.secret,
          title: 'Mask the value',
          onchange: (e: any) => {
            r.secret = e.target.checked;
            val.type = r.secret ? 'password' : 'text';
          },
        });
        tbody.appendChild(
          el('tr', {}, [
            el('td', {}, [el('input', { type: 'checkbox', checked: r.enabled !== false, title: 'Enabled', onchange: (e: any) => (r.enabled = e.target.checked) })]),
            el('td', {}, [el('input', { type: 'text', value: r.key, placeholder: 'name', title: r.route ? 'Taken from a route parameter' : '', oninput: (e: any) => (r.key = e.target.value.trim()) })]),
            el('td', {}, [val]),
            el('td', {}, [sec]),
            el('td', {}, [el('button', { class: 'ade-btn ghost', text: '✕', title: 'Delete', onclick: () => { rows.splice(i, 1); draw(); } })]),
          ]),
        );
      });
    };
    draw();
    const table = el('table', {}, [
      el('thead', {}, [el('tr', {}, ['', 'Variable', 'Value', 'Secret', ''].map((t) => el('th', { text: t })))]),
      tbody,
    ]);
    const add = el('button', { class: 'ade-btn ghost', text: '+ Add variable', onclick: () => { rows.push(row('', '')); draw(); } });
    const search = el('input', { type: 'text', placeholder: 'Search variables…', oninput: (e: any) => { filter = e.target.value.trim().toLowerCase(); draw(); } });
    return el('div', {}, [el('div', { class: 'ade-row' }, [search, add]), table]);
  }

  function captureTable(): any {
    const rules: any[] = state.captures;
    const tbody = el('tbody');
    const draw = (): void => {
      tbody.textContent = '';
      rules.forEach((r: any, i: number) => {
        const t = (key: string, ph: string): any => el('input', { type: 'text', value: r[key] || '', placeholder: ph, oninput: (e: any) => (r[key] = e.target.value.trim() || undefined) });
        const scope = el('select', { onchange: (e: any) => (r.scope = e.target.value) }, [
          el('option', { value: 'environment', text: 'environment', selected: r.scope !== 'global' }),
          el('option', { value: 'global', text: 'global', selected: r.scope === 'global' }),
        ]);
        tbody.appendChild(
          el('tr', {}, [
            el('td', {}, [el('input', { type: 'checkbox', checked: r.enabled !== false, onchange: (e: any) => (r.enabled = e.target.checked) })]),
            el('td', {}, [t('urlIncludes', 'URL contains (or /regex/)')]),
            el('td', {}, [t('method', 'any')]),
            el('td', {}, [t('from', 'data.accessToken')]),
            el('td', {}, [t('variable', 'variable')]),
            el('td', {}, [scope]),
            el('td', {}, [el('button', { class: 'ade-btn ghost', text: '✕', onclick: () => { rules.splice(i, 1); draw(); } })]),
          ]),
        );
      });
    };
    draw();
    const table = el('table', {}, [el('thead', {}, [el('tr', {}, ['', 'When URL', 'Method', 'Take from response', 'Save as', 'Where', ''].map((x) => el('th', { text: x })))]), tbody]);
    const a = state.auto;
    const chk = (key: string, label: string, hint: string): any =>
      el('label', { title: hint, style: 'display:flex;gap:6px;align-items:center;margin:4px 0' }, [
        el('input', { type: 'checkbox', checked: a[key] !== false, onchange: (e: any) => { a[key] = e.target.checked; persist(); } }),
        label,
      ]);
    const txt = (key: string, label: string, hint: string): any =>
      el('label', { title: hint, style: 'display:flex;gap:6px;align-items:center;margin:4px 0' }, [
        el('span', { text: label, style: 'min-width:210px' }),
        el('input', { type: 'text', value: a[key] || '', style: 'flex:1', oninput: (e: any) => { a[key] = e.target.value.trim(); persist(); } }),
      ]);
    const auto = el('div', { style: 'border:1px solid var(--ade-line);border-radius:8px;padding:8px 10px;margin-bottom:10px' }, [
      el('b', { text: 'Automatic detection' }),
      chk('tokens', 'Find the token in login / refresh responses, whatever its key is called', 'JWT-shaped values, token / jwt / session / access keys, Authorization response header'),
      txt('tokenVariable', 'Access token variable', 'Used for Authorization: Bearer {{…}}'),
      txt('refreshVariable', 'Refresh token variable', 'Empty = do not store'),
      txt('authUrls', 'Auth-like URLs (regex)', 'Only responses from URLs matching this are searched for non-JWT tokens'),
      chk('ids', 'Fill route variables from responses (id, …Id, _id)', 'POST /plans returns { id } -> {{id}} for /plans/{id}'),
      chk('fill', 'Pre-fill empty path / query inputs from variables', 'Inputs named like a variable are filled when you open Try it out'),
    ]);
    return el('div', {}, [
      auto,
      el('div', { class: 'ade-hint', text: 'Extra rules - after a successful JSON response matching a rule, the value found at the path is stored in the variable (e.g. login → token).' }),
      table,
      el('div', { class: 'ade-row' }, [el('button', { class: 'ade-btn ghost', text: '+ Add rule', onclick: () => { rules.push({ enabled: true, from: '', variable: '' }); draw(); } })]),
    ]);
  }

  function download(name: string, data: any): void {
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: name });
    doc.body.appendChild(a);
    a.click();
    a.remove();
  }
  function importFile(box: any): void {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (Array.isArray(j.values)) {
          // Postman environment
          const name = String(j.name || f.name.replace(/\.json$/i, '') || 'Imported');
          state.envs[name] = j.values.map((v: any) => ({ key: String(v.key), value: String(v.value ?? ''), secret: v.type === 'secret' || SECRET.test(String(v.key)), enabled: v.enabled !== false }));
          state.active = name;
        } else if (j && j.envs) {
          Object.assign(state, j);
        } else throw new Error('Unknown file');
        persist();
        toast('Imported');
        render(box);
      } catch (e) {
        toast('Import failed: ' + (e as Error).message);
      }
    });
    input.click();
  }

  function render(box: any): void {
    box.textContent = '';
    const rows = state.envs[state.active];
    const envSelect = el('select', { onchange: (e: any) => { persist(); state.active = e.target.value; persist(); render(box); } });
    for (const n of Object.keys(state.envs)) envSelect.appendChild(el('option', { value: n, text: n, selected: n === state.active }));
    const tabBtn = (id: any, label: string): any => el('button', { class: 'ade-btn ghost' + (tab === id ? ' on' : ''), text: label, onclick: () => { tab = id; render(box); } });
    box.appendChild(el('h3', { text: 'Variables & environments' }));
    box.appendChild(el('div', { class: 'ade-hint', text: 'Use {{name}} in any parameter, header, body or in the Authorize dialog. Dynamic: {{$guid}} {{$timestamp}} {{$isoTimestamp}} {{$randomInt}} {{$randomString}} {{$randomEmail}}. Values stay in this browser.' }));
    box.appendChild(el('div', { class: 'ade-tabs' }, [tabBtn('env', 'Environment'), tabBtn('globals', 'Globals'), tabBtn('captures', 'Auto-capture')]));
    if (tab === 'env') {
      box.appendChild(
        el('div', { class: 'ade-row' }, [
          el('span', { text: 'Environment' }),
          envSelect,
          el('button', { class: 'ade-btn ghost', text: 'New', onclick: () => { const n = w.prompt('Environment name'); if (n && !state.envs[n]) { state.envs[n] = []; ensureRouteParams(); state.active = n; render(box); } } }),
          el('button', { class: 'ade-btn ghost', text: 'Duplicate', onclick: () => { const n = w.prompt('Name of the copy', state.active + ' copy'); if (n && !state.envs[n]) { state.envs[n] = JSON.parse(JSON.stringify(rows)); state.active = n; render(box); } } }),
          el('button', { class: 'ade-btn ghost', text: 'Rename', onclick: () => { const n = w.prompt('New name', state.active); if (n && n !== state.active && !state.envs[n]) { state.envs[n] = state.envs[state.active]; delete state.envs[state.active]; state.active = n; render(box); } } }),
          el('button', { class: 'ade-btn danger', text: 'Delete', onclick: () => { if (Object.keys(state.envs).length > 1 && w.confirm('Delete "' + state.active + '"?')) { delete state.envs[state.active]; state.active = Object.keys(state.envs)[0]; render(box); } } }),
        ]),
      );
      box.appendChild(varTable(rows));
    } else if (tab === 'globals') {
      box.appendChild(el('div', { class: 'ade-hint', text: 'Globals apply to every environment; the active environment wins when both define a name.' }));
      box.appendChild(varTable(state.globals));
    } else box.appendChild(captureTable());
    box.appendChild(
      el('div', { class: 'ade-row' }, [
        el('button', { class: 'ade-btn', text: 'Save & close', onclick: () => { state.globals = state.globals.filter((r: any) => r.key); for (const n of Object.keys(state.envs)) state.envs[n] = state.envs[n].filter((r: any) => r.key); persist(); close(); } }),
        el('button', { class: 'ade-btn ghost', text: 'Import (Postman / backup)', onclick: () => importFile(box) }),
        el('button', { class: 'ade-btn ghost', text: 'Export environment', onclick: () => download(state.active + '.postman_environment.json', { name: state.active, values: rows.map((r: any) => ({ key: r.key, value: r.value, type: r.secret ? 'secret' : 'default', enabled: r.enabled !== false })) }) }),
        el('button', { class: 'ade-btn ghost', text: 'Export all (backup)', onclick: () => download('swagger-environments.json', state) }),
      ]),
    );
  }

  // ---------------------------------------------------------------- variable picker (autocomplete, {x} button, highlight, set-as-variable)
  const DYNAMIC = ['$guid', '$timestamp', '$isoTimestamp', '$randomInt', '$randomString', '$randomEmail'];
  const allVars = (): any[] => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const r of state.envs[state.active] || []) {
      if (!r.key || seen.has(r.key)) continue;
      seen.add(r.key);
      out.push({ name: r.key, value: String(r.value), scope: r.route ? 'route' : 'env', secret: !!r.secret, enabled: r.enabled !== false });
    }
    for (const r of state.globals) {
      if (!r.key || seen.has(r.key)) continue;
      seen.add(r.key);
      out.push({ name: r.key, value: String(r.value), scope: 'global', secret: !!r.secret, enabled: r.enabled !== false });
    }
    for (const d of DYNAMIC) out.push({ name: d, value: '', scope: 'dynamic', secret: false, enabled: true });
    return out;
  };
  const shown = (v: any): string => {
    if (v.scope === 'dynamic') return 'generated per request';
    if (v.enabled === false) return '(disabled)';
    if (v.value === '') return '(empty)';
    if (v.secret) return '••••••';
    return v.value.length > 34 ? v.value.slice(0, 34) + '…' : v.value;
  };
  const isField = (n: any): boolean =>
    !!n &&
    (n.tagName === 'TEXTAREA' || (n.tagName === 'INPUT' && /^(text|search|url|password|)$/.test(n.type || ''))) &&
    !n.disabled &&
    !n.readOnly &&
    !!n.closest &&
    !!n.closest('.swagger-ui') &&
    !n.closest('.ade-modal') &&
    !n.closest('.ade-bar') &&
    !n.closest('.ade-form') &&
    !n.closest('.operation-filter-input');
  function setNative(field: any, value: string): void {
    const proto = field.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    // React remembers the last value it saw and drops an `input` event that changes nothing: forget it so onChange always runs.
    if (field._valueTracker && field._valueTracker.setValue) field._valueTracker.setValue('\u0000');
    field.dispatchEvent(new w.Event('input', { bubbles: true }));
    // Swagger UI debounces text inputs (350 ms) and flushes them on blur: do it now so its state is current at once.
    field.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
  }
  // popup
  let pop: any = null;
  let popState: any = null;
  function closePop(): void {
    if (pop) pop.remove();
    pop = null;
    popState = null;
  }
  function caretPoint(field: any, index: number): { x: number; y: number } {
    const r = field.getBoundingClientRect();
    if (field.tagName !== 'TEXTAREA') return { x: r.left, y: r.bottom + 2 };
    const cs = w.getComputedStyle(field);
    const lh = parseFloat(cs.lineHeight) || 16;
    const lines = field.value.slice(0, index).split('\n').length;
    const y = r.top + (parseFloat(cs.paddingTop) || 4) + lines * lh - field.scrollTop + 2;
    return { x: r.left + 8, y: Math.min(Math.max(y, r.top + lh), r.bottom) };
  }
  function renderPop(): void {
    if (!popState) return;
    if (pop) pop.remove();
    pop = el('div', { class: 'ade-pop' });
    const items = popState.items;
    items.forEach((v: any, i: number) => {
      const row = el('div', { class: 'ade-item' + (i === popState.sel ? ' on' : '') }, [
        el('span', { class: 'ade-key', text: v.name }),
        el('span', { class: 'ade-tag ' + v.scope, text: v.scope }),
        el('span', { class: 'ade-val', text: shown(v) }),
      ]);
      row.addEventListener('mousedown', (e: any) => {
        e.preventDefault();
        choose(v);
      });
      pop.appendChild(row);
    });
    doc.body.appendChild(pop);
    const p = caretPoint(popState.field, popState.mode === 'type' ? popState.start : popState.caret);
    const h = pop.offsetHeight;
    const top = p.y + h > w.innerHeight ? Math.max(4, p.y - h - 24) : p.y;
    pop.style.left = Math.max(4, Math.min(p.x, w.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = top + 'px';
    const on = pop.querySelector('.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function openPop(field: any, mode: 'type' | 'pick', start: number, query: string): void {
    const q = query.toLowerCase();
    let items = allVars().filter((v) => !q || v.name.toLowerCase().indexOf(q) >= 0);
    items.sort((a, b) => Number(b.name.toLowerCase().indexOf(q) === 0) - Number(a.name.toLowerCase().indexOf(q) === 0));
    if (!items.length) {
      closePop();
      return;
    }
    items = items.slice(0, 60);
    popState = { field, mode, start, caret: field.selectionStart || 0, caretEnd: field.selectionEnd || 0, items, sel: 0 };
    renderPop();
  }
  function choose(v: any): void {
    const s = popState;
    if (!s) return;
    const field = s.field;
    const text: string = field.value;
    let from = s.mode === 'type' ? s.start : s.caret;
    let to = s.mode === 'type' ? field.selectionStart : s.caretEnd;
    if (text.slice(to, to + 2) === '}}') to += 2;
    // Picking inside an existing {{…}} replaces it instead of nesting.
    const insert = '{{' + v.name + '}}';
    const next = text.slice(0, from) + insert + text.slice(to);
    closePop();
    field.dataset.adeUser = '1';
    setNative(field, next);
    field.focus();
    try {
      field.setSelectionRange(from + insert.length, from + insert.length);
    } catch (e) {
      /* some input types have no selection */
    }
    reviewFields();
  }
  doc.addEventListener(
    'input',
    (e: any) => {
      const f = e.target;
      if (!isField(f)) return;
      if (e.isTrusted) {
        const caret = f.selectionStart;
        const m = typeof caret === 'number' ? /\{\{([\w$.\-]*)$/.exec(f.value.slice(0, caret)) : null;
        if (m) openPop(f, 'type', caret - m[0].length, m[1]);
        else closePop();
      }
      reviewFields();
    },
    true,
  );
  doc.addEventListener(
    'keydown',
    (e: any) => {
      if (!popState) return;
      const n = popState.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        popState.sel = (popState.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderPop();
      } else if (e.key === 'Enter' || e.key === 'Tab') choose(popState.items[popState.sel]);
      else if (e.key === 'Escape') closePop();
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  doc.addEventListener('focusout', () => {
    w.setTimeout(() => {
      if (popState && doc.activeElement !== popState.field) closePop();
      placeButton();
    }, 150);
  });
  w.addEventListener('scroll', () => { closePop(); placeButton(); }, true);

  // {x} button next to the focused field
  const xbtn = el('button', { class: 'ade-xbtn', text: '{x}', title: 'Insert a variable' });
  xbtn.style.display = 'none';
  xbtn.addEventListener('mousedown', (e: any) => {
    e.preventDefault();
    const f = doc.activeElement;
    if (!isField(f)) return;
    if (popState) {
      closePop();
      return;
    }
    openPop(f, 'pick', 0, '');
  });
  doc.body ? doc.body.appendChild(xbtn) : doc.addEventListener('DOMContentLoaded', () => doc.body.appendChild(xbtn));
  function placeButton(): void {
    const f = doc.activeElement;
    if (!isField(f)) {
      xbtn.style.display = 'none';
      return;
    }
    const r = f.getBoundingClientRect();
    if (r.width < 90 || r.bottom < 0 || r.top > w.innerHeight) {
      xbtn.style.display = 'none';
      return;
    }
    xbtn.style.display = 'block';
    xbtn.style.left = r.right - 30 + 'px';
    xbtn.style.top = r.top + (r.height > 40 ? 4 : Math.max(0, (r.height - 20) / 2)) + 'px';
  }
  doc.addEventListener('focusin', () => { placeButton(); reviewFields(); });

  // Green / amber / red outline + tooltip for fields that contain {{variables}}
  const hintEl = el('div', { class: 'ade-hintfloat' });
  hintEl.style.display = 'none';
  doc.body ? doc.body.appendChild(hintEl) : doc.addEventListener('DOMContentLoaded', () => doc.body.appendChild(hintEl));
  function reviewFields(): void {
    if (!pickerReady) return;
    const fields = doc.querySelectorAll('.swagger-ui input, .swagger-ui textarea');
    const known: any = {};
    for (const v of allVars()) known[v.name] = v;
    let active: any = null;
    fields.forEach((f: any) => {
      if (!isField(f)) return;
      const val: string = f.value || '';
      if (val.indexOf('{{') < 0) {
        if (f.dataset.adeState) {
          f.classList.remove('ade-ok', 'ade-warn', 'ade-bad');
          f.removeAttribute('title');
          delete f.dataset.adeState;
        }
        return;
      }
      const names: string[] = [];
      val.replace(VAR, (m: string, n: string) => (names.indexOf(n) < 0 && names.push(n), m));
      if (!names.length) return;
      let level = 'ok';
      const lines: string[] = [];
      for (const n of names) {
        const v = known[n] || (lookup(n) !== undefined ? { value: lookup(n), scope: 'env', secret: false, enabled: true } : undefined);
        if (!v || v.enabled === false) {
          level = 'bad';
          lines.push('{{' + n + '}} → ' + (v ? 'disabled' : 'not defined'));
        } else {
          if (v.scope !== 'dynamic' && v.value === '' && level === 'ok') level = 'warn';
          lines.push('{{' + n + '}} → ' + shown(v) + (v.scope === 'dynamic' ? '' : '  [' + v.scope + ']'));
        }
      }
      f.classList.remove('ade-ok', 'ade-warn', 'ade-bad');
      f.classList.add('ade-' + level);
      f.dataset.adeState = level;
      f.title = lines.join('\n');
      if (f === doc.activeElement) active = { f, lines, level };
    });
    if (active && !popState) {
      const r = active.f.getBoundingClientRect();
      const hintText = active.lines.join('   |   ');
      // Only touch the DOM when something changed: the MutationObserver would otherwise call us again, forever.
      if (hintEl.textContent !== hintText) hintEl.textContent = hintText;
      hintEl.className = 'ade-hintfloat ' + active.level;
      hintEl.style.display = 'block';
      hintEl.style.left = Math.max(4, r.left) + 'px';
      hintEl.style.top = r.bottom + 2 + 'px';
    } else hintEl.style.display = 'none';
  }

  // "Set as variable": select text in a response body
  let selBtn: any = null;
  let form: any = null;
  const closeSel = (): void => {
    if (selBtn) selBtn.remove();
    selBtn = null;
  };
  const closeForm = (): void => {
    if (form) form.remove();
    form = null;
  };
  const stripQuotes = (t: string): string => t.replace(/^"(.*)"/s, (_m: string, inner: string) => inner).replace(/,/g, (m: string, off: number, all: string) => (off === all.length - 1 ? '' : m));
  const pathRegex = (apiPath: string): string => {
    const esc = apiPath.replace(/[.*+?^()|[\]\\]/g, (m: string) => '\\' + m).replace(/\{[^}]+\}/g, '[^/?]+');
    return '/' + esc + '(\\?.*)?' + String.fromCharCode(36) + '/';
  };
  doc.addEventListener('mouseup', (e: any) => {
    if (e.target && e.target.closest && (e.target.closest('.ade-form') || e.target.closest('.ade-selbtn'))) return;
    w.setTimeout(() => {
      closeSel();
      const sel = w.getSelection();
      const raw = sel ? sel.toString().trim() : '';
      if (!raw || raw.length > 4000 || !sel || sel.rangeCount === 0) return;
      const anchor = sel.anchorNode && (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode);
      const body = anchor && anchor.closest ? anchor.closest('.live-responses-table .microlight, .responses-table .microlight') : null;
      if (!body) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const block = body.closest('.opblock');
      selBtn = el('button', { class: 'ade-btn ade-selbtn', text: 'Set as variable' });
      selBtn.style.left = Math.min(rect.right, w.innerWidth - 150) + 'px';
      selBtn.style.top = rect.bottom + 4 + 'px';
      selBtn.addEventListener('mousedown', (ev: any) => {
        ev.preventDefault();
        openForm(raw, body, block, rect);
      });
      doc.body.appendChild(selBtn);
    }, 0);
  });
  function openForm(raw: string, body: any, block: any, rect: any): void {
    closeSel();
    closeForm();
    const value = stripQuotes(raw);
    let json: any;
    try {
      json = JSON.parse(body.textContent || '');
    } catch (e) {
      json = undefined;
    }
    let match: any;
    if (json !== undefined) {
      const list: any[] = [];
      leaves(json, '', 0, list);
      match = list.find((c: any) => String(c.value) === value);
    }
    const apiPath = block && block.querySelector('.opblock-summary-path') ? block.querySelector('.opblock-summary-path').getAttribute('data-path') || '' : '';
    const methodMatch = block ? /opblock-(\w+)/.exec(block.className) : null;
    const suggested = match ? String(match.key).replace(/[^\w$.\-]/g, '_') : '';
    const nameIn = el('input', { type: 'text', value: suggested, placeholder: 'variable name', list: 'ade-names' });
    const dl = el('datalist', { id: 'ade-names' });
    for (const v of allVars()) if (v.scope !== 'dynamic') dl.appendChild(el('option', { value: v.name }));
    const scope = el('select', {}, [el('option', { value: 'environment', text: 'Environment: ' + state.active }), el('option', { value: 'global', text: 'Global' })]);
    const auto = el('input', { type: 'checkbox', checked: !!(match && apiPath) });
    auto.disabled = !(match && apiPath);
    const save = (): void => {
      const name = nameIn.value.trim().replace(/[^\w$.\-]/g, '_');
      if (!name) {
        nameIn.focus();
        return;
      }
      const rule = { variable: name, scope: scope.value, secret: SECRET.test(name) };
      const rows = scope.value === 'global' ? state.globals : state.envs[state.active];
      const hit = rows.find((r: any) => r.key === name);
      if (hit) hit.value = value;
      else rows.push({ key: name, value, secret: rule.secret, enabled: true });
      if (auto.checked && match && apiPath) {
        const urlIncludes = pathRegex(apiPath);
        const method = methodMatch ? methodMatch[1] : undefined;
        state.captures = state.captures || [];
        const dup = state.captures.find((c: any) => c.variable === name && c.from === match.path && c.urlIncludes === urlIncludes);
        if (dup) dup.enabled = true;
        else state.captures.push({ enabled: true, urlIncludes, method, from: match.path, variable: name, scope: scope.value, secret: rule.secret });
      }
      persist();
      closeForm();
      toast('{{' + name + '}} = ' + (rule.secret ? '••••' : value.length > 30 ? value.slice(0, 30) + '…' : value));
      refresh();
      fillInputs();
      reviewFields();
    };
    form = el('div', { class: 'ade-form' }, [
      el('div', { text: 'Set "' + (value.length > 40 ? value.slice(0, 40) + '…' : value) + '" as a variable', style: 'font-weight:600;margin-bottom:6px' }),
      nameIn,
      dl,
      el('div', { class: 'ade-row' }, [scope]),
      el('label', { style: 'display:flex;gap:6px;align-items:center' }, [auto, match ? 'Update it automatically from this response (' + match.path + ')' : 'Automatic update unavailable (value not found in a JSON response)']),
      el('div', { class: 'ade-row' }, [el('button', { class: 'ade-btn', text: 'Save', onclick: save }), el('button', { class: 'ade-btn ghost', text: 'Cancel', onclick: closeForm })]),
    ]);
    form.style.left = Math.min(rect.left, w.innerWidth - 360) + 'px';
    form.style.top = Math.min(rect.bottom + 6, w.innerHeight - 220) + 'px';
    nameIn.addEventListener('keydown', (ev: any) => {
      if (ev.key === 'Enter') save();
      if (ev.key === 'Escape') closeForm();
    });
    doc.body.appendChild(form);
    nameIn.focus();
    nameIn.select();
  }

  pickerReady = true;
  reviewFields();

  const mount = (): void => doc.body.appendChild(bar);
  if (doc.body) mount();
  else doc.addEventListener('DOMContentLoaded', mount);
  // Swagger UI's own request hook: what it returns is what the "Curl" and "Request URL" boxes show, so the
  // variables are resolved HERE (the fetch wrapper above stays as a safety net and finds nothing left to do).
  const interceptRequest = (req: any): any => {
    try {
      if (!req || typeof req !== 'object') return req;
      if (typeof req.url === 'string') req.url = rewriteOrigin(substUrl(req.url));
      const headers = req.headers || (req.headers = {});
      let hasAuth = false;
      for (const k of Object.keys(headers)) {
        if (typeof headers[k] === 'string' && hasVar(headers[k])) headers[k] = subst(headers[k]);
        if (k.toLowerCase() === 'authorization') hasAuth = true;
      }
      if (authCfg && !hasAuth) {
        const t = lookup((state.auto && state.auto.tokenVariable) || authCfg.variable);
        if (t) headers['Authorization'] = (authCfg.scheme ? authCfg.scheme + ' ' : '') + t;
      }
      if (req.body !== undefined && req.body !== null) req.body = mapBody(req.body);
    } catch (e) {
      /* never break the request */
    }
    return req;
  };
  w.__autodocEnv = {
    interceptRequest,
    get: lookup,
    set: (name: string, value: string) => {
      const rows = state.envs[state.active];
      const hit = rows.find((r: any) => r.key === name);
      if (hit) hit.value = String(value);
      else rows.push(row(name, String(value)));
      persist();
    },
    active: () => state.active,
  };
}
/* eslint-enable */

/** Names of the `{param}` segments of every route in the document: they become variables of every environment. */
export function routeParamNames(document: { paths?: Record<string, any> } | undefined): string[] {
  const names = new Set<string>();
  for (const path of Object.keys(document?.paths ?? {})) for (const m of path.matchAll(/\{([^}]+)\}/g)) names.add(m[1]);
  return Array.from(names).sort();
}

/** Origins of the `servers` declared in the document (requests to them are re-targeted by the base URL variable). */
export function serverOrigins(document: { servers?: Array<{ url?: string }> } | undefined): string[] {
  const out = new Set<string>();
  for (const s of document?.servers ?? []) {
    try {
      if (s.url && /^https?:\/\//i.test(s.url)) out.add(new URL(s.url).origin);
    } catch {
      /* relative or templated server url */
    }
  }
  return Array.from(out);
}

/** Resolve user options into the client config; `undefined` when the feature is off. */
export function resolveEnvironments(input: EnvironmentsOptions | boolean | undefined, document?: { paths?: Record<string, any>; servers?: Array<{ url?: string }> }): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const o: EnvironmentsOptions = input === true ? {} : input;
  if (o.enabled === false) return undefined;
  const auth = o.authorization === false ? false : { variable: o.authorization?.variable ?? 'token', scheme: o.authorization?.scheme ?? 'Bearer' };
  const a = o.auto === false ? { tokens: false, ids: false, fill: false } : (o.auto ?? {});
  return {
    environments: o.environments ?? { Local: { baseUrl: '' } },
    globals: o.globals ?? {},
    captures: o.captures === false ? [] : (o.captures ?? []),
    active: o.active,
    baseUrlVariable: o.baseUrlVariable === undefined ? 'baseUrl' : o.baseUrlVariable,
    authorization: auth,
    routeParams: routeParamNames(document),
    serverOrigins: serverOrigins(document),
    auto: {
      tokens: (a as any).tokens !== false,
      tokenVariable: (a as any).tokenVariable ?? (auth ? (auth as any).variable : 'token'),
      refreshVariable: (a as any).refreshVariable ?? 'refreshToken',
      authUrls: (a as any).authUrls ?? 'login|log-in|signin|sign-in|auth|token|session|refresh|verify|otp|register|signup|sign-up|oauth|sso',
      ids: (a as any).ids !== false,
      fill: (a as any).fill !== false,
    },
  };
}

/** The script to put into Swagger UI's `customJsStr`. */
export function environmentsScript(config: Record<string, unknown>): string {
  return `(${client.toString()})(${JSON.stringify(config).replace(/</g, '\\u003c')});`;
}
