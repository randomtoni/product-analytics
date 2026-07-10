import { describe, expect, it } from 'vitest';
import type { NeutralEvent } from 'analytics-kit';
import { RecordingAdapter } from './recording-adapter';

function event(name: string): NeutralEvent {
  return { event: name, distinctId: 'd', dedupeId: 'u1' };
}

describe('RecordingAdapter write verbs record into inspectable state', () => {
  it('capture records the event', () => {
    const a = new RecordingAdapter();
    a.capture(event('signup_started'));
    expect(a.captures).toHaveLength(1);
    expect(a.captures[0]!.event).toBe('signup_started');
  });

  it('register records props and options', () => {
    const a = new RecordingAdapter();
    a.register({ plan: 'pro' }, { once: true });
    expect(a.registers).toEqual([{ props: { plan: 'pro' }, options: { once: true } }]);
  });

  it('unregister records the key', () => {
    const a = new RecordingAdapter();
    a.unregister('plan');
    expect(a.unregisters).toEqual(['plan']);
  });

  it('group records type, key and traits', () => {
    const a = new RecordingAdapter();
    a.group('workspace', 'ws-1', { name: 'Acme' });
    expect(a.groups).toEqual([{ type: 'workspace', key: 'ws-1', traits: { name: 'Acme' } }]);
  });

  it('alias records inertly (never on the merge path)', () => {
    const a = new RecordingAdapter();
    a.alias('old', 'new');
    expect(a.aliases).toEqual([{ previousId: 'old', distinctId: 'new' }]);
    expect(a.merges).toHaveLength(0);
  });

  it('setConsentState records the state', () => {
    const a = new RecordingAdapter();
    a.setConsentState('denied');
    expect(a.consentStates).toEqual(['denied']);
  });

  it('setPersistedProperty records the key/value pair', () => {
    const a = new RecordingAdapter();
    a.setPersistedProperty('sid', 'session-1');
    expect(a.persistedProperties).toEqual([{ key: 'sid', value: 'session-1' }]);
  });
});

describe('RecordingAdapter benign read/lifecycle verbs mirror NoopAdapter', () => {
  it('getConsentState returns granted (guards the consent-default footgun)', () => {
    expect(new RecordingAdapter().getConsentState()).toBe('granted');
  });

  it('fetch returns a status:0 stub', async () => {
    const res = await new RecordingAdapter().fetch();
    expect(res.status).toBe(0);
    expect(await res.text()).toBe('');
    expect(await res.json()).toEqual({});
  });

  it('getPersistedProperty returns undefined', () => {
    expect(new RecordingAdapter().getPersistedProperty()).toBeUndefined();
  });

  it('getLibraryId / getLibraryVersion return strings', () => {
    const a = new RecordingAdapter();
    expect(typeof a.getLibraryId()).toBe('string');
    expect(typeof a.getLibraryVersion()).toBe('string');
  });

  it('getCustomUserAgent returns undefined', () => {
    expect(new RecordingAdapter().getCustomUserAgent()).toBeUndefined();
  });

  it('flush / shutdown resolve', async () => {
    const a = new RecordingAdapter();
    await expect(a.flush()).resolves.toBeUndefined();
    await expect(a.shutdown()).resolves.toBeUndefined();
  });
});

describe('RecordingAdapter identity state machine (feeds S3)', () => {
  it('starts anonymous with a fresh id', () => {
    const a = new RecordingAdapter();
    expect(a.getDistinctId()).toBeTruthy();
    expect(a.merges).toHaveLength(0);
  });

  it('(1) identify while anonymous merges: retains prior anon id, adopts new id, identifies', () => {
    const a = new RecordingAdapter();
    const anon = a.getDistinctId();

    a.identify('reviewer-42');

    expect(a.getDistinctId()).toBe('reviewer-42');
    expect(a.merges).toEqual([{ anonymousId: anon, identifiedId: 'reviewer-42' }]);
    expect(a.identifies).toHaveLength(1);
  });

  it('(2) identify with the same id is traits-only, no re-merge', () => {
    const a = new RecordingAdapter();
    a.identify('reviewer-42');
    a.identify('reviewer-42', { role: 'admin' });

    expect(a.getDistinctId()).toBe('reviewer-42');
    expect(a.merges).toHaveLength(1);
    expect(a.identifies).toHaveLength(2);
  });

  it('(3) identify with a new id while already identified does NOT merge', () => {
    const a = new RecordingAdapter();
    a.identify('reviewer-42');
    a.identify('reviewer-99');

    expect(a.getDistinctId()).toBe('reviewer-99');
    expect(a.merges).toHaveLength(1);
  });

  it('reset re-anonymizes: fresh anon id, drops the link, back to anonymous', () => {
    const a = new RecordingAdapter();
    a.identify('reviewer-42');
    const identifiedId = a.getDistinctId();

    a.reset();

    const reanon = a.getDistinctId();
    expect(reanon).not.toBe(identifiedId);
    expect(a.resets).toHaveLength(1);

    a.identify('reviewer-77');
    expect(a.merges).toEqual([
      { anonymousId: expect.any(String), identifiedId: 'reviewer-42' },
      { anonymousId: reanon, identifiedId: 'reviewer-77' },
    ]);
  });
});
