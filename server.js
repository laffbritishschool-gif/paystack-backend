import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();

const PORT = Number(process.env.PORT || 10000);
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!PAYSTACK_SECRET_KEY) console.warn('Missing PAYSTACK_SECRET_KEY.');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.warn('Supabase receipt sync is not configured.');

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const serviceCode = (code) => code === 'ID_CARD_ACCESS' ? 'ID_CARD' : String(code || '');
const allowedServices = new Set(['RESULT_ACCESS', 'ID_CARD']);

function requirePaystack(res) {
  if (!PAYSTACK_SECRET_KEY) {
    res.status(503).json({ error: 'Paystack backend is not configured.' });
    return false;
  }
  return true;
}

async function paystack(path, options = {}) {
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function getAuthenticatedStudent(req) {
  if (!supabase || !SUPABASE_URL) return { error: 'Supabase is not configured.' };
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { error: 'Authentication required.' };

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false }
  });
  const { data: { user }, error } = await userClient.auth.getUser(token);
  if (error || !user) return { error: 'Invalid session.' };

  const { data: student, error: studentError } = await supabase
    .from('students')
    .select('id,student_id,first_name,middle_name,last_name,school_email,guardian_email')
    .eq('user_id', user.id)
    .maybeSingle();

  if (studentError) return { error: studentError.message };
  if (!student) return { error: 'Student profile not found.' };
  return { user, student };
}

