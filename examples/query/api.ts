// A fake server with latency, so the demo is self-contained. Swap these for
// real fetches (the signal is already threaded through for you).

export type User = { id: number; name: string; role: string }

const db = new Map<number, User>([
  [1, { id: 1, name: 'Ada', role: 'engineering' }],
  [2, { id: 2, name: 'Grace', role: 'engineering' }],
  [3, { id: 3, name: 'Marge', role: 'operations' }],
])

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const listUsers = async (): Promise<{ id: number; name: string }[]> => {
  await delay(400)
  return [...db.values()].map(({ id, name }) => ({ id, name }))
}

export const getUser = async (id: number): Promise<User> => {
  await delay(400)
  const user = db.get(id)
  if (user === undefined) throw new Error(`no user ${id}`)
  return user
}

export const renameUser = async (id: number, name: string): Promise<User> => {
  await delay(500)
  if (name.trim() === '') throw new Error('a name is required')
  const user = db.get(id)
  if (user === undefined) throw new Error(`no user ${id}`)
  const renamed = { ...user, name: name.trim() }
  db.set(id, renamed)
  return renamed
}
