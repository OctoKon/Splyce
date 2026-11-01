// Test helper: rune-backed props so a mounted component can be updated in place.
export function reactiveProps<T extends object>(initial: T): T {
  const p = $state(initial);
  return p;
}