async function syncPendingPayment({ reference, service_code, student_id, amount, currency, metadata = {} }) {
  if (!supabase || !student_id) return null;
  const { data: existing } = await supabase
    .from('student_service_payments')
    .select('id')
    .eq('reference', reference)
    .maybeSingle();

  if (existing?.id) return existing.id;

  const { data, error } = await supabase
    .from('student_service_payments')
    .insert({
      student_id,
      service_code,
      amount,
      currency: currency || 'NGN',
      reference,
      status: 'PENDING',
      provider: 'PAYSTACK',
      metadata
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function syncSuccessfulPayment({ reference, transaction, student_id, service_code }) {
  if (!supabase) return { synced: false, receipt_published: false };

  const amount = Number(transaction.amount) / 100;
  const currency = transaction.currency || 'NGN';
  const baseMetadata = {
    paystack: transaction,
    verified: true,
    verified_at: new Date().toISOString()
  };

  const { data: existing } = await supabase
    .from('student_service_payments')
    .select('id,metadata')
    .eq('reference', reference)
    .maybeSingle();

  let paymentId = existing?.id || null;

  if (paymentId) {
    const { error } = await supabase
      .from('student_service_payments')
      .update({
        status: 'PAID',
        amount,
        currency,
        service_code: service_code || undefined,
        paid_at: new Date().toISOString(),
        metadata: { ...(existing.metadata || {}), ...baseMetadata }
      })
      .eq('id', paymentId);
    if (error) throw error;
  } else {
    if (!student_id || !service_code) {
      return { synced: false, receipt_published: false, reason: 'student_id and service_code are required to publish the receipt.' };
    }

    const { data, error } = await supabase
      .from('student_service_payments')
      .insert({
        student_id,
        service_code,
        amount,
        currency,
        reference,
        status: 'PAID',
        provider: 'PAYSTACK',
        paid_at: new Date().toISOString(),
        metadata: baseMetadata
      })
      .select('id')
      .single();
    if (error) throw error;
    paymentId = data.id;
  }

  return { synced: true, receipt_published: true, payment_id: paymentId };
}

async function fetchReceipt(reference, student_id) {
  if (!supabase || !reference) return null;
  let query = supabase.from('student_payment_receipts').select('*').eq('payment_reference', reference);
  if (student_id) query = query.eq('student_id', student_id);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

app.get('/', (_req, res) => res.json({ service: 'Laff British School Paystack Backend', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Paystack sends the webhook with a raw JSON body. Keep this route before
// express.json() so the HMAC signature is calculated from the exact body.
app.post('/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!requirePaystack(res)) return;
  try {
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (!signature || signature !== expected) return res.status(401).json({ error: 'Invalid signature.' });

    const event = JSON.parse(req.body.toString('utf8'));
    if (event?.event === 'charge.success' && event?.data?.reference) {
      const reference = String(event.data.reference);
      const { data: payment } = supabase
        ? await supabase.from('student_service_payments')
            .select('id,amount,student_id,service_code,metadata')
            .eq('reference', reference)
            .maybeSingle()
        : { data: null };

      if (payment && Number(event.data.amount) >= Math.round(Number(payment.amount) * 100) && event.data.currency === 'NGN') {
        await supabase.from('student_service_payments').update({
          status: 'PAID',
          paid_at: new Date().toISOString(),
          metadata: {
            ...(payment.metadata || {}),
            paystack: event.data,
            webhook_received_at: new Date().toISOString(),
            verified: true
          }
        }).eq('id', payment.id);
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Webhook processing failed.' });
  }
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Paystack is the first payment call. Supabase sync happens only after
// Paystack accepts the transaction, and no callback redirect is used for
// Popup V2. The browser keeps control of the checkout page.
app.post('/payments/initialize', async (req, res) => {
  if (!requirePaystack(res)) return;
  try {
    const { email, amount, service_code: rawCode, title, student_id } = req.body || {};
    const code = serviceCode(rawCode);
    const requestedAmount = Number(amount);

    if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'A valid payment email is required.' });
    if (!allowedServices.has(code)) return res.status(400).json({ error: 'Invalid service.' });
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) return res.status(400).json({ error: 'Invalid payment amount.' });

    const reference = `LBS-${code}-${crypto.randomUUID().slice(0, 8)}`;
    const { response, payload } = await paystack('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: String(email).trim(),
        amount: Math.round(requestedAmount * 100),
        currency: 'NGN',
        reference,
        metadata: {
          student_id: student_id || null,
          service_code: code,
          service_title: title || (code === 'ID_CARD' ? 'Student ID Card' : 'Result Access'),
          service_amount: requestedAmount
        }
      })
    });

    if (!response.ok || !payload.status) {
      return res.status(502).json({ error: payload.message || 'Paystack initialization failed.' });
    }

    let supabase_synced = false;
    try {
      if (student_id) {
        await syncPendingPayment({
          reference,
          service_code: code,
          student_id,
          amount: requestedAmount,
          currency: 'NGN',
          metadata: {
            access_code: payload.data?.access_code || null,
            authorization_url: payload.data?.authorization_url || null
          }
        });
        supabase_synced = true;
      }
    } catch (error) {
      console.error('Post-Paystack Supabase sync failed:', error);
    }

    res.json({
      paid: false,
      reference,
      access_code: payload.data?.access_code || null,
      authorization_url: payload.data?.authorization_url || null,
      amount: requestedAmount,
      supabase_synced
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not initialize payment.' });
  }
});

app.post('/payments/verify', async (req, res) => {
  if (!requirePaystack(res)) return;
  try {
    const { reference, student_id, service_code: rawCode } = req.body || {};
    const ref = String(reference || '').trim();
    const code = serviceCode(rawCode);
    if (!ref) return res.status(400).json({ error: 'Payment reference is required.' });
    if (!allowedServices.has(code)) return res.status(400).json({ error: 'Invalid service.' });

    const { response, payload } = await paystack(`/transaction/verify/${encodeURIComponent(ref)}`);
    const transaction = payload?.data || {};
    const paystackStatus = String(transaction.status || '').toLowerCase();
    const amountOk = Number(transaction.amount) > 0;
    const success = response.ok && payload.status === true && paystackStatus === 'success' && amountOk && transaction.currency === 'NGN';
    const terminalFailure = ['failed', 'abandoned', 'reversed'].includes(paystackStatus);

    if (!success) {
      return res.json({
        paid: false,
        reference: ref,
        status: terminalFailure ? 'FAILED' : 'PENDING',
        paystack_status: paystackStatus || null,
        gateway_response: transaction.gateway_response || null,
        response_code: transaction.response_code || null,
        supabase_synced: false,
        receipt_published: false
      });
    }

    const synced = await syncSuccessfulPayment({
      reference: ref,
      transaction,
      student_id,
      service_code: code
    });

    const receipt = await fetchReceipt(ref, student_id);

    res.json({
      paid: true,
      reference: ref,
      status: 'PAID',
      supabase_synced: synced.synced,
      receipt_published: synced.receipt_published,
      receipt
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not verify payment.' });
  }
});

app.post('/payments/receipt', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Supabase receipt service is not configured.' });
    const studentResult = await getAuthenticatedStudent(req);
    if (studentResult.error) return res.status(401).json({ error: studentResult.error });

    const reference = String(req.body?.reference || '').trim();
    if (!reference) return res.status(400).json({ error: 'Payment reference is required.' });

    const receipt = await fetchReceipt(reference, studentResult.student.id);
    if (!receipt) return res.status(404).json({ error: 'Payment receipt not found.' });

    res.json({ receipt });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not fetch payment receipt.' });
  }
});

app.listen(PORT, () => console.log(`Paystack backend listening on port ${PORT}`));
