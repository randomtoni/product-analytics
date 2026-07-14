import { expect, test, vi } from 'vitest';
import type { Receiver } from './receiver';
import { translate, STATUS_ACCEPTED, STATUS_MALFORMED_BODY, STATUS_WRITE_FAILED } from './translate';

const BODY = Buffer.from('{}', 'utf8');
const HEADERS = { 'content-type': 'application/json' };

test('accepted → 2xx', async () => {
  const receiver: Receiver = { receive: () => Promise.resolve({ outcome: 'accepted', accepted: 3 }) };
  expect(await translate(receiver, BODY, HEADERS)).toEqual({ status: STATUS_ACCEPTED });
});

test('malformed_body → 4xx', async () => {
  const receiver: Receiver = { receive: () => Promise.resolve({ outcome: 'malformed_body' }) };
  expect(await translate(receiver, BODY, HEADERS)).toEqual({ status: STATUS_MALFORMED_BODY });
});

test('a thrown receive (DB write failure) → neutral 5xx, exception swallowed', async () => {
  const driverError = new Error('FATAL: password authentication failed for user "app"');
  const receiver: Receiver = { receive: () => Promise.reject(driverError) };

  const result = await translate(receiver, BODY, HEADERS);

  // The neutral status carries no driver detail — only the code.
  expect(result).toEqual({ status: STATUS_WRITE_FAILED });
  expect(JSON.stringify(result)).not.toContain('password');
});

test('passes the raw body + headers straight through to the core (no mutation)', async () => {
  const receive = vi.fn().mockResolvedValue({ outcome: 'accepted', accepted: 0 });
  await translate({ receive }, BODY, HEADERS);
  expect(receive).toHaveBeenCalledWith(BODY, HEADERS);
});
