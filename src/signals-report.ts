import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Capture } from "./types.js";
import { deriveSignals } from "./signals.js";

/**
 * `npm run signals` — prints the derived signals for every frozen fixture.
 *
 * The thresholds in signals.ts were set from this table rather than from taste.
 * When you change one, run this and check that each threshold still has fixtures
 * on both sides of it; a signal that fires on everything routes nothing.
 */

const dir = "fixtures/captures";
const rows = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const capture = Capture.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
    return { name: f.replace(/\.json$/, ""), s: deriveSignals(capture) };
  });

const header = [
  "fixture".padEnd(15),
  "kind".padEnd(9),
  "fields".padStart(6),
  "form?".padStart(6),
  "unlab".padStart(6),
  "unnamed".padStart(8),
  "a11y?".padStart(6),
  "chars/scr".padStart(10),
  "dense?".padStart(7),
  "compet".padStart(7),
  "h1".padStart(3),
  "hier?".padStart(6),
].join(" ");

console.log(header);
console.log("-".repeat(header.length));

for (const { name, s } of rows) {
  console.log(
    [
      name.padEnd(15),
      s.page_kind.padEnd(9),
      String(s.form_fields).padStart(6),
      String(s.has_substantive_form).padStart(6),
      String(s.unlabelled_fields).padStart(6),
      String(s.unnamed_interactives).padStart(8),
      String(s.a11y_signal).padStart(6),
      String(s.copy_density).padStart(10),
      String(s.copy_dense).padStart(7),
      String(s.competing_emphases).padStart(7),
      String(s.h1_count).padStart(3),
      String(s.hierarchy_signal).padStart(6),
    ].join(" "),
  );
}
