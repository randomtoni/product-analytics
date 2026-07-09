import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SmokeComponent } from './smoke';

test('mounts a component under jsdom via testing-library', () => {
  render(<SmokeComponent label="mounted" />);
  expect(screen.getByText('mounted')).toBeDefined();
});
