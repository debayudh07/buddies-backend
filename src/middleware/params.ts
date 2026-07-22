import { Request } from 'express';
import { AppError } from '../lib/errors';

/** Path params are `string | undefined` under noUncheckedIndexedAccess / newer Express typings. */
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'MISSING_PARAM', `Missing path param: ${name}`);
  }
  return value;
}
