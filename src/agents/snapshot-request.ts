import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Capture } from "../types.js";
import type { CallLog } from "../db.js";

/**
 * Records the exact request body a sub-agent would send, without sending it.
 *
 * This exists for one reason: the refactor that pulled the generic runner out of
 * heuristics.ts had to be provably behaviour-preserving. A saved snapshot of the
 * pre-refactor request, diffed against the post-refactor request, is the only
 * proof that costs nothing and cannot be argued with. Prompt edits are supposed
 * to move this file — that is the point; the diff is the review surface.
 *
 *   npm run snapshot          # write fixtures/requests/<agent>.json
 *   npm run snapshot -- check # rebuild in memory and diff against disk
 */

const FIXTURE_DIR = "fixtures/requests";

/** Thrown to unwind out of the agent function once we have what we came for. */
class Captured extends Error {
  constructor(public request: unknown) {
    super("request captured");
  }
}

/**
 * A client whose only job is to steal the request and refuse to make it.
 *
 * It both records into `seen` and throws. Throwing unwinds a well-behaved agent
 * immediately; recording covers the agents that catch their own failures and
 * degrade rather than propagate — which is most of them, by design (§7). Without
 * the holder, snapshotting one of those would report "never called the model".
 */
export function recordingClient(seen: { request?: unknown } = {}): Anthropic {
  return {
    messages: {
      parse: async (request: unknown) => {
        seen.request = request;
        throw new Captured(request);
      },
    },
  } as unknown as Anthropic;
}

/** A CallLog that swallows the failure row the agent writes on its way out. */
export function silentLog(): CallLog {
  return { record: () => {}, totalCost: () => 0, close: () => {} } as unknown as CallLog;
}

export async function requestFor(
  fn: (client: Anthropic, capture: Capture, log: CallLog) => Promise<unknown>,
  capture: Capture,
): Promise<unknown> {
  const seen: { request?: unknown } = {};
  try {
    await fn(recordingClient(seen), capture, silentLog());
  } catch (err) {
    if (err instanceof Captured) return err.request;
    throw err;
  }
  if (seen.request !== undefined) return seen.request;
  throw new Error("agent returned without calling messages.parse");
}

export function loadCapture(name: string): Capture {
  const parsed = Capture.parse(
    JSON.parse(readFileSync(path.join("fixtures/captures", `${name}.json`), "utf8")),
  );

  // A frozen capture records the screenshot it was taken with, but that file
  // lives under out/, which is gitignored — so on a fresh clone it is simply
  // not there, and the snapshot harness would build a request with no images
  // and call it unchanged. The fixtures are meant to be hermetic. When a
  // committed screenshot sits beside the JSON, prefer it.
  const committed = path.join("fixtures/captures", `${name}-page.png`);
  return existsSync(committed) ? { ...parsed, screenshot_path: committed } : parsed;
}

/**
 * Replaces image payloads with a digest of themselves.
 *
 * A single 1440x900 PNG is ~200KB of base64, and govuk is six of them. Embedded
 * verbatim, every request fixture gains megabytes, `npm run snapshot -- check`
 * diffs become unreadable, and the one thing the snapshot exists for — being a
 * review surface a person actually reads — is lost.
 *
 * A digest keeps every property that matters: the number of images, their order
 * and position in the message, and whether the bytes changed. It does not let
 * you eyeball the picture, which was never what this file was for.
 */
export function digestImages(request: unknown): unknown {
  if (Array.isArray(request)) return request.map(digestImages);
  if (request === null || typeof request !== "object") return request;

  const obj = request as Record<string, unknown>;
  if (obj.type === "image") {
    const source = obj.source as { media_type?: string; data?: string } | undefined;
    const data = source?.data ?? "";
    return {
      type: "image",
      source: {
        media_type: source?.media_type ?? "unknown",
        bytes: Buffer.from(data, "base64").length,
        sha256: createHash("sha256").update(data).digest("hex").slice(0, 16),
      },
    };
  }

  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, digestImages(v)]));
}

export function fixturePath(agent: string): string {
  return path.join(FIXTURE_DIR, `${agent}.json`);
}

export function writeFixture(agent: string, request: unknown): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(fixturePath(agent), JSON.stringify(digestImages(request), null, 2) + "\n");
}
