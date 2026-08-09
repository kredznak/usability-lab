import { buildCorpus } from "./corpus.js";

/** `npm run corpus` — see src/corpus.ts for what this is and why. */
const built = buildCorpus();
for (const a of built.built_from) {
  console.log(`${a.audit_id.slice(0, 8)}  ${String(a.findings).padStart(3)} findings  ${a.url}`);
}
for (const s of built.skipped) console.log(`${s.audit_id.slice(0, 8)}  skipped — ${s.reason}`);
const contradicted = built.findings.filter((f) => f.auto.status === "contradicted");
const unlabelled = built.findings.filter((f) => f.human_useful === null && f.human_true === null);
console.log(
  `\n${built.findings.length} findings from ${built.built_from.length} audits` +
    `\n${contradicted.length} mechanically contradicted` +
    `\n${unlabelled.length} awaiting a human label`,
);
