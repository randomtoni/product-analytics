// The single source of the library version stamped on the wire (the [WIRE] `ver=`
// compression query param). Both the capture path (browser-adapter.ts) and the replay
// delivery path (replay-transport.ts) feed this into appendCompressedQueryParams, so it
// lives here ONCE — bumping it in one place keeps both POST paths' `ver=` in lockstep.
// Base-safe: a bare string constant, no transport/rrweb dependency.
export const LIBRARY_VERSION = '0.0.0';
