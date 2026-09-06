import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { config } from '../config';
import { resolveAuthFromHeader } from '../middleware/auth';
import { logger } from '../lib/logger';

let io: Server | null = null;

/**
 * Optional Socket.IO hub. Live events are published via Supabase Broadcast.
 * Handshake still requires JWT if a legacy client connects.
 */
export function initSocket(httpServer: HttpServer): Server {
  const origin = '*';

  io = new Server(httpServer, {
    cors: { origin, methods: ['GET', 'POST'] },
  });

  io.use(async (socket, next) => {
    try {
      const authHeader =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization as string | undefined) ??
        '';
      const header = authHeader.startsWith('Bearer ')
        ? authHeader
        : authHeader
          ? `Bearer ${authHeader}`
          : '';
      if (!header) {
        return next(new Error('UNAUTHORIZED'));
      }
      const user = await resolveAuthFromHeader(header);
      if (!user) {
        return next(new Error('UNAUTHORIZED'));
      }
      (socket.data as { userId: string; role: string }).userId = user.id;
      (socket.data as { userId: string; role: string }).role = user.role;
      next();
    } catch (e) {
      logger.warn('socket', 'auth failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket.data as { userId?: string }).userId;

    socket.on('join', (room: string) => {
      if (typeof room !== 'string' || room.length >= 200) return;
      if (!canJoinRoom(userId, room)) {
        socket.emit('error', { code: 'ROOM_FORBIDDEN', room });
        return;
      }
      socket.join(room);
    });
    socket.on('leave', (room: string) => {
      if (typeof room === 'string') socket.leave(room);
    });
  });

  return io;
}

function canJoinRoom(userId: string | undefined, room: string): boolean {
  if (!userId) return false;
  // user:{id} — self only
  if (room.startsWith('user:')) {
    return room === `user:${userId}`;
  }
  // Global bidzone is open to any authenticated supplier (room membership tightened later)
  if (room.startsWith('bidzone:')) return true;
  // auction / tracking / chat — authenticated; Express owns row ACL on HTTP.
  // Path identity alone is not enough; we still require a logged-in user.
  if (
    room.startsWith('auction:') ||
    room.startsWith('tracking:') ||
    room.startsWith('chat:') ||
    room.startsWith('return:')
  ) {
    return true;
  }
  return false;
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

// Re-export broadcast helpers.
export {
  emitAuction,
  emitChat,
  emitTracking,
  emitBidzone,
  emitUser,
  emitReturn,
} from '../lib/realtime';
