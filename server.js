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
    .select('id,status')
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
    .select('id,metadata,status,student_id,service_code')
    .eq('reference', reference)
    .maybeSingle();

  if (existing?.status === 'CANCELLED') {
    return { synced: false, receipt_published: false, payment_id: existing.id, cancelled: true };
  }

  let paymentId = existing?.id || null;

  if (paymentId) {
    const { error } = await supabase
      .from('student_service_payments')
      .update({
        status: 'PAID',
        amount,
        currency,
        service_code: service_code || existing.service_code,
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

  try {
    await supabase.rpc('publish_student_payment_receipt', { p_payment_id: paymentId });
  } catch (error) {
    console.error('Receipt publish failed:', error);
    return { synced: true, receipt_published: false, payment_id: paymentId, receipt_error: error.message };
  }

  return { synced: true, receipt_published: true, payment_id: paymentId };
}

async function markReversed(payment, transaction, reason = 'Paystack reported a reversed charge.') {
  if (!supabase || !payment?.id) return null;
  const metadata = {
    ...(payment.metadata || {}),
    paystack: transaction || payment.metadata?.paystack || null,
    reversed: true,
    reversed_at: new Date().toISOString(),
    reversal_reason: reason
  };
  const { error } = await supabase
    .from('student_service_payments')
    .update({ status: 'REVERSED', metadata, updated_at: new Date().toISOString() })
    .eq('id', payment.id);
  if (error) throw error;

  await supabase
    .from('student_payment_receipts')
    .update({ status: 'REVERSED', receipt_data: { ...(payment.metadata || {}), reversed: true, reversal_reason: reason }, updated_at: new Date().toISOString() })
    .eq('payment_id', payment.id);

  return { reversed: true, payment_id: payment.id };
}

async function updateServicePaymentStatus(payment, status, transaction = null) {
  if (!supabase || !payment?.id) return;
  const metadata = transaction
    ? { ...(payment.metadata || {}), paystack: transaction, status_checked_at: new Date().toISOString() }
    : payment.metadata || {};
  const patch = { status, metadata, updated_at: new Date().toISOString() };
  if (status === 'PAID') patch.paid_at = new Date().toISOString();
  const { error } = await supabase.from('student_service_payments').update(patch).eq('id', payment.id);
  if (error) throw error;
}

async function getTransactionByIdentity(studentId, { id = null, reference = null, source = null } = {}) {
  if (!supabase || !studentId) return null;

  if ((source === 'Student service' || !source) && id) {
    const { data } = await supabase.from('student_service_payments')
      .select('id,student_id,service_code,amount,currency,reference,status,provider,paid_at,created_at,updated_at,metadata')
      .eq('id', id).eq('student_id', studentId).maybeSingle();
    if (data) return { ...data, source: 'Student service' };
  }
  if ((source === 'School fees' || !source) && id) {
    const { data } = await supabase.from('payments')
      .select('id,student_id,fee_id,reference,amount,status,provider,paid_at,created_at,metadata')
      .eq('id', id).eq('student_id', studentId).maybeSingle();
    if (data) return { ...data, source: 'School fees' };
  }
  if (reference) {
    const { data: service } = await supabase.from('student_service_payments')
      .select('id,student_id,service_code,amount,currency,reference,status,provider,paid_at,created_at,updated_at,metadata')
      .eq('reference', reference).eq('student_id', studentId).maybeSingle();
    if (service) return { ...service, source: 'Student service' };
    const { data: legacy } = await supabase.from('payments')
      .select('id,student_id,fee_id,reference,amount,status,provider,paid_at,created_at,metadata')
      .eq('reference', reference).eq('student_id', studentId).maybeSingle();
    if (legacy) return { ...legacy, source: 'School fees' };
  }
  return null;
}

async function normalizeTransaction(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const paystack = metadata?.paystack && typeof metadata.paystack === 'object' ? metadata.paystack : {};
  let serviceTitle = row.service_code || '';
  if (row.source === 'School fees' && row.fee_id) {
    const { data: fee } = await supabase.from('fees').select('title').eq('id', row.fee_id).maybeSingle();
    serviceTitle = fee?.title || 'School Fee Payment';
  } else if (row.service_code) {
    const { data: setting } = await supabase.from('student_service_settings').select('title').eq('service_code', row.service_code).maybeSingle();
    serviceTitle = setting?.title || row.service_code;
  } else {
    serviceTitle = serviceTitle || 'School Fee Payment';
  }
  let receiptNumber = null;
  if (row.source === 'Student service') {
    const { data: receipt } = await supabase.from('student_payment_receipts')
      .select('receipt_number').eq('payment_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    receiptNumber = receipt?.receipt_number || null;
  }
  return {
    id: row.id,
    source: row.source,
    fee_id: row.fee_id || null,
    service_code: row.service_code || null,
    service_title: serviceTitle,
    reference: row.reference || '',
    amount: Number(row.amount || 0),
    currency: row.currency || paystack.currency || 'NGN',
    status: row.status || 'PENDING',
    provider: row.provider || 'PAYSTACK',
    paid_at: row.paid_at || paystack.paid_at || paystack.paidAt || null,
    created_at: row.created_at || paystack.created_at || paystack.createdAt || null,
    receipt_number: receiptNumber
  };
}

async function listStudentTransactions(studentId) {
  const [{ data: legacy, error: legacyError }, { data: service, error: serviceError }] = await Promise.all([
    supabase.from('payments').select('id,student_id,fee_id,reference,amount,status,provider,paid_at,created_at,metadata').eq('student_id', studentId).order('created_at', { ascending: false }),
    supabase.from('student_service_payments').select('id,student_id,service_code,amount,currency,reference,status,provider,paid_at,created_at,updated_at,metadata').eq('student_id', studentId).order('created_at', { ascending: false })
  ]);
  if (legacyError) console.warn('Legacy transactions query failed:', legacyError.message);
  if (serviceError) console.warn('Service transactions query failed:', serviceError.message);
  const rows = [
    ...(legacy || []).map(r => ({ ...r, source: 'School fees', currency: 'NGN' })),
    ...(service || []).map(r => ({ ...r, source: 'Student service' }))
  ];
  const normalized = [];
  for (const row of rows) normalized.push(await normalizeTransaction(row));
  const byReference = new Map();
  normalized.sort((a, b) => new Date(b.paid_at || b.created_at || 0) - new Date(a.paid_at || a.created_at || 0));
  for (const tx of normalized) {
    const key = tx.reference || `${tx.source}:${tx.id}`;
    const existing = byReference.get(key);
    if (!existing || (tx.status === 'PAID' && existing.status !== 'PAID')) byReference.set(key, tx);
  }
  return [...byReference.values()].sort((a, b) => new Date(b.paid_at || b.created_at || 0) - new Date(a.paid_at || a.created_at || 0));
}

async function fetchReceipt(reference, student_id) {
  if (!supabase || !reference) return null;
  let query = supabase.from('student_payment_receipts').select('*').eq('reference', reference);
  if (student_id) query = query.eq('student_id', student_id);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

function safePaystackDetails(tx) {
  const p = tx?.metadata?.paystack;
  if (!p || typeof p !== 'object') return null;
  return {
    transaction_id: p.id || null,
    status: p.status || null,
    gateway_response: p.gateway_response || null,
    channel: p.channel || null,
    paid_at: p.paid_at || p.paidAt || null,
    requested_amount: Number.isFinite(Number(p.requested_amount)) ? Number(p.requested_amount) / 100 : null,
    gateway_amount: Number.isFinite(Number(p.amount)) ? Number(p.amount) / 100 : null,
    fees: Number.isFinite(Number(p.fees)) ? Number(p.fees) / 100 : null,
    card_brand: p.authorization?.brand || null,
    card_last4: p.authorization?.last4 || null
  };
}

async function buildReceipt(student, transaction) {
  const receipt = transaction.source === 'Student service' ? await fetchReceipt(transaction.reference, student.id) : null;
  let serviceTitle = transaction.service_code || 'School Fee Payment';
  if (transaction.source === 'Student service') {
    const { data } = await supabase.from('student_service_settings').select('title').eq('service_code', transaction.service_code).maybeSingle();
    serviceTitle = data?.title || transaction.service_code;
  } else if (transaction.fee_id) {
    const { data } = await supabase.from('fees').select('title').eq('id', transaction.fee_id).maybeSingle();
    serviceTitle = data?.title || 'School Fee Payment';
  }

  return {
    id: transaction.id,
    student_id: student.student_id,
    student_name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ') || 'Student',
    service_code: transaction.service_code || null,
    service_title: serviceTitle,
    source: transaction.source,
    fee_id: transaction.fee_id || null,
    reference: transaction.reference,
    receipt_number: receipt?.receipt_number || null,
    amount: Number(transaction.amount || 0),
    currency: transaction.currency || 'NGN',
    status: transaction.status,
    provider: transaction.provider || 'PAYMENT',
    customer_email: student.school_email || student.guardian_email || null,
    created_at: transaction.created_at,
    paid_at: transaction.paid_at,
    receipt_published_at: receipt?.created_at || null,
    paystack: safePaystackDetails(transaction),
    metadata: transaction.metadata || {},
    official_receipt: receipt || null
  };
}

app.get('/', (_req, res) => res.json({ service: 'Laff British School Paystack Backend', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!requirePaystack(res)) return;
  try {
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (!signature || signature !== expected) return res.status(401).json({ error: 'Invalid signature.' });

    const event = JSON.parse(req.body.toString('utf8'));
    const reference = String(event?.data?.reference || '').trim();
    if (reference && supabase && ['charge.success', 'charge.reversed'].includes(event?.event)) {
      const { data: payment } = await supabase.from('student_service_payments')
        .select('id,amount,student_id,service_code,status,metadata').eq('reference', reference).maybeSingle();

      if (payment) {
        if (event.event === 'charge.reversed') {
          await markReversed(payment, event.data, 'Paystack webhook reported a reversed charge.');
        } else if (Number(event.data.amount) >= Math.round(Number(payment.amount) * 100) && event.data.currency === 'NGN') {
          if (payment.status === 'CANCELLED') {
            await markReversed(payment, event.data, 'Payment arrived after the pending transaction was cancelled by the student.');
          } else if (payment.status !== 'REVERSED') {
            await syncSuccessfulPayment({ reference, transaction: event.data, student_id: payment.student_id, service_code: payment.service_code });
          }
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

    if (!response.ok || !payload.status) return res.status(502).json({ error: payload.message || 'Paystack initialization failed.' });

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

    res.json({ paid: false, reference, access_code: payload.data?.access_code || null, authorization_url: payload.data?.authorization_url || null, amount: requestedAmount, supabase_synced });
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

    let pendingPayment = null;
    if (supabase) {
      const { data: pending, error: pendingError } = await supabase.from('student_service_payments')
        .select('id,amount,student_id,service_code,status,metadata').eq('reference', ref).maybeSingle();
      if (pendingError) return res.status(500).json({ error: pendingError.message });
      pendingPayment = pending || null;
      if (pending && student_id && pending.student_id !== student_id) return res.status(403).json({ error: 'Payment does not belong to this student.' });
      if (pending && pending.service_code !== code) return res.status(400).json({ error: 'Payment service does not match.' });
    }

    const { response, payload } = await paystack(`/transaction/verify/${encodeURIComponent(ref)}`);
    const transaction = payload?.data || {};
    const paystackStatus = String(transaction.status || '').toLowerCase();
    const receivedAmount = Number(transaction.amount);
    const expectedKobo = pendingPayment ? Math.round(Number(pendingPayment.amount) * 100) : null;
    const amountOk = expectedKobo === null ? receivedAmount > 0 : receivedAmount >= expectedKobo;
    const success = response.ok && payload.status === true && paystackStatus === 'success' && amountOk && transaction.currency === 'NGN';
    const terminalFailure = ['failed'].includes(paystackStatus);
    const reversed = paystackStatus === 'reversed';

    if (reversed) {
      if (pendingPayment) await markReversed(pendingPayment, transaction, 'Paystack verification reported a reversed charge.');
      return res.json({ paid: false, reference: ref, status: 'REVERSED', paystack_status: paystackStatus, gateway_response: transaction.gateway_response || null, response_code: transaction.response_code || null, amount_ok: amountOk, supabase_synced: Boolean(pendingPayment) });
    }

    if (!success) {
      if (pendingPayment && terminalFailure && pendingPayment.status === 'PENDING') await updateServicePaymentStatus(pendingPayment, 'FAILED', transaction);
      return res.json({
        paid: false,
        reference: ref,
        status: pendingPayment?.status === 'CANCELLED' ? 'CANCELLED' : terminalFailure ? 'FAILED' : (pendingPayment?.status || 'PENDING'),
        paystack_status: paystackStatus || null,
        gateway_response: transaction.gateway_response || null,
        response_code: transaction.response_code || null,
        amount_ok: amountOk,
        supabase_synced: false,
        receipt_published: false
      });
    }

    if (pendingPayment?.status === 'CANCELLED') {
      await markReversed(pendingPayment, transaction, 'Payment arrived after the pending transaction was cancelled by the student.');
      return res.json({ paid: false, reference: ref, status: 'REVERSED', paystack_status: paystackStatus, supabase_synced: true, receipt_published: false, message: 'Payment was received after the transaction was cancelled and has been marked reversed.' });
    }

    const synced = await syncSuccessfulPayment({ reference: ref, transaction, student_id, service_code: code });
    const receipt = await fetchReceipt(ref, student_id);
    res.json({ paid: true, reference: ref, status: 'PAID', supabase_synced: synced.synced, receipt_published: synced.receipt_published, receipt });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not verify payment.' });
  }
});

app.post('/payments/receipts', async (req, res) => {
  try {
    const studentResult = await getAuthenticatedStudent(req);
    if (studentResult.error) return res.status(401).json({ error: studentResult.error });
    const transactions = await listStudentTransactions(studentResult.student.id);
    res.json({ transactions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load transaction history.' });
  }
});

app.post('/payments/status', async (req, res) => {
  if (!requirePaystack(res)) return;
  try {
    const studentResult = await getAuthenticatedStudent(req);
    if (studentResult.error) return res.status(401).json({ error: studentResult.error });
    const { id, reference, source } = req.body || {};
    const transaction = await getTransactionByIdentity(studentResult.student.id, { id, reference, source });
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });

    if (transaction.source !== 'Student service' || String(transaction.provider || '').toUpperCase() !== 'PAYSTACK') {
      return res.json({ id: transaction.id, reference: transaction.reference, status: transaction.status, provider: transaction.provider, refreshed: false, message: 'This payment provider does not support automatic Paystack status refresh.' });
    }

    const { response, payload } = await paystack(`/transaction/verify/${encodeURIComponent(transaction.reference)}`);
    const ps = String(payload?.data?.status || '').toLowerCase();
    const paystackTx = payload?.data || {};
    const amountOk = Number(paystackTx.amount) >= Math.round(Number(transaction.amount) * 100) && paystackTx.currency === 'NGN';

    if (ps === 'success' && amountOk) {
      if (transaction.status === 'CANCELLED') {
        await markReversed(transaction, paystackTx, 'Payment arrived after the pending transaction was cancelled by the student.');
        return res.json({ id: transaction.id, reference: transaction.reference, status: 'REVERSED', paystack_status: ps, paid: false, receipt_published: false, message: 'Payment was received after cancellation and has been marked reversed.' });
      }
      if (transaction.status !== 'PAID') {
        const synced = await syncSuccessfulPayment({ reference: transaction.reference, transaction: paystackTx, student_id: studentResult.student.id, service_code: transaction.service_code });
        const receipt = await fetchReceipt(transaction.reference, studentResult.student.id);
        return res.json({ id: transaction.id, reference: transaction.reference, status: 'PAID', paystack_status: ps, paid: true, receipt_published: synced.receipt_published, receipt });
      }
      return res.json({ id: transaction.id, reference: transaction.reference, status: 'PAID', paystack_status: ps, paid: true, receipt_published: true });
    }

    if (ps === 'reversed') {
      await markReversed(transaction, paystackTx, 'Paystack status refresh reported a reversed charge.');
      return res.json({ id: transaction.id, reference: transaction.reference, status: 'REVERSED', paystack_status: ps, paid: false });
    }

    if (ps === 'failed' && transaction.status === 'PENDING') await updateServicePaymentStatus(transaction, 'FAILED', paystackTx);
    return res.json({ id: transaction.id, reference: transaction.reference, status: transaction.status === 'CANCELLED' ? 'CANCELLED' : (ps === 'failed' ? 'FAILED' : transaction.status), paystack_status: ps || null, paid: transaction.status === 'PAID', gateway_response: paystackTx.gateway_response || null, amount_ok: amountOk, refreshed: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not refresh payment status.' });
  }
});

app.post('/payments/delete', async (req, res) => {
  try {
    const studentResult = await getAuthenticatedStudent(req);
    if (studentResult.error) return res.status(401).json({ error: studentResult.error });
    const { id, reference, source } = req.body || {};
    const transaction = await getTransactionByIdentity(studentResult.student.id, { id, reference, source });
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });
    if (transaction.status !== 'PENDING') return res.status(409).json({ error: 'Only pending transactions can be deleted.' });

    if (transaction.source === 'Student service') {
      const metadata = { ...(transaction.metadata || {}), cancelled: true, cancelled_at: new Date().toISOString(), cancelled_by: 'STUDENT' };
      const { error } = await supabase.from('student_service_payments').update({ status: 'CANCELLED', metadata, updated_at: new Date().toISOString() }).eq('id', transaction.id).eq('student_id', studentResult.student.id).eq('status', 'PENDING');
      if (error) throw error;
      await supabase.from('student_payment_receipts').update({ status: 'CANCELLED', updated_at: new Date().toISOString() }).eq('payment_id', transaction.id);
    } else {
      const { error } = await supabase.from('payments').update({ status: 'CANCELLED' }).eq('id', transaction.id).eq('student_id', studentResult.student.id).eq('status', 'PENDING');
      if (error) throw error;
    }

    res.json({ deleted: true, id: transaction.id, reference: transaction.reference, status: 'CANCELLED' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not delete pending transaction.' });
  }
});

app.post('/payments/receipt', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Supabase receipt service is not configured.' });
    const studentResult = await getAuthenticatedStudent(req);
    if (studentResult.error) return res.status(401).json({ error: studentResult.error });

    const { id, reference, source } = req.body || {};
    const transaction = await getTransactionByIdentity(studentResult.student.id, { id, reference, source });
    if (!transaction) return res.status(404).json({ error: 'Payment transaction not found.' });

    const receipt = await buildReceipt(studentResult.student, transaction);
    res.json({ receipt });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not fetch payment receipt.' });
  }
});

app.listen(PORT, () => console.log(`Paystack backend listening on port ${PORT}`));
