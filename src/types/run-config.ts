import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const intervalEnum = z.enum(['1minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day']);
const brokerageEnum = z.enum(['zerodha-intraday', 'zerodha-delivery', 'zero']);
const sourceEnum = z.enum(['kite', 'yahoo']);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const hhmmStr = z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:mm');

export const RunConfigSchema = z
  .object({
    strategy: z.string().min(1),
    params: z.record(z.unknown()),
    symbols: z.array(z.string().min(1)).min(1, 'at least one symbol required'),
    from: dateStr,
    to: dateStr,
    interval: intervalEnum,
    capital: z.number().positive(),
    slippage_bps: z.number().min(0).max(1000),
    brokerage: brokerageEnum,
    source: sourceEnum.default('kite'),
    warmup_bars: z.number().int().min(0).default(200),
    squareoff_time: z.union([hhmmStr, z.null()]).default('15:15'),
    seed: z.number().int().nonnegative(),
  })
  .refine((cfg) => cfg.from <= cfg.to, { message: 'from must be <= to', path: ['from'] });

export type RunConfig = z.infer<typeof RunConfigSchema>;

export function loadRunConfig(path: string): RunConfig {
  const text = readFileSync(path, 'utf8');
  const raw = parseYaml(text) as unknown;
  return RunConfigSchema.parse(raw);
}
