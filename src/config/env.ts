import { z } from 'zod';

export const EnvSchema = z.object({
  KITE_API_KEY: z.string().min(1),
  KITE_API_SECRET: z.string().min(1),
  KITE_ACCESS_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(
  raw: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Env {
  return EnvSchema.parse(raw);
}
