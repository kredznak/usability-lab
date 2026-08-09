import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
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

/** A client whose only job is to steal the request and refuse to make it. */
export function recordingClient(): Anthropic {
  return {
    messages: {
      parse: async (request: unknown) => {
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
  try {
    await fn(recordingClient(), capture, silentLog());
  } catch (err) {
    if (err instanceof Captured) return err.request;
    throw err;
  }
  throw new Error("agent returned without calling messages.parse");
}

export function loadCapture(name: string): Capture {
  return Capture.parse(
    JSON.parse(readFileSync(path.join("fixtures/captures", `${name}.json`), "utf8")),
  );
}

export function fixturePath(agent: string): string {
  return path.join(FIXTURE_DIR, `${agent}.json`);
}

export function writeFixture(agent: string, request: unknown): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(fixturePath(agent), JSON.stringify(request, null, 2) + "\n");
}
