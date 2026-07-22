import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { AppError } from '../lib/errors';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid body', parsed.error.flatten()));
    }
    req.body = parsed.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten()));
    }
    (req as Request & { validatedQuery: T }).validatedQuery = parsed.data;
    next();
  };
}
