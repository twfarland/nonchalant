// Registry cache keys: a structural, type-tagged serialisation of lookup
// arguments. Plain data (primitives, arrays, plain records) encodes by
// structure, keys sorted; everything else encodes by identity, with ids stable
// for the life of one encoder.

/** A fresh encoder with its own identity table: `(args) => key`. Equal plain
 * data gives equal keys; distinct non-plain values give distinct ones. */
export function keyEncoder(): (args: unknown) => string {
  const objectIds = new WeakMap<object, number>()
  const symbolIds = new Map<symbol, number>()
  let nextIdentity = 0

  const objectIdentity = (value: object): number => {
    let id = objectIds.get(value)
    if (id === undefined) {
      id = ++nextIdentity
      objectIds.set(value, id)
    }
    return id
  }

  const encodeArg = (value: unknown, ancestors: Set<object>): string => {
    if (value === null) return 'null'
    switch (typeof value) {
      case 'undefined':
      case 'boolean': return String(value)
      case 'string': return `string:${JSON.stringify(value)}`
      // String() spells NaN and ±Infinity; only -0 needs its own token
      case 'number': return Object.is(value, -0) ? 'number:-0' : `number:${value}`
      case 'bigint': return `bigint:${value}`
      case 'symbol': {
        let id = symbolIds.get(value)
        if (id === undefined) {
          id = ++nextIdentity
          symbolIds.set(value, id)
        }
        return `symbol:${id}`
      }
      case 'function': return `function:${objectIdentity(value)}`
      case 'object': break
    }

    const object = value as object
    if (ancestors.has(object)) return `cycle:${objectIdentity(object)}`
    const proto = Object.getPrototypeOf(object)
    const plain = proto === Object.prototype || proto === null
    if (!Array.isArray(object) && (!plain || Object.getOwnPropertySymbols(object).length > 0))
      return `object:${objectIdentity(object)}`

    ancestors.add(object)
    try {
      if (Array.isArray(object)) {
        const values: string[] = []
        for (let i = 0; i < object.length; i++)
          values.push(Object.hasOwn(object, i) ? encodeArg(object[i], ancestors) : 'hole')
        return `array:[${values.join(',')}]`
      }
      const record = object as Record<string, unknown>
      return `record:{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${encodeArg(record[key], ancestors)}`).join(',')}}`
    } finally {
      ancestors.delete(object)
    }
  }

  return (args) => encodeArg(args, new Set())
}
