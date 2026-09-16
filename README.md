# Laff British School — Paystack Backend

This service keeps the Paystack secret key on the server. Paystack handles checkout and transaction verification first; Supabase is used afterward to record successful student payments and publish/fetch receipts.

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
- `SUPABASE_ANON_KEY` — Supabase anon/publishable key, used only for authenticated receipt access
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service-role key for server-side payment/receipt records
- `APP_URL` — the public student portal URL
- `PORT` — Render provides this automatically; the app defaults to `10000`

## Payment flow

1. The portal sends the payment email, amount, and service code to `/payments/initialize`.
2. The backend calls Paystack first and returns the Paystack `access_code` / `authorization_url`.
3. After checkout, `/payments/verify` verifies the reference directly with Paystack first.
4. Only after Paystack confirms a successful NGN transaction does the backend write the `PAID` record to Supabase.
5. The existing Supabase receipt trigger publishes the student payment receipt.
6. `/payments/receipt` can fetch that published receipt for the authenticated student.

## Endpoints

`GET /health` — service health check.

`POST /payments/initialize` — starts a Paystack transaction. It does not require Supabase authentication.

Request example:

```json
{
  "email": "student@example.com",
  "amount": 1000,
  "service_code": "RESULT_ACCESS",
  "title": "Result Access",
  "student_id": "optional-supabase-student-id"
}
```

`POST /payments/verify` — verifies the transaction with Paystack first, then syncs the successful payment into Supabase.

Request example:

```json
{
  "reference": "LBS-RESULT_ACCESS-xxxx",
  "service_code": "RESULT_ACCESS",
  "student_id": "supabase-student-id"
}
```

`POST /payments/receipt` — authenticated endpoint that fetches the published Supabase receipt for the signed-in student and payment reference.

`POST /webhooks/paystack` — verifies Paystack's `x-paystack-signature` and records successful `charge.success` events in Supabase when a matching payment record exists.

Configure the Paystack webhook URL as:

```text
https://paystack-backend-c6hb.onrender.com/webhooks/paystack
```

Never expose `PAYSTACK_SECRET_KEY` in browser JavaScript.