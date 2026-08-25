# ezaff owner-link Worker

Cloudflare Worker backend for FR-10: returns the **author's** affiliate link for a product so the desktop app can use it on ~5% of post-trial copies.

## Invariants

1. **No user affiliate links** — the request body never contains them. Only `platform`, `shopId`, `itemId`, `installId`.
2. **No Shopee secrets in the desktop app** — credentials live only here (env / secrets).
3. **Never log the request body** beyond fields required for rate limiting / lookup keys.
4. **Always safe for the client** — returning `ownerUrl: null` is fine; the app falls back to the user's link.

## Endpoint

```
POST /v1/owner-link
Content-Type: application/json

{
  "platform": "shopee",
  "itemId": "123",
  "shopId": "456",
  "installId": "uuid"
}

→ { "ownerUrl": "https://…" | null, "source": "cache" | "shopee_open_api" | "mapping_table" | "passthrough" | "rate_limited" }
```

## Provider chain (first non-null wins)

1. **shopeeOpenApiProvider** — Shopee Affiliate Open API `generateShortLink` GraphQL.  
   **Disabled** unless both `SHOPEE_APP_ID` and `SHOPEE_SECRET` are set.
2. **mappingTableProvider** — KV key `owner:{platform}:{shopId}:{itemId}` (seeded manually by the app author).
3. **passthroughProvider** — returns `null`.

Successful lookups are cached in KV for **30 days**. Rate limit: **60 requests / minute / installId**.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SHOPEE_APP_ID` | For Open API only | Shopee Affiliate app id |
| `SHOPEE_SECRET` | For Open API only | Shopee Affiliate secret |
| `OWNER_KV` | Yes (binding) | KV namespace for mapping + cache + rate limits |

Local secrets: copy `.dev.vars.example` → `.dev.vars` and fill values.

Production secrets:

```bash
npx wrangler secret put SHOPEE_APP_ID
npx wrangler secret put SHOPEE_SECRET
```

## Seed a mapping entry

```bash
npx wrangler kv key put --binding=OWNER_KV "owner:shopee:SHOP_ID:ITEM_ID" "https://s.shopee.vn/your-aff-code"
```

## Scripts

```bash
npm install
npm run dev      # wrangler dev → http://127.0.0.1:8787
npm test
npm run typecheck
npm run deploy
```

## Privacy

The worker must not store product lists, user affiliate URLs, or personal data. Only opaque install ids and product identifiers needed for lookup.
