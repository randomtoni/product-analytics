// The two distinct inconclusive signals the local evaluator throws when it holds a definition but
// cannot decide the outcome in-process. Both propagate OUT of the evaluator unhandled here — S2
// catches them to drive the local→remote fallback ladder. Neutral names/messages: no vendor token.
// De-branded from posthog's feature-flags.ts InconclusiveMatchError / RequiresServerEvaluation.

// setPrototypeOf restores the prototype chain so `instanceof` works after the Error super() call
// (a well-known TS/ES gotcha when extending built-in Error under some transpile targets). S2
// distinguishes the two signals by `instanceof`, so this must hold.

// "Have the definition, can't decide with the properties given" — a missing person property under
// a value operator, a bad regex/date/semver, or a flag dependency (deferred to S2/remote). Retry
// remotely if the adapter config allows it.
export class InconclusiveMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InconclusiveMatchError';
    Object.setPrototypeOf(this, InconclusiveMatchError.prototype);
  }
}

// "Definition references server-only data" — a cohort referenced by a filter that is absent from
// the locally-fetched cohort map (a static cohort). Distinct from InconclusiveMatchError: it means
// the definition itself needs the server, not that the given properties were insufficient.
export class RequiresServerEvaluation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequiresServerEvaluation';
    Object.setPrototypeOf(this, RequiresServerEvaluation.prototype);
  }
}
