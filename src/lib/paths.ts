/** POSIX path helpers for display (Rust does all real path handling). */

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return "/";
  return trimmed.slice(0, i);
}

/** `~/…` for paths inside the home folder. */
export function tildify(path: string, home: string | null = guessHome(path)): string {
  if (home && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

function guessHome(path: string): string | null {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(path);
  return m ? m[1] : null;
}

const MARKDOWN = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN.test(path);
}

/**
 * Titles for tabs whose file names collide: the shortest parent-folder
 * suffix that tells them apart ("README.md — api", "README.md — web").
 */
export function disambiguate(paths: (string | null)[]): (string | null)[] {
  const names = paths.map((p) => (p ? basename(p) : null));
  const out: (string | null)[] = names.map(() => null);
  const groups = new Map<string, number[]>();
  names.forEach((n, i) => {
    if (!n) return;
    const list = groups.get(n) ?? [];
    list.push(i);
    groups.set(n, list);
  });
  for (const indices of groups.values()) {
    const unique = new Set(indices.map((i) => paths[i]));
    if (unique.size < 2) continue;
    const parts = indices.map((i) => dirname(paths[i]!).split("/").filter(Boolean).reverse());
    for (let depth = 1; depth <= 8; depth++) {
      const labels = parts.map((p) => p.slice(0, depth).reverse().join("/"));
      const distinct = new Set(labels).size === new Set(indices.map((i) => paths[i])).size;
      if (distinct || depth === 8) {
        indices.forEach((idx, k) => {
          out[idx] = labels[k] || "/";
        });
        break;
      }
    }
  }
  return out;
}
