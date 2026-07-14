// The receiver package — the WRITE side of self-host. The framework-agnostic core lives here
// (S1); the S2/S4 framework mounts and the S3 from-config factory join it as thin edges of this
// same package, mirroring how `query/` holds both the seam and the default driver.
export { createReceiver } from './receiver';
export type { Receiver, ReceiverHeaders, ReceiveOutcome } from './receiver';
