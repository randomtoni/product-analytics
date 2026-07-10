import type { FlagSet, ShapeOf } from 'analytics-kit';
import { defineTaxonomy } from 'analytics-kit';
import { expect, expectTypeOf, test } from 'vitest';
import { createFlagClient } from './create-flag-client';

// Taxonomy-typed reads narrow identically to the browser adapter — both satisfy FeatureFlagPort<TX>,
// so the factory carrying TX from a typed `config.taxonomy` is the whole story. Compile-time pins,
// validated by tsc --noEmit; never executed against a backend.

const taxonomy = defineTaxonomy({
  events: { order_placed: { amount: 'number' } },
  flags: {
    checkout_variant: { variants: ['a', 'b'], payload: { discount: 'number' } },
    dark_mode: {},
  },
});

type TX = ShapeOf<(typeof taxonomy)['decl']>;

test('createFlagClient carries TX so getFlag/getPayload narrow per declared variants/payload', async () => {
  const client = createFlagClient({ key: 'k', flagEndpoint: 'https://flags.example', taxonomy });

  expectTypeOf(client.evaluate).returns.resolves.toEqualTypeOf<FlagSet<TX>>();

  const set = await client.evaluate({ distinctId: 'u_1' });

  expectTypeOf(set.getFlag('checkout_variant')).toEqualTypeOf<'a' | 'b' | boolean | undefined>();
  expectTypeOf(set.getPayload('checkout_variant')).toEqualTypeOf<{ discount: number } | undefined>();
  expectTypeOf(set.getFlag('dark_mode')).toEqualTypeOf<boolean | undefined>();
  expectTypeOf(set.getPayload('dark_mode')).toEqualTypeOf<unknown>();

  expect(typeof set.getFlag).toBe('function');
});
