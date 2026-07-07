# Research corpus — release 1

This directory holds the architect's grounding research for analytics-kit release 1. Its
centerpiece, `ARCHITECT-RELEASE1.md`, is the architecture memo the PM/refiner agents plan epics
E1–E11 from: one section per epic answering the load-bearing "which shape is right?" questions,
each with a recommendation, the alternatives considered and rejected, a confidence rating, and
citations into the local `posthog-js/` reference checkout (read at its current HEAD as
`posthog-js/packages/{core,browser,node,react}/src/...:LINE`). posthog-js is cited only as the
capability/mechanics reference we **port from and de-brand** — never a dependency, and never named
in the library's own surface; every neutral-seam decision here is made against the two acceptance
bars (provider-swap = one adapter; new-app = config only) and the zero-vendor-reference rule, not
by copying PostHog's shapes. Citations were gathered by four source-mapping passes over
transport/node, identity/persistence/sessions, capture/enrichment/autocapture, and the shared
core-seam/react/query surface, then spot-verified against the checkout.
