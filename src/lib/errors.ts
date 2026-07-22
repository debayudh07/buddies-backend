export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function assertFound<T>(value: T | null | undefined, code = 'NOT_FOUND', message = 'Not found'): T {
  if (value == null) throw new AppError(404, code, message);
  return value;
}
