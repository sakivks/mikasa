import { describe, it, expect } from 'vitest';
import { createLogger, makeRunId } from './logger';

describe('logger', () => {
  it('createLogger returns a pino logger with bound runId', () => {
    const log = createLogger({ runId: 'test-run', level: 'info' });
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect((log.bindings() as { runId?: string }).runId).toBe('test-run');
  });

  it('makeRunId formats as YYYYMMDD-HHMMSS-<tag>', () => {
    const id = makeRunId('SmaCrossover', new Date('2025-04-30T07:08:09Z'));
    expect(id).toMatch(/^\d{8}-\d{6}-SmaCrossover$/);
  });
});
