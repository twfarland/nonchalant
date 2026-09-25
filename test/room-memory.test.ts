// The chat example claims one Node process holds thousands of rooms because a
// suspended room is kilobytes. This measures it: spawn N registry rooms, let
// each reach its mailbox, and divide the retained heap by N.

import { describe, expect, it } from 'vitest'
import { define, registry } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import { room, type RoomMsg, type RoomState } from '../examples/chat/shared.ts'

const ROOMS = 5_000
// measured ~6.7 KB per idle room on Node 22.12 (V8 heap after gc: the
// generator, its mailbox and signal, the graph source, the registry entry)
const BUDGET_BYTES_PER_ROOM = 8_192

const gc = (globalThis as { gc?: (opts?: { execution: 'async' }) => Promise<void> | void }).gc

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  await gc?.({ execution: 'async' })
}

describe('memory per suspended process', () => {
  it(`an idle chat room retains ≤ ${BUDGET_BYTES_PER_ROOM} bytes of heap`, async () => {
    expect(gc).toBeDefined() // vitest.config.ts passes --expose-gc
    const chat = registry({ room: define(room) })
    await settle()
    const before = process.memoryUsage().heapUsed

    const rooms: Process<RoomState | undefined, RoomMsg>[] = []
    for (let i = 0; i < ROOMS; i++) rooms.push(chat.lookup('room', { name: `room-${i}` }))
    await settle()
    const after = process.memoryUsage().heapUsed

    expect(rooms.every((r) => r()?.lines.length === 0)).toBe(true)
    const perRoom = (after - before) / ROOMS
    console.log(`idle chat room: ${Math.round(perRoom)} bytes of heap each (${ROOMS} rooms)`)
    expect(perRoom).toBeLessThanOrEqual(BUDGET_BYTES_PER_ROOM)

    for (const r of rooms) r[Symbol.dispose]()
  })
})
