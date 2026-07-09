// Deep-scans a mapped shape for the legacy random property the de-branded mapper must never emit.
export function containsInsertId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsInsertId);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, v]) => key === '$insert_id' || key === 'insert_id' || containsInsertId(v)
    );
  }
  return false;
}
