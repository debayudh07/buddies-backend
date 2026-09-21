import { Router } from 'express';
import { z } from 'zod';
import { authenticate, blockHandoff, requireRole } from '../../middleware/auth';
import { AppError } from '../../lib/errors';
import { buildLedger, type LedgerKind } from './service';

export const ledgerRouter = Router();

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  kind: z.enum(['all', 'delivery', 'payment', 'return']).optional(),
  counterpartyId: z.string().uuid().optional(),
});

ledgerRouter.get(
  '/ledger',
  authenticate,
  blockHandoff,
  requireRole('supplier', 'consumer'),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_QUERY', 'Bad ledger query');
    }
    const role = req.user!.role;
    if (role !== 'supplier' && role !== 'consumer') {
      throw new AppError(403, 'FORBIDDEN', 'Ledger is for shops and restaurants');
    }

    const book = await buildLedger({
      userId: req.user!.id,
      role,
      from: parsed.data.from,
      to: parsed.data.to,
      kind: (parsed.data.kind as LedgerKind | undefined) ?? 'all',
      counterpartyId: parsed.data.counterpartyId,
    });

    res.json(book);
  },
);
