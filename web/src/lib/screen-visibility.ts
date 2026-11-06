export function isScreenVisible<T extends string>(current: T, target: T): boolean {
  return current === target;
}
