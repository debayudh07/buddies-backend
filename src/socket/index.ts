import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

let io: Server | null = null;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    socket.on('join', (room: string) => {
      if (typeof room === 'string' && room.length < 200) socket.join(room);
    });
    socket.on('leave', (room: string) => {
      if (typeof room === 'string') socket.leave(room);
    });
  });

  return io;
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export function emitAuction(bidRequestId: string, event: string, payload: unknown) {
  getIo().to(`auction:${bidRequestId}`).emit(event, payload);
}

export function emitChat(threadId: string, event: string, payload: unknown) {
  getIo().to(`chat:${threadId}`).emit(event, payload);
}

export function emitTracking(orderId: string, event: string, payload: unknown) {
  getIo().to(`tracking:${orderId}`).emit(event, payload);
}

export function emitBidzone(geoKey: string, event: string, payload: unknown) {
  getIo().to(`bidzone:${geoKey}`).emit(event, payload);
}
