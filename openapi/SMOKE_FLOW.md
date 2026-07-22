# Dual-sided API smoke flow (dev auth)

Replace UUIDs as needed. Requires Supabase Postgres (`npm run db:setup`), optional cloud `REDIS_URL`, and `npm run dev`.

```bash
export C=dev:consumer:11111111-1111-4111-8111-111111111111
export S=dev:supplier:22222222-2222-4222-8222-222222222222
export A=dev:admin:33333333-3333-4333-8333-333333333333
export H="http://localhost:8000/v1"
```

1. Consumer profile + subscription  
2. Supplier KYC → `POST /supplier/kyc/dev-verify`  
3. Supplier subscription  
4. Consumer `POST /consumer/bid-requests`  
5. Supplier `GET /supplier/bidzone` → `POST /supplier/bids`  
6. Consumer `POST /consumer/bids/:id/accept`  
7. Both `POST /bids/:id/acknowledge`  
8. Supplier status → tracking points → arrived  
9. Consumer sign challan → invoice → payment start/mark-paid  
10. Supplier payment confirm  
11. Optional return claim + support article list  

Socket rooms: `auction:{bidRequestId}`, `tracking:{orderId}`, `chat:{threadId}`.
