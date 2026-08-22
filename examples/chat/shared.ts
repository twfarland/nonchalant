// The isomorphic module: one room process, one typed schema. The server hosts
// it; every tab looks it up by name. The process is just a reducer over a
// mailbox — it has no idea it's a chat server.

import type { Definition, Proc } from '@nonchalant/core'

export type ChatLine = { id: number; from: string; text: string }
export type RoomState = { lines: ChatLine[] }
export type RoomMsg = { type: 'post'; from: string; text: string }

export const room: Proc<RoomState, RoomMsg, { name: string }> = async function* (self) {
  let lines: ChatLine[] = []
  let nextId = 1
  yield { lines }
  for await (const msg of self) {
    const text = msg.text.trim().slice(0, 400)
    if (text === '') continue
    lines = [...lines.slice(-49), { id: nextId++, from: msg.from.slice(0, 24), text }]
    yield { lines }
  }
}

export type ChatSchema = { room: Definition<RoomState, RoomMsg, { name: string }> }
