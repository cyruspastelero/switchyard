// Pure matching: URLs and windows -> context ids, each with the reason it matched. No I/O.
//
// Every window walks a fixed ladder of signals, strongest first. A rung where two unrelated contexts
// match is ambiguous and the window stays unsorted; a parent folder never wins over a child inside it.

export interface MatchableContext {
  readonly id: string;
  readonly name: string;
  readonly folder: string | null;
  /** Patterns like "github.com/owner/repo", "vercel.com/*\/name", "localhost:3000". */
  readonly patterns: readonly string[];
  /** Other names the project goes by (package name, Vercel or Supabase project name). */
  readonly aliases?: readonly string[];
}

export interface Match {
  readonly contextId: string;
  /** One short line for the dashboard: what in the window pointed at this context. */
  readonly reason: string;
  /** Strong signals identify the window itself (session, folder, workspace); weak ones are words in a title. */
  readonly strong: boolean;
}

export interface TitleEntry {
  readonly title: string;
  readonly contextId: string;
}

export interface AppWindowLike {
  readonly title: string;
  readonly document: string | null;
}

export interface BrowserWindowLike {
  readonly title: string;
  readonly tabs: readonly { readonly url: string; readonly title?: string }[];
  /** A name given to the window (Chrome shows it in the title in place of the page). */
  readonly name?: string | null;
  readonly activeTitle?: string | null;
}

export interface WindowLike extends AppWindowLike {
  readonly bundleId: string;
  readonly browser: { readonly tabs: readonly { readonly url: string; readonly title?: string }[]; readonly name?: string | null; readonly activeTitle?: string | null } | null;
}

interface Normalized {
  readonly host: string;
  readonly segments: readonly string[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '0.0.0.0']);

function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  const [name, port] = splitPort(lower);
  const canonical = LOOPBACK_HOSTS.has(name) ? 'localhost' : name.replace(/^www\./, '');
  return port ? `${canonical}:${port}` : canonical;
}

function splitPort(host: string): [string, string | null] {
  const m = /^(.*?)(?::(\d+))?$/.exec(host);
  return m ? [m[1], m[2] ?? null] : [host, null];
}

function normalizeUrl(raw: string): Normalized | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const segments = url.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  return { host: normalizeHost(url.host), segments };
}

function normalizePattern(pattern: string): Normalized | null {
  const [host, ...rest] = pattern.split('/').filter((s) => s.length > 0);
  if (!host) return null;
  return { host: normalizeHost(host), segments: rest.map((s) => s.toLowerCase()) };
}

function patternMatches(pattern: Normalized, url: Normalized): boolean {
  if (pattern.host !== url.host) return false;
  if (pattern.segments.length > url.segments.length) return false;
  return pattern.segments.every((seg, i) => seg === '*' || seg === url.segments[i]);
}

/** Context for a URL: the most specific matching pattern wins; a tie between contexts is no match. */
export function matchUrl(url: string, contexts: readonly MatchableContext[]): string | null {
  const target = normalizeUrl(url);
  if (!target) return null;
  let bestLength = -1;
  let winners = new Set<string>();
  for (const ctx of contexts) {
    for (const raw of ctx.patterns) {
      const pattern = normalizePattern(raw);
      if (!pattern || !patternMatches(pattern, target)) continue;
      const specificity = pattern.segments.length;
      if (specificity > bestLength) {
        bestLength = specificity;
        winners = new Set([ctx.id]);
      } else if (specificity === bestLength) {
        winners = new Set([...winners, ctx.id]);
      }
    }
  }
  return winners.size === 1 ? [...winners][0] : null;
}

// --- Shared helpers -----------------------------------------------------------

