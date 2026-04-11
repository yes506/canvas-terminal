let nextId = 1;

export function generateSessionId() {
  return `session-${nextId++}-${Date.now()}`;
}
