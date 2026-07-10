// UUIDv7 (RFC 9562): a 48-bit millisecond timestamp prefix + a monotonic counter
// + cryptographically-strong random bits, so ids sort by creation time.
// Ported from the LiosK reference implementation (Apache-2.0) and de-branded;
// distinct from a purely-random v4 (crypto.randomUUID), which has no time prefix.

const MAX_COUNTER = 0x3ff_ffff_ffff;
const ROLLBACK_ALLOWANCE_MS = 10_000;

function fillRandomUint32(buffer: Uint32Array): Uint32Array {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(buffer);
  }
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = Math.trunc(Math.random() * 0x1_0000) * 0x1_0000 + Math.trunc(Math.random() * 0x1_0000);
  }
  return buffer;
}

class BufferedRandom {
  private readonly buffer = new Uint32Array(8);
  private cursor = Infinity;

  nextUint32(): number {
    if (this.cursor >= this.buffer.length) {
      fillRandomUint32(this.buffer);
      this.cursor = 0;
    }
    return this.buffer[this.cursor++];
  }
}

function bytesToString(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i++) {
    text += (bytes[i] >>> 4).toString(16) + (bytes[i] & 0xf).toString(16);
    if (i === 3 || i === 5 || i === 7 || i === 9) {
      text += '-';
    }
  }
  return text;
}

function buildBytes(unixTsMs: number, randA: number, randBHi: number, randBLo: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes[0] = unixTsMs / 2 ** 40;
  bytes[1] = unixTsMs / 2 ** 32;
  bytes[2] = unixTsMs / 2 ** 24;
  bytes[3] = unixTsMs / 2 ** 16;
  bytes[4] = unixTsMs / 2 ** 8;
  bytes[5] = unixTsMs;
  bytes[6] = 0x70 | (randA >>> 8);
  bytes[7] = randA;
  bytes[8] = 0x80 | (randBHi >>> 24);
  bytes[9] = randBHi >>> 16;
  bytes[10] = randBHi >>> 8;
  bytes[11] = randBHi;
  bytes[12] = randBLo >>> 24;
  bytes[13] = randBLo >>> 16;
  bytes[14] = randBLo >>> 8;
  bytes[15] = randBLo;
  return bytes;
}

class UuidV7Generator {
  private timestamp = 0;
  private counter = 0;
  private readonly random = new BufferedRandom();

  next(): string {
    const value = this.generateOrAbort();
    if (value !== undefined) {
      return value;
    }
    this.timestamp = 0;
    const afterReset = this.generateOrAbort();
    if (afterReset === undefined) {
      throw new Error('could not generate a UUIDv7 after timestamp reset');
    }
    return afterReset;
  }

  private generateOrAbort(): string | undefined {
    const ts = Date.now();
    if (ts > this.timestamp) {
      this.timestamp = ts;
      this.resetCounter();
    } else if (ts + ROLLBACK_ALLOWANCE_MS > this.timestamp) {
      this.counter++;
      if (this.counter > MAX_COUNTER) {
        this.timestamp++;
        this.resetCounter();
      }
    } else {
      return undefined;
    }

    const bytes = buildBytes(
      this.timestamp,
      Math.trunc(this.counter / 2 ** 30),
      this.counter & (2 ** 30 - 1),
      this.random.nextUint32()
    );
    return bytesToString(bytes);
  }

  private resetCounter(): void {
    this.counter = this.random.nextUint32() * 0x400 + (this.random.nextUint32() & 0x3ff);
  }
}

let defaultGenerator: UuidV7Generator | undefined;

export function generateUuidV7(): string {
  defaultGenerator ??= new UuidV7Generator();
  return defaultGenerator.next();
}