function basename(folder: string): string {
  return folder.split('/').filter(Boolean).pop() ?? '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function insideFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

/** `token` in `text`, not glued to more name characters: "tala" is not in "tala-web" or "metalanguage". */
function hasToken(text: string, token: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(token)}(?![A-Za-z0-9_-])`, 'i');
  return re.test(text);
}

/** Contexts whose folder contains another candidate's folder step aside: the child is the specific answer. */
function dropAncestors(candidates: readonly MatchableContext[]): readonly MatchableContext[] {
  return candidates.filter(
    (c) => !candidates.some((o) => o.id !== c.id && c.folder && o.folder && o.folder !== c.folder && insideFolder(o.folder, c.folder)),
  );
}

interface Hit {
  readonly context: MatchableContext;
  readonly reason: string;
}

type Rung = { readonly match: Match } | 'ambiguous' | 'none';

/** One rung of the ladder: exactly one context (after children beat parents) or no decision. */
function decide(hits: readonly Hit[], strong: boolean): Rung {
  const byId = new Map(hits.map((h) => [h.context.id, h]));
  const left = dropAncestors([...byId.values()].map((h) => h.context));
  if (left.length === 0) return 'none';
  if (left.length > 1) return 'ambiguous';
  const hit = byId.get(left[0].id) as Hit;
  return { match: { contextId: hit.context.id, reason: hit.reason, strong } };
}

/** Walks the rungs in order. The first one that decides wins; an ambiguous rung ends the walk unsorted. */
function climb(rungs: readonly (() => Rung)[]): Match | null {
  for (const rung of rungs) {
    const result = rung();
    if (result === 'ambiguous') return null;
    if (result !== 'none') return result.match;
  }
  return null;
}

// Names too common in ordinary titles to say anything about a project.
const EVERYDAY_WORDS = new Set([
  'test', 'tests', 'work', 'docs', 'demo', 'demos', 'main', 'home', 'code', 'apps', 'site', 'blog', 'notes', 'misc', 'temp',
  'project', 'projects', 'default', 'personal', 'general', 'new', 'web', 'app', 'api',
]);

function namesOf(ctx: MatchableContext): readonly string[] {
  const names = [ctx.name, ctx.folder ? basename(ctx.folder) : '', ...(ctx.aliases ?? [])];
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
}

function nameHits(title: string, contexts: readonly MatchableContext[], minLength: number): readonly Hit[] {
  const hits: Hit[] = [];
  for (const context of contexts) {
    const name = namesOf(context).find(
      (n) => n.length >= minLength && !EVERYDAY_WORDS.has(n.toLowerCase()) && hasToken(title, n),
    );
    if (name) hits.push({ context, reason: `title mentions "${name}"` });
  }
  return hits;
}

// --- Browser windows ------------------------------------------------------------

const BROWSER_BUNDLES = [
  'com.google.Chrome', 'company.thebrowser.Browser', 'company.thebrowser.dia', 'com.apple.Safari', 'org.mozilla.firefox',
  'com.brave.Browser', 'com.microsoft.edgemac', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera',
];
const BROWSER_SUFFIXES = [' - Google Chrome', ' — Mozilla Firefox', ' - Brave', ' - Microsoft Edge', ' - Vivaldi', ' - Opera'];
const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const MIN_BROWSER_NAME = 4;

export function isBrowserBundle(bundleId: string): boolean {
  return BROWSER_BUNDLES.some((b) => bundleId === b || bundleId.startsWith(`${b}.`));
}

/** "Page - Google Chrome - Profile" -> "Page": the app and profile names say nothing about the page. */
function pageTitle(title: string): string {
  for (const suffix of BROWSER_SUFFIXES) {
    const at = title.lastIndexOf(suffix);
    if (at >= 0) return title.slice(0, at);
  }
  return title;
}

/** What a context's URL pattern looks like when only the page title is visible. */
function patternInTitle(pattern: Normalized, title: string): string | null {
  const [name, port] = splitPort(pattern.host);
  if (name === 'localhost' && port) {
    return new RegExp(`(^|[^A-Za-z0-9.])(localhost|127\\.0\\.0\\.1):${port}(?!\\d)`, 'i').test(title) ? `title shows localhost:${port}` : null;
  }
  if (CODE_HOSTS.has(pattern.host) && pattern.segments.length >= 2 && !pattern.segments.includes('*')) {
    const slug = `${pattern.segments[0]}/${pattern.segments[1]}`;
    return hasToken(title, slug) ? `title names repo ${slug}` : null;
  }
  if (pattern.host === 'vercel.com' && pattern.segments.length === 2 && /\bvercel\b/i.test(title)) {
    return hasToken(title, pattern.segments[1]) ? `title names Vercel project ${pattern.segments[1]}` : null;
  }
  return null;
}

function serviceHits(title: string, contexts: readonly MatchableContext[]): readonly Hit[] {
  const hits: Hit[] = [];
  for (const context of contexts) {
    for (const raw of context.patterns) {
      const pattern = normalizePattern(raw);
      const reason = pattern ? patternInTitle(pattern, title) : null;
      if (reason) {
        hits.push({ context, reason });
        break;
      }
    }
  }
  return hits;
}

function tabVotes(tabs: readonly { readonly url: string }[], contexts: readonly MatchableContext[]): Rung {
  const votes = new Map<string, number>();
  for (const tab of tabs) {
    const id = matchUrl(tab.url, contexts);
    if (id) votes.set(id, (votes.get(id) ?? 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return 'none';
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return 'ambiguous';
  const [id, count] = ranked[0];
  const name = contexts.find((c) => c.id === id)?.name ?? id;
  return { match: { contextId: id, reason: `${count} of ${tabs.length} tabs match ${name}`, strong: true } };
}

/**
 * Browser window: the context with the most matched tabs (unmatched tabs do not vote, a tie is unsorted).
 * When no tab says anything, or the tabs cannot be read, the title of the active tab decides:
 * repo owner/name, Vercel project or localhost port first, then a project name as a whole word.
 */
export function matchBrowserWindow(win: BrowserWindowLike, contexts: readonly MatchableContext[]): Match | null {
  // A named window's title is its name, often the context's own: matching that would keep the window there for good,
  // so the active tab's title (or, unknown, every tab's) stands in for the page title.
  const named = Boolean(win.name) && pageTitle(win.title).trim() === win.name?.trim();
  const title = named ? win.activeTitle ?? win.tabs.map((t) => t.title ?? '').join(' · ') : pageTitle(win.title);
  return climb([
    () => tabVotes(win.tabs, contexts),
    () => decide(serviceHits(title, contexts), false),
    () => decide(nameHits(title, contexts, MIN_BROWSER_NAME), false),
  ]);
}

// --- Terminal, editor and other app windows ----------------------------------------

function documentPath(doc: string): string {
  if (!doc.startsWith('file://')) return doc;
  try {
    return decodeURIComponent(new URL(doc).pathname);
  } catch {
    return doc;
  }
}

/** Strip leading glyphs/spaces (Claude Code prefixes a status symbol) and fold case. */
export function normalizeTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
}

/** A terminal title that is exactly one known Claude session's title. The same title in two contexts decides nothing. */
function sessionRung(title: string, entries: readonly TitleEntry[], contexts: readonly MatchableContext[]): Rung {
  const wanted = normalizeTitle(title);
  if (wanted.length === 0) return 'none';
  const matching = entries.filter((e) => normalizeTitle(e.title) === wanted);
  const ids = new Set(matching.map((e) => e.contextId));
  if (ids.size !== 1 || !contexts.some((c) => c.id === matching[0].contextId)) return 'none';
  return { match: { contextId: matching[0].contextId, reason: `Claude session "${matching[0].title}"`, strong: true } };
}

function pathHits(text: string, contexts: readonly MatchableContext[], say: (folder: string) => string): readonly Hit[] {
  return contexts
    .filter((c) => c.folder && new RegExp(`${escapeRegExp(c.folder)}(?![A-Za-z0-9_-])`).test(text))
    .map((context) => ({ context, reason: say(context.folder as string) }));
}

/** "file — folder [SSH: host]" -> ["file", "folder"]: the parts editors join with a dash. */
function titleParts(title: string): readonly string[] {
  return title
    .split(/\s[—–-]\s/)
    .map((part) => part.replace(/\s*(\[[^\]]*\]|\(Workspace\))\s*$/i, '').trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function workspaceHits(title: string, contexts: readonly MatchableContext[]): readonly Hit[] {
  const parts = titleParts(title);
  const hits: Hit[] = [];
  for (const context of contexts) {
    const name = namesOf(context).find((n) => parts.includes(n.toLowerCase()));
    if (name) hits.push({ context, reason: `workspace folder "${name}"` });
  }
  return hits;
}

const MIN_APP_NAME = 3;

/**
 * Terminal, editor or any other app window. In order: a known Claude session title, a context folder
 * path in the title, a title part equal to a project name ("file — folder"), the open document's
 * folder, and last a project name as a word in the title.
 */
export function matchAppWindow(
  win: AppWindowLike,
  contexts: readonly MatchableContext[],
  sessionTitles: readonly TitleEntry[],
): Match | null {
  const doc = win.document ? documentPath(win.document) : null;
  return climb([
    () => sessionRung(win.title, sessionTitles, contexts),
    () => decide(pathHits(win.title, contexts, (folder) => `title shows ${folder}`), true),
    () => decide(workspaceHits(win.title, contexts), true),
    () => (doc ? decide(contexts.filter((c) => c.folder && insideFolder(doc, c.folder)).map((context) => ({ context, reason: `open in ${context.folder}` })), true) : 'none'),
    () => decide(nameHits(win.title, contexts, MIN_APP_NAME), false),
  ]);
}

/** Any window: browsers (by tab list or bundle id) follow tabs and page title, everything else the app ladder. */
export function matchWindow(
  win: WindowLike,
  contexts: readonly MatchableContext[],
  sessionTitles: readonly TitleEntry[],
): Match | null {
  if (win.browser || isBrowserBundle(win.bundleId)) {
    return matchBrowserWindow({ title: win.title, tabs: win.browser?.tabs ?? [], name: win.browser?.name, activeTitle: win.browser?.activeTitle }, contexts);
  }
  return matchAppWindow(win, contexts, sessionTitles);
}

// --- Learned rules -------------------------------------------------------------------

const GENERIC_HOSTS = new Set([
  'google.com', 'youtube.com', 'bing.com', 'duckduckgo.com', 'facebook.com', 'x.com', 'twitter.com',
  'reddit.com', 'linkedin.com', 'amazon.com', 'wikipedia.org',
]);

/** Hosts shared by many projects: how many path segments it takes to name one of them. */
const SHARED_HOST_DEPTH: Readonly<Record<string, number>> = {
  'github.com': 2, 'gitlab.com': 2, 'bitbucket.org': 2, 'vercel.com': 2, 'docs.google.com': 3, 'supabase.com': 3,
};
/** First path segments on those hosts that are the site's own pages, not an owner or team. */
const SITE_PAGES = new Set([
  'settings', 'notifications', 'pulls', 'issues', 'orgs', 'organizations', 'search', 'explore', 'marketplace', 'login',
  'new', 'account', 'dashboard', 'docs', 'features', 'pricing', 'topics', 'sponsors',
]);

function isGenericHost(host: string): boolean {
  return host !== 'docs.google.com' && GENERIC_HOSTS.has(host.split('.').slice(-2).join('.'));
}

function specificEnough(host: string, segments: readonly string[]): boolean {
  const depth = SHARED_HOST_DEPTH[host];
  if (depth === undefined) return true;
  if (segments.length < depth) return false;
  if (host === 'supabase.com') return segments[0] === 'dashboard' && segments[1] === 'project';
  return !SITE_PAGES.has(segments[0]);
}

/** False for a rule that would sweep up every project on a shared host, like "github.com/owner". */
export function ruleIsSpecific(pattern: string): boolean {
  const n = normalizePattern(pattern);
  return n !== null && specificEnough(n.host, n.segments);
}

/**
 * Rule learned from a manual assignment. Ordinary sites: host + first path segment. Hosts shared by many
 * projects: as deep as it takes to name one (a repo, not its owner). A local server: host and port.
 * Generic sites, and pages too shallow to name a project, are never learned.
 */
export function learnPattern(url: string): string | null {
  const n = normalizeUrl(url);
  if (!n || isGenericHost(n.host) || !specificEnough(n.host, n.segments)) return null;
  if (n.host.startsWith('localhost')) return n.host;
  const depth = SHARED_HOST_DEPTH[n.host] ?? 1;
  return [n.host, ...n.segments.slice(0, depth)].join('/');
}
