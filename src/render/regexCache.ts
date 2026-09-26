/**
 * Shiki's JavaScript engine translates every Oniguruma pattern of a grammar
 * into a JavaScript RegExp the first time it's used, and that translation is
 * most of the cost of the first highlight (≈250 ms for TypeScript). The
 * translations are pure functions of the pattern, the translator version and
 * the regex features of this WebKit, so they're kept in IndexedDB and reused
 * on later launches: only `new RegExp()` remains.
 *
 * Everything here is best effort. Without IndexedDB (tests, private
 * storage), patterns are simply translated as usual.
 */
import { EmulatedRegExp, toRegExpDetails, type ToRegExpOptions } from "oniguruma-to-es";

type Details = ReturnType<typeof toRegExpDetails>;
/** `null` records a pattern this engine can't express. */
type Entry = Details | null;

declare const __REGEX_ENGINE_VERSION__: string | undefined;

const ENGINE_VERSION = typeof __REGEX_ENGINE_VERSION__ === "string" ? __REGEX_ENGINE_VERSION__ : "dev";
const DB_NAME = "folio-highlighting";
const STORE = "regex";
const MAX_ENTRIES = 30_000;

/** The newest regex syntax this engine accepts (what "auto" would pick). */
function detectTarget(): NonNullable<ToRegExpOptions["target"]> {
  try {
    new RegExp("(?i:a)");
    new RegExp("(?<n>a)|(?<n>b)");
    return "ES2025";
  } catch {
    /* older */
  }
  try {
    new RegExp("", "v");
    return "ES2024";
  } catch {
    return "ES2018";
  }
}

const TARGET = detectTarget();
const RECORD_KEY = `${ENGINE_VERSION}|${TARGET}`;

/** The same options as Shiki's default constructor, with the target fixed. */
const OPTIONS: ToRegExpOptions = {
  global: true,
  hasIndices: true,
  lazyCompileLength: 3000,
  rules: {
    allowOrphanBackrefs: true,
    asciiWordBoundaries: true,
    captureGroup: true,
    recursionLimit: 5,
    singleline: true,
  },
  target: TARGET,
};

const known = new Map<string, Entry>();
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loading: Promise<void> | null = null;

class UnsupportedPattern extends Error {}

function build(entry: Details): RegExp {
  return entry.options ? new EmulatedRegExp(entry.pattern, entry.flags, entry.options) : new RegExp(entry.pattern, entry.flags);
}

/** Regex constructor for Shiki's JavaScript engine. */
export function constructRegex(pattern: string): RegExp {
  let entry = known.get(pattern);
  if (entry === undefined) {
    try {
      entry = toRegExpDetails(pattern, OPTIONS);
    } catch (err) {
      entry = null;
      if (!(err instanceof Error)) throw err;
    }
    if (known.size < MAX_ENTRIES) {
      known.set(pattern, entry);
      dirty = true;
    }
  }
  if (entry === null) throw new UnsupportedPattern(pattern);
  return build(entry);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

/** Loads saved translations; resolves within `timeoutMs` regardless. */
export function loadRegexCache(timeoutMs = 200): Promise<void> {
  loading ??= new Promise<void>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    openDb()
      .then((db) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY);
        req.onsuccess = () => {
          const saved = req.result as [string, Entry][] | undefined;
          if (Array.isArray(saved)) {
            for (const [pattern, entry] of saved) if (!known.has(pattern)) known.set(pattern, entry);
          }
          db.close();
          done();
        };
        req.onerror = () => {
          db.close();
          done();
        };
      })
      .catch(done);
  });
  return loading;
}

/** Saves new translations shortly after highlighting settles. */
export function scheduleRegexCacheSave(delayMs = 2000): void {
  if (!dirty || typeof indexedDB === "undefined") return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    const entries = [...known.entries()];
    openDb()
      .then((db) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        // One record per translator version and regex target; older ones go.
        store.clear();
        store.put(entries, RECORD_KEY);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      })
      .catch(() => {
        /* best effort */
      });
  }, delayMs);
}

