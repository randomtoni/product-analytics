import { defineTaxonomy } from 'analytics-kit';

export const fernlyTaxonomy = defineTaxonomy({
  events: {
    signup_started: {},
    signup_completed: { plan: 'string' },
    document_uploaded: { documentId: 'string', sizeBytes: 'number' },
    review_requested: { documentId: 'string', reviewerId: 'string' },
    comment_added: { documentId: 'string', resolved: 'boolean' },
    review_completed: { documentId: 'string', approved: 'boolean' },
    plan_upgraded: { fromPlan: 'string', toPlan: 'string', at: 'date' },
  },
  traits: {
    role: 'string',
    plan: 'string',
    email: 'string',
  },
  groups: {
    workspace: { name: 'string', seats: 'number' },
    team: { name: 'string' },
  },
  page: {
    path: 'string',
    referrer: 'string',
  },
  flags: {
    // A variant flag with a typed payload — exercises getFlag narrowing (to the variant
    // union | boolean) and getPayload narrowing (to the declared payload shape).
    review_ai_summary: {
      variants: ['control', 'concise', 'detailed'],
      payload: { model: 'string', maxTokens: 'number' },
    },
    // A bare on/off flag (no variants, no payload) — getFlag narrows to boolean.
    bulk_review_actions: {},
  },
});

export type FernlyTaxonomy = typeof fernlyTaxonomy;
