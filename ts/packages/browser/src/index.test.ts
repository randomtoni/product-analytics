import { expect, test } from 'vitest';
import { version } from './index';

test('exposes the package version', () => {
  expect(version).toBe('0.1.0');
});
