import { expect, test } from 'vitest';

// The mount modules are typed PURELY STRUCTURALLY — they import NO web framework value, so the
// receiver package (and the node package) imports clean with no Express / Next / any framework
// installed. `express` and `next` are ABSENT from this workspace's dependency graph, so a successful
// dynamic import here is the concrete proof: if any mount had a top-level `import 'express'` /
// `import 'next'` (or a hard peer import), the resolve would throw here.

test('the receiver package imports with no Express / Next installed', async () => {
  const mod = await import('./index');
  expect(typeof mod.createReceiver).toBe('function');
  expect(typeof mod.createReceiverFromConfig).toBe('function');
  expect(typeof mod.createReceiverHandler).toBe('function');
  expect(typeof mod.createExpressReceiver).toBe('function');
  expect(typeof mod.createNextRouteReceiver).toBe('function');
  expect(typeof mod.createNextApiReceiver).toBe('function');
});

test('the from-config factory imports clean with no `warehouse` (pg) peer installed', async () => {
  // The real `createDefaultDbExecute` defers the optional `pg` peer load to first exec, so both
  // this factory module and the receiver package import (and the factory constructs) with no
  // `warehouse` peer present. `pg` is ABSENT from this workspace's dependency graph — a top-level
  // `import 'pg'` in the factory chain would throw on this dynamic import.
  const mod = await import('./create-receiver-from-config');
  expect(typeof mod.createReceiverFromConfig).toBe('function');
});

test('the node package entry imports the mounts with no framework installed', async () => {
  const mod = await import('../index');
  expect(typeof mod.createReceiverHandler).toBe('function');
  expect(typeof mod.createExpressReceiver).toBe('function');
  expect(typeof mod.createNextRouteReceiver).toBe('function');
  expect(typeof mod.createNextApiReceiver).toBe('function');
});

test('no framework is resolvable from this workspace (the negative that makes the above meaningful)', async () => {
  // Non-literal specifiers so `tsc` does not try to statically resolve (and fail on) an
  // intentionally-absent module — the point is that they are NOT installed, proved at runtime.
  const dynamicImport = (spec: string): Promise<unknown> => import(/* @vite-ignore */ spec);
  await expect(dynamicImport('express')).rejects.toThrow();
  await expect(dynamicImport('next/server')).rejects.toThrow();
});
