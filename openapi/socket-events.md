# Socket.IO event catalog

## Client → server

| Event | Payload | Description |
|-------|---------|-------------|
| `join` | `string` room | Join `auction:{id}`, `chat:{id}`, `tracking:{id}`, `bidzone:all` |
| `leave` | `string` room | Leave room |

## Server → client

| Event | Room | Payload |
|-------|------|---------|
| `demand.request_created` | `bidzone:all` | `{ id, batchCode, liveEndsAt, itemCount }` |
| `auction.bid_placed` | `auction:{bidRequestId}` | `{ bid, liveEndsAt, extendCount }` |
| `auction.bid_withdrawn` | `auction:{bidRequestId}` | `{ bidId }` |
| `auction.bid_accepted` | `auction:{bidRequestId}` | `{ bidId }` |
| `auction.bid_rejected` | `auction:{bidRequestId}` | `{ bidId }` |
| `order.created` | `auction:{bidRequestId}` | `{ orderId }` |
| `order.status_changed` | `tracking:{orderId}` | `{ orderId, status, paymentStatus?, reason?, at }` |
| `order.updated` | `tracking:{orderId}`, `user:{userId}` | same payload — preference for list + detail quiet reloads |
| `tracking.location_updated` | `tracking:{orderId}` | `{ point, etaMinutes }` |
| `chat.thread_created` | `chat:{threadId}` | `{ threadId, orderId }` |
| `chat.message_created` | `chat:{threadId}` | `{ message }` |
