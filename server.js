import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();

const PORT = Number(process.env.PORT || 10000);
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.APP_URL || '';

if (!PAYSTACK_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Missing one or more required Render environment variables.');
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const serviceCode = (code) => code === 'ID_CARD_ACCESS' ? 'ID_CARD' : String(code || '');

function requireConfig(res) {
  if (!PAYSTACK_SECRET_KEY || !supabase) {
    res.status(503).json({ error: 'Payment backend is not configured.' });
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
  const payload = await response.json();
  return { response, payload };
}

async function getStudent(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { error: 'Authentication required.' };

  const userClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || '', {
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

app.get('/', (_req, res) => res.json({ service: 'Laff British School Paystack Backend', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Paystack signs webhooks with the exact raw request body, so this route must
// receive the body before the global JSON parser is applied.
app.post('/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!requireConfig(res)) return;
  try {
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (!signature || signature !== expected) return res.status(401).json({ error: 'Invalid signature.' });

    const event = JSON.parse(req.body.toString('utf8'));
    if (event?.event === 'charge.success' && event?.data?.reference) {
      const reference = String(event.data.reference);
      const { data: payment } = await supabase
        .from('student_service_payments')
        .select('id,amount,student_id,service_code,metadata')
        .eq('reference', reference)
        .maybeSingle();

      if (payment) {
        const amountOk = Number(event.data.amount) >= Math.round(Number(payment.amount) * 100);
        if (amountOk && event.data.currency === 'NGN') {
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
    }

    res.json({ received: true });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Webhook processing failed.' });
  }
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.post('/payments/initialize', async (req, res) => {
  if (!requireConfig(res)) return;
  try {
    const { service_code: rawCode, title } = req.body || {};
    const code = serviceCode(rawCode);
    if (!['RESULT_ACCESS', 'ID_CARD'].includes(code)) return res.status(400).json({ error: 'Invalid service.' });

    const studentResult = await getStudent(req);
    if (studentResult.error) return res.status(401).json({ error: studentResult.error });
    const { user, student } = studentResult;

    const { data: setting, error: settingError } = await supabase
      .from('student_service_settings')
      .select('title,amount,is_active')
      .eq('service_code', code)
      .maybeSingle();

    if (settingError) return res.status(500).json({ error: settingError.message });
    if (!setting?.is_active) return res.status(400).json({ error: 'This service is not currently available.' });

    // The server is the source of truth for the price. The browser does not
    // send an amount, so a modified client cannot change the configured price.
    const requestedAmount = Number(setting.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return res.status(500).json({ error: 'This service has an invalid configured payment amount.' });
    }

    const { data: existing } = await supabase
      .from('student_service_payments')
      .select('reference,status')
      .eq('student_id', student.id)
      .eq('service_code', code)
      .eq('status', 'PAID')
      .limit(1)
      .maybeSingle();

    if (existing) return res.json({ paid: true, reference: existing.reference, amount: requestedAmount });

    const email = student.school_email || student.guardian_email || user.email;
    if (!email) return res.status(400).json({ error: 'No student payment email is available.' });

    const reference = `LBS-${code}-${student.student_id}-${crypto.randomUUID().slice(0, 8)}`;
    const { response, payload } = await paystack('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email,
        amount: Math.round(requestedAmount * 100),
        currency: 'NGN',
        reference,
        callback_url: APP_URL || undefined,
        metadata: {
          student_id: student.id,
          student_number: student.student_id,
          service_code: code,
          service_title: title || setting.title,
          service_amount: requestedAmount
        }
      })
    });

    if (!response.ok || !payload.status) return res.status(502).json({ error: payload.message || 'Paystack initialization failed.' });

    const { error: insertError } = await supabase.from('student_service_payments').insert({
      student_id: student.id,
      service_code: code,
      amount: requestedAmount,
      currency: 'NGN',
      reference,
      status: 'PENDING',
      provider: 'PAYSTACK',
      metadata: {
        access_code: payload.data?.access_code || null,
        authorization_url: payload.data?.authorization_url || null
      }
    });
    if (insertError) return res.status(500).json({ error: insertError.message });

    res.json({
      paid: false,
      reference,
      access_code: payload.data?.access_code || null,
      authorization_url: payload.data?.authorization_url || null,
      amount: requestedAmount
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not initialize payment.' });
  }
});

app.post('/payments/verify', async (req, res) => {
  if (!requireConfig(res)) return;
  try {
    const reference = String(req.body?.reference || '');
    if (!reference) return res.status(400).json({ error: 'Payment reference is required.' });

    const studentResult = await getStudent(req);
    if (studentResult.error) return res.status(401).json({ error: studentResult.error });
    const { student } = studentResult;

    const { data: payment, error: paymentError } = await supabase
      .from('student_service_payments')
      .select('id,student_id,service_code,amount,currency,status,metadata')
      .eq('reference', reference)
      .eq('student_id', student.id)
      .maybeSingle();

    if (paymentError) return res.status(500).json({ error: paymentError.message });
    if (!payment) return res.status(404).json({ error: 'Payment reference not found.' });

    const { response, payload } = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    const transaction = payload?.data || {};
    const paystackStatus = String(transaction.status || '').toLowerCase();
    const amountOk = Number(transaction.amount) >= Math.round(Number(payment.amount) * 100);
    const success = response.ok && payload.status === true && paystackStatus === 'success' && amountOk && transaction.currency === 'NGN';
    const terminalFailure = ['failed', 'abandoned', 'reversed'].includes(paystackStatus);

    const metadata = {
      ...(payment.metadata || {}),
      paystack: transaction,
      verified: success || terminalFailure,
      verified_at: new Date().toISOString()
    };

    const update = { metadata };
    if (success) {
      update.status = 'PAID';
      update.paid_at = new Date().toISOString();
    } else if (terminalFailure) {
      update.status = 'FAILED';
      update.paid_at = null;
    }

    const { error: updateError } = await supabase
      .from('student_service_payments')
      .update(update)
      .eq('id', payment.id);

    if (updateError) return res.status(500).json({ error: updateError.message });

    res.json({
      paid: success,
      reference,
      status: success ? 'PAID' : terminalFailure ? 'FAILED' : 'PENDING',
      receipt_published: success
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

app.listen(PORT, () => console.log(`Paystack backend listening on port ${PORT}`));
