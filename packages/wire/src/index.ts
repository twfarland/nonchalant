// @nonchalant/wire — protocol rev 2 (docs/PROTOCOL.md): eight ops carrying
// state patches of plain data, never markup, never code. Isomorphic, DOM-free.
// The conformance vectors under spec/vectors/ are the cross-language contract.

export { encode, decodeClient, decodeHost } from './protocol.ts'
export type { ClientMsg, HostMsg } from './protocol.ts'
export { memoryPair } from './transport.ts'
export type { Transport, TransportHandlers, MemoryLink } from './transport.ts'
export { expose } from './host.ts'
export type { Exposable } from './host.ts'
export { connect, WireError } from './client.ts'
export type { Connection } from './client.ts'
export { webSocketTransport, broadcastChannelTransport } from './transports.ts'
export type { WebSocketTransportOpts } from './transports.ts'
