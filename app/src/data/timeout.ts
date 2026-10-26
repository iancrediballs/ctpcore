// A local read that never answers must not leave the UI waiting forever with nothing said.
// CAT-15 (26 Oct QA): after a long sweep the diagram list lost its stock/price/Open and the
// part sheet stopped opening, with no error: device-DB reads that never settled. The cause
// was not reproducible here; this makes the condition visible and retryable instead of silent.
export class TimeoutError extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new TimeoutError(`${what} did not answer in ${ms / 1000} s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}
