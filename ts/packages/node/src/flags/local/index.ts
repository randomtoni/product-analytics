// The adapter-internal local-evaluation surface S2 binds to. Exported from this subdir barrel ONLY
// — NOT from the node package's own `index.ts`. Nothing here reaches a consumer; it's the machinery
// the S2 adapter branch consumes to evaluate flags in-process before falling back to the remote
// path.

export { InconclusiveMatchError, RequiresServerEvaluation } from './errors';
export { bucketHash, hashSHA1 } from './hash';
export { matchProperty } from './match-property';
export { matchCohort, matchPropertyGroup } from './match-cohort';
export {
  evaluateFlagLocally,
  computeFlagLocally,
  resolveBucketingValue,
} from './evaluator';
export { DefinitionPoller } from './definition-poller';
export type { DefinitionPollerConfig } from './definition-poller';
export type {
  DefinitionSnapshot,
  FlagDefinition,
  FlagCondition,
  FlagVariant,
  FlagProperty,
  FlagPropertyValue,
  PropertyGroup,
  PropertyBag,
} from './definition-types';
