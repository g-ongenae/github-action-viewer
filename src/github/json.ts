// Reading untrusted JSON from GitHub: only the fields the client uses are checked. A required field
// that is missing or of the wrong type throws a PayloadShapeError naming its path; optional fields
// read as null (or an empty list) when missing, null or of an unexpected type.

/** A field the client needs is missing or has the wrong type. */
export class PayloadShapeError extends Error {
  constructor(path: string, expected: string, found: unknown) {
    super(`expected ${expected} at ${path}, got ${describe(found)}`);
    this.name = 'PayloadShapeError';
  }
}

/** Reads the fields of one JSON object. */
export class ObjectReader {
  readonly path: string;
  readonly #value: Readonly<Record<string, unknown>>;

  constructor(value: unknown, path: string) {
    if (!isObject(value)) {
      throw new PayloadShapeError(path, 'an object', value);
    }
    this.#value = value;
    this.path = path;
  }

  string(key: string): string {
    const value = this.#value[key];
    if (typeof value !== 'string') {
      throw new PayloadShapeError(this.#at(key), 'a string', value);
    }
    return value;
  }

  optionalString(key: string): string | null {
    const value = this.#value[key];
    return typeof value === 'string' ? value : null;
  }

  integer(key: string): number {
    const value = this.#value[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new PayloadShapeError(this.#at(key), 'an integer', value);
    }
    return value;
  }

  optionalInteger(key: string): number | null {
    const value = this.#value[key];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  }

  optionalBoolean(key: string): boolean | null {
    const value = this.#value[key];
    return typeof value === 'boolean' ? value : null;
  }

  object(key: string): ObjectReader {
    return new ObjectReader(this.#value[key], this.#at(key));
  }

  optionalObject(key: string): ObjectReader | null {
    const value = this.#value[key];
    return isObject(value) ? new ObjectReader(value, this.#at(key)) : null;
  }

  /** A required list of objects. */
  objects(key: string): ObjectReader[] {
    const value = this.#value[key];
    if (!Array.isArray(value)) {
      throw new PayloadShapeError(this.#at(key), 'a list', value);
    }
    return readObjects(value, this.#at(key));
  }

  /** An optional list of objects: missing or null reads as empty, non-object items are skipped. */
  optionalObjects(key: string): ObjectReader[] {
    const value = this.#value[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((item: unknown, index) =>
      isObject(item) ? [new ObjectReader(item, `${this.#at(key)}[${String(index)}]`)] : [],
    );
  }

  #at(key: string): string {
    return `${this.path}.${key}`;
  }
}

/** Reads a response body that must be a list of objects. */
export function readObjects(value: unknown, path = '$'): ObjectReader[] {
  if (!Array.isArray(value)) {
    throw new PayloadShapeError(path, 'a list', value);
  }
  return value.map((item: unknown, index) => new ObjectReader(item, `${path}[${String(index)}]`));
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) {
    return 'nothing';
  }
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'a list' : typeof value;
}
