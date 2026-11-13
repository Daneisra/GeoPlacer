/**
 * Log redaction through a real winston pipeline (in-memory transport)
 */

import winston from 'winston';
import Transport from 'winston-transport';
import { redactSecretsFormat } from '../utils/log-redaction.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

class MemoryTransport extends Transport {
  lines: string[] = [];
  log(info: Record<symbol, unknown>, callback: () => void): void {
    this.lines.push(String(info[Symbol.for('message')]));
    callback();
  }
}

function makeLogger() {
  const memory = new MemoryTransport();
  const logger = winston.createLogger({
    level: 'info',
    // Same chain as utils/logger.ts
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      redactSecretsFormat(),
      winston.format.json()
    ),
    transports: [memory],
  });
  return { logger, memory };
}

describe('redactSecretsFormat', () => {
  it('masks secrets in messages', () => {
    const { logger, memory } = makeLogger();
    logger.info(`login with j=${JWT}; done`);
    expect(memory.lines[0]).not.toContain(JWT);
    expect(memory.lines[0]).toContain('[REDACTED]');
  });

  it('masks secret metadata keys and nested objects', () => {
    const { logger, memory } = makeLogger();
    logger.info('user added', { cookies: { j: 'abc123' }, user: { name: 'bob', token: 'tok' } });
    const entry = JSON.parse(memory.lines[0]);
    expect(entry.cookies).toBe('[REDACTED]');
    expect(entry.user).toEqual({ name: 'bob', token: '[REDACTED]' });
  });

  it('masks secrets in error messages and stacks', () => {
    const { logger, memory } = makeLogger();
    logger.error('request failed', new Error(`Cookie: j=${JWT}`));
    expect(memory.lines[0]).not.toContain(JWT);
    expect(memory.lines[0]).toContain('level');
  });

  it('keeps ordinary entries intact', () => {
    const { logger, memory } = makeLogger();
    logger.info('Painted 30 px at 12,34.');
    expect(JSON.parse(memory.lines[0]).message).toBe('Painted 30 px at 12,34.');
  });
});
