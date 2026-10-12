/** Settle at cancellation even if a transport/body reader fails to honour abort.
 * Callers must still pass the signal to I/O and discard any late result.
 */
export function abortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Request cancelled"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
