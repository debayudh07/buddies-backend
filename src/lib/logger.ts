type Level = 'info' | 'warn' | 'error' | 'debug';

function stamp() {
  return new Date().toISOString();
}

function line(level: Level, scope: string, message: string, meta?: Record<string, unknown>) {
  const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const out = `[${stamp()}] [${level}] [${scope}] ${message}${extra}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

export const logger = {
  info: (scope: string, message: string, meta?: Record<string, unknown>) => line('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: Record<string, unknown>) => line('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: Record<string, unknown>) => line('error', scope, message, meta),
  debug: (scope: string, message: string, meta?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== 'production') line('debug', scope, message, meta);
  },
};
