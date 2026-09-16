# Laff British School — Paystack Backend

This service keeps the Paystack secret key on the server and exposes a small API for the student portal.

## Render setup

Create a Render **Web Service** from this repository.

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Add these environment variables in Render. Do **not** commit the real values to GitHub:

- `PAYSTACK_SECRET_KEY` — your Paystack secret key
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anon/publishable key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key
- `APP_URL` — the public student portal URL
- `PORT` — Render provides this automatically; the app defaults to `10000`

## Endpoints

`GET /health` — service health check.

`POST /payments/initialize` — authenticates the student with Supabase, validates the configured service amount, initializes a Paystack transaction, and stores a pending payment in Supabase.

`POST /payments/verify` — verifies a transaction against Paystack and marks the Supabase payment `PAID` only when Paystack confirms success and the amount/currency are correct.

`POST /webhooks/paystack` — verifies Paystack's `x-paystack-signature` and records successful `charge.success` events in Supabase.

The webhook is the server-to-server payment confirmation path. Configure the Paystack webhook URL as:

```text
https://YOUR-RENDER-SERVICE.onrender.com/webhooks/paystack
```

Use the Render service URL in your student portal's payment configuration. Never expose `PAYSTACK_SECRET_KEY` in browser JavaScript.
