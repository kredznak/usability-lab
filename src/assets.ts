/**
 * The handful of static files the marketing pages need, read once at boot.
 *
 * ## Why a map and not a directory
 *
 * The request path never touches the filesystem. `asset()` is a lookup in a
 * `Map` whose keys were fixed before the server accepted a connection, so there
 * is no path to join, nothing to normalise, and no `..` to strip. Directory
 * traversal is not defended against here — it has nowhere to happen.
 *
 * That is the same rule `server.ts` already applies to audit images, and at this
 * size it is strictly better than sanitising: the bytes are already in memory,
 * so a request costs no I/O either. `assets/` holds three files and exactly one
 * of them is servable.
 *
 * ## Why it reads eagerly
 *
 * A missing or unreadable font should stop the server at boot with a stack
 * trace naming the file. Read lazily, it would instead serve a page with no
 * webfont on it — which looks *almost* right, falls back to the system stack,
 * and gets noticed by a customer a week later rather than by whoever broke it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

interface Asset {
  body: Buffer;
  type: string;
}

/**
 * The whole allowlist. `inter-LICENSE.txt` sits beside the font in `assets/`
 * and is deliberately absent here — the OFL requires it to ship, not to be
 * served.
 */
const FILES: [name: string, type: string][] = [["inter.woff2", "font/woff2"]];

const TABLE = new Map<string, Asset>(
  FILES.map(([name, type]) => [name, { body: readFileSync(path.join(ROOT, name)), type }]),
);

/** In declaration order, so a test can assert the whole set rather than a member. */
export const ASSET_NAMES: string[] = FILES.map(([name]) => name);

export function asset(name: string): Asset | null {
  return TABLE.get(name) ?? null;
}
