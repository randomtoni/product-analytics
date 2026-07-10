export function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

export function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}
