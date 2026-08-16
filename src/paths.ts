/**
 * Where a run reads and writes, in one place so a test can redirect all of it.
 *
 * Both constants exist for the same reason: `review.ts` decides what a paying
 * visitor sees, and until now the only way to exercise it was to run it against
 * the working database and the real `out/` directory. Untestable code is how
 * that file shipped a bug that silently discarded sixteen of seventeen answers.
 *
 * Read at import, so a test sets the env var before importing — or, for the
 * end-to-end test, spawns the script as its own process.
 */

/** The SQLite file holding `model_calls` and `audits`. */
export const DB_PATH = process.env.USABILITY_LAB_DB || "out/usability-lab.db";

/** The directory holding one folder of artifacts per audit. */
export const OUT_ROOT = process.env.USABILITY_LAB_OUT || "out";

/**
 * The labelled corpus the outcome suite scores against.
 *
 * Redirectable for the same reason as the other two, with an extra edge:
 * `buildCorpus()` both reads and writes this file, so a test that did not
 * redirect it would overwrite months of human labels to assert one thing.
 */
export const CORPUS_ROOT = process.env.USABILITY_LAB_CORPUS || "fixtures/labelled";
