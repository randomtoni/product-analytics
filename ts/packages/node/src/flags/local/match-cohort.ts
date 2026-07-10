import { InconclusiveMatchError, RequiresServerEvaluation } from './errors';
import { matchProperty } from './match-property';
import type {
  FlagProperty,
  PropertyBag,
  PropertyGroup,
} from './definition-types';

// The recursive cohort sub-engine, ported in behavior from posthog's node `matchCohort` /
// `matchPropertyGroup` — de-branded. A cohort is a nested AND/OR boolean tree over leaf property
// filters; a leaf may itself reference another cohort. All synchronous, pure functions.
// De-branded from posthog's feature-flags.ts matchCohort / matchPropertyGroup / checkCohortExists.

// True iff the actor is in the referenced cohort. Throws RequiresServerEvaluation when the cohort
// id is absent from the locally-fetched map (a static cohort — server-only data), and
// InconclusiveMatchError when a leaf property can't be decided locally.
export function matchCohort(
  property: FlagProperty,
  propertyValues: PropertyBag,
  cohorts: Readonly<Record<string, PropertyGroup>>
): boolean {
  const cohortId = String(property.value);
  if (!(cohortId in cohorts)) {
    throw new RequiresServerEvaluation(
      `cohort ${cohortId} is not in the local cohort map — a static cohort that requires server evaluation`
    );
  }
  return matchPropertyGroup(cohorts[cohortId], propertyValues, cohorts);
}

// Walk one AND/OR property group. A RequiresServerEvaluation from any leaf propagates immediately
// (server-only data). An InconclusiveMatchError is remembered but doesn't abort the walk — only if
// no branch resolves the group AND something was inconclusive does the group throw inconclusive.
export function matchPropertyGroup(
  propertyGroup: PropertyGroup,
  propertyValues: PropertyBag,
  cohorts: Readonly<Record<string, PropertyGroup>>
): boolean {
  if (!propertyGroup) {
    return true;
  }
  const groupType = propertyGroup.type;
  const properties = propertyGroup.values;
  if (!properties || properties.length === 0) {
    // Empty groups are no-ops — always match.
    return true;
  }

  let errorMatchingLocally = false;

  if ('values' in properties[0]) {
    // Nested property groups.
    for (const prop of properties as PropertyGroup[]) {
      try {
        const matches = matchPropertyGroup(prop, propertyValues, cohorts);
        if (groupType === 'AND') {
          if (!matches) {
            return false;
          }
        } else if (matches) {
          return true;
        }
      } catch (err) {
        if (err instanceof RequiresServerEvaluation) {
          throw err;
        } else if (err instanceof InconclusiveMatchError) {
          errorMatchingLocally = true;
        } else {
          throw err;
        }
      }
    }
  } else {
    // Leaf property filters.
    for (const prop of properties as FlagProperty[]) {
      try {
        let matches: boolean;
        if (prop.type === 'cohort') {
          matches = matchCohort(prop, propertyValues, cohorts);
        } else if (prop.type === 'flag') {
          // Flag-dependency chains are deferred (S2/remote handles them): any flag-typed property
          // inside a cohort is inconclusive locally.
          throw new InconclusiveMatchError(
            `Flag dependency '${prop.key}' cannot be evaluated locally`
          );
        } else {
          matches = matchProperty(prop, propertyValues);
        }

        const negation = prop.negation || false;
        if (groupType === 'AND') {
          if (!matches && !negation) {
            return false;
          }
          if (matches && negation) {
            return false;
          }
        } else {
          if (matches && !negation) {
            return true;
          }
          if (!matches && negation) {
            return true;
          }
        }
      } catch (err) {
        if (err instanceof RequiresServerEvaluation) {
          throw err;
        } else if (err instanceof InconclusiveMatchError) {
          errorMatchingLocally = true;
        } else {
          throw err;
        }
      }
    }
  }

  if (errorMatchingLocally) {
    throw new InconclusiveMatchError('Cannot match cohort without the required property value');
  }
  // All matched in the AND case, or none matched in the OR case.
  return groupType === 'AND';
}
