import { describe, expect, it } from 'vitest';

import { assertNever } from './assert-never.ts';

describe('assertNever', () => {
  it('throws with the unexpected value in the message', () => {
    expect(() => assertNever('surprise' as never)).toThrow('Unexpected value: "surprise"');
  });
});
