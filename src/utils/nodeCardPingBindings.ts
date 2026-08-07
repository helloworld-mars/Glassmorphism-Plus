export type NodeCardPingTaskBindings = Readonly<Record<string, number>>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isNodeCardPingBindingUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isNodeCardPingTaskId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function normalizeNodeCardPingTaskBindings(value: unknown): NodeCardPingTaskBindings {
  let rawValue = value
  if (typeof rawValue === 'string') {
    try {
      rawValue = JSON.parse(rawValue) as unknown
    }
    catch {
      return {}
    }
  }

  if (!isPlainRecord(rawValue))
    return {}

  const normalized: Record<string, number> = {}
  for (const [uuid, taskId] of Object.entries(rawValue)) {
    if (isNodeCardPingBindingUuid(uuid) && isNodeCardPingTaskId(taskId))
      normalized[uuid.toLowerCase()] = taskId
  }

  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)))
}

export function parseNodeCardPingTaskBindings(value: unknown): NodeCardPingTaskBindings {
  return typeof value === 'string' ? normalizeNodeCardPingTaskBindings(value) : {}
}

export function serializeNodeCardPingTaskBindings(value: unknown): string {
  return JSON.stringify(normalizeNodeCardPingTaskBindings(value))
}

export function getNodeCardPingTaskId(bindings: NodeCardPingTaskBindings, nodeUuid: string): number | undefined {
  return bindings[nodeUuid.toLowerCase()]
}
