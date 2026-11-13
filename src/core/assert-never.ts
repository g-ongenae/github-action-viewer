/**
 * Marks a code path that the type checker proves unreachable, typically the `default` branch of
 * an exhaustive `switch`. Throws if it is ever reached at runtime anyway.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
