import { AsyncLocalStorage } from "node:async_hooks";

/**
 * How many times did that call actually hit the network?
 *
 * B14: one synthesizer call took 1618s and wrote a single row reading `ok=1`.
 * Every other synthesizer call this project had made ran 8-40s. The best
 * explanation was two SDK timeouts and a third attempt — three generations
 * billed, one logged — but the retries happen inside the SDK and leave no
 * trace, so it stayed a hypothesis through four more slow runs.
 *
 * Re-running until a slow one appears is an unbounded experiment. Counting the
 * attempts costs nothing and answers the question the next time it happens.
 *
 * ## Why AsyncLocalStorage and not a counter
 *
 * Two sub-agents run concurrently (§6), so a module-level counter cannot say
 * which call an attempt belonged to. ALS gives each awaited call its own store,
 * and the fetch wrapper increments whichever one it finds itself inside.
 */

const store = new AsyncLocalStorage<{ attempts: number }>();

/**
 * A `fetch` that counts attempts made inside a `counted()` scope.
 *
 * Deliberately a wrapper rather than a replacement: it adds one increment and
 * delegates. Anything it did beyond that would be a second HTTP client to keep
 * correct.
 */
export function countingFetch(base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const scope = store.getStore();
    if (scope) scope.attempts += 1;
    return base(input, init);
  };
}

/**
 * Runs one model call and reports how many HTTP attempts it took.
 *
 * `attempts` is 1 on a clean call. Anything higher is the SDK retrying, which
 * is exactly what we could not see before — and it means the cost row under it
 * covers one attempt while we paid for several.
 */
export async function counted<T>(fn: () => Promise<T>): Promise<{ result: T; attempts: number }> {
  const scope = { attempts: 0 };
  const result = await store.run(scope, fn);
  return { result, attempts: scope.attempts };
}

/**
 * Attempts made so far in the current scope, for the error path.
 *
 * A call that throws never reaches `counted`'s return, and the failure is the
 * case most worth counting — B14's whole problem was a step whose expensive
 * attempts were invisible.
 */
export function attemptsHere(): number {
  return store.getStore()?.attempts ?? 0;
}
