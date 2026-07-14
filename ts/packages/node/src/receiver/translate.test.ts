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

test('a thrown receive is logged server-side (operator sees the cause) — but stays out of the return', async () => {
  const driverError = new Error('FATAL: password authentication failed for user "app"');
  const receiver: Receiver = { receive: () => Promise.reject(driverError) };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const result = await translate(receiver, BODY, HEADERS);

    // The swallowed exception IS surfaced to an operator — the message + the raw error object.
    expect(errorSpy).toHaveBeenCalledOnce();
    const [message, loggedErr] = errorSpy.mock.calls[0];
    expect(message).toContain('write failed');
    expect(loggedErr).toBe(driverError);
    // …yet the client-facing return carries only the status, never the driver detail.
    expect(result).toEqual({ status: STATUS_WRITE_FAILED });
    expect(JSON.stringify(result)).not.toContain('password');
  } finally {
    errorSpy.mockRestore();
  }
});

test('a non-throwing receive logs nothing (the log is a write-failure path only)', async () => {
  const receiver: Receiver = { receive: () => Promise.resolve({ outcome: 'accepted', accepted: 1 }) };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await translate(receiver, BODY, HEADERS);
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test('passes the raw body + headers straight through to the core (no mutation)', async () => {
  const receive = vi.fn().mockResolvedValue({ outcome: 'accepted', accepted: 0 });
  await translate({ receive }, BODY, HEADERS);
  expect(receive).toHaveBeenCalledWith(BODY, HEADERS);
});
