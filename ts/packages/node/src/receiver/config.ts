// The receiver's own config surface — the WRITE-side twin of the query `QueryClientConfig`. It
// carries the SAME `warehouseDsn` field SHAPE as the query config (C symmetry), so self-host reads
// as one coherent "here's my Neon" across read (query) and write (receiver). A credential-shaped
// value: read at the `createReceiverFromConfig` factory boundary, never stored on the receiver core
// or a mount. Its PRESENCE selects the DSN-built receiver; there is no `backend:` enum.
export interface ReceiverConfig {
  warehouseDsn?: string;
}
