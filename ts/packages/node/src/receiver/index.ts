// The receiver package — the WRITE side of self-host. The framework-agnostic core lives here
// (S1); the S2/S4 framework mounts and the S3 from-config factory join it as thin edges of this
// same package, mirroring how `query/` holds both the seam and the default driver.
export { createReceiver } from './receiver';
export type { Receiver, ReceiverHeaders, ReceiveOutcome } from './receiver';

// The S4 framework mounts — thin wrappers over the S1 core, each reading the RAW body + headers and
// translating the neutral outcome to its framework's response. All typed PURELY STRUCTURALLY (no
// framework import, no optional peer-dep), so this module — and the node package — imports clean
// with no web framework installed.
export { createReceiverHandler } from './plain-handler';
export { createExpressReceiver } from './express-mount';
export type { ExpressRequestLike, ExpressResponseLike } from './express-mount';
export { createNextRouteReceiver, createNextApiReceiver } from './next-mount';
export type { AppRouterRequestLike } from './next-mount';
