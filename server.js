/**
 * Dialpad → Salesforce Webhook Server
 * Fires when a call is answered (state: "connected")
 * Looks up both borrowers by phone number and upserts a Task in Salesforce
 *
 * ENV VARS REQUIRED:
 *   DIALPAD_WEBHOOK_SECRET   - from Dialpad webhook config (optional but recommended)
 *   SF_LOGIN_URL             - https://login.salesforce.com or sandbox URL
 *   SF_CLIENT_ID             - Connected App consumer key
 *   SF_CLIENT_SECRET         - Connected App consumer secret
 *   SF_USERNAME              - Salesforce API user email
 *   SF_PASSWORD              - Salesforce API user password
 *   SF_SECURITY_TOKEN        - Salesforce security token (append to password if needed)
 *   PORT                     - defaults to 3000
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();

// Capture raw body for JWT verification — must come before any other body parser
app.use((req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    // Also try to parse as JSON for plain JSON payloads
    try {
      req.body = JSON.parse(data);
    } catch (e) {
      req.body = data; // leave as string if not valid JSON
    }
    next();
  });
});

// ─── Salesforce Auth ──────────────────────────────────────────────────────────

async function getSalesforceToken() {
  // Use static token from env (refreshed via SF CLI when needed)
  const accessToken = process.env.SF_ACCESS_TOKEN;
  const instanceUrl = process.env.SF_INSTANCE_URL || 'https://emtg.my.salesforce.com';
  if (!accessToken) throw new Error('SF_ACCESS_TOKEN env var not set');
  return { accessToken, instanceUrl };
}

// ─── Salesforce Query Helper ──────────────────────────────────────────────────

async function sfQuery(soql) {
  const { accessToken, instanceUrl } = await getSalesforceToken();
  try {
    const res = await axios.get(
      `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return res.data.records || [];
  } catch (err) {
    if (err.response?.status === 401) {
      console.error('[SF] Token expired — run: sf org display --target-org emtg --json and update SF_ACCESS_TOKEN in Railway');
    }
    throw err;
  }
}

// ─── Salesforce Upsert Helper (create Task) ───────────────────────────────────

async function sfCreateTask(taskData) {
  const { accessToken, instanceUrl } = await getSalesforceToken();
  const res = await axios.post(
    `${instanceUrl}/services/data/v59.0/sobjects/Task`,
    taskData,
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ─── Phone normalizer (E.164 → 10-digit or match your SF format) ─────────────

function normalizePhone(e164) {
  if (!e164) return null;
  // Strip leading +1 for US numbers → 10 digits
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

// ─── Look up Contacts / Leads by phone ───────────────────────────────────────

async function findBorrowersByPhone(phone10) {
  if (!phone10) return { contacts: [], leads: [] };

  const phoneVariants = [
    phone10,
    `(${phone10.slice(0,3)}) ${phone10.slice(3,6)}-${phone10.slice(6)}`,
    `${phone10.slice(0,3)}-${phone10.slice(3,6)}-${phone10.slice(6)}`,
    `+1${phone10}`,
  ].map(v => `'${v}'`).join(',');

  const [contacts, leads] = await Promise.all([
    sfQuery(`SELECT Id, Name, Phone, MobilePhone, Email, AccountId, CreatedDate
             FROM Contact
             WHERE Phone IN (${phoneVariants})
                OR MobilePhone IN (${phoneVariants})
             ORDER BY CreatedDate DESC
             LIMIT 1`),
    sfQuery(`SELECT Id, Name, Phone, MobilePhone, Email, Status, CreatedDate
             FROM Lead
             WHERE (Phone IN (${phoneVariants})
                OR MobilePhone IN (${phoneVariants}))
             AND IsConverted = false
             ORDER BY CreatedDate DESC
             LIMIT 1`),
  ]);

  return { contacts, leads };
}

// ─── Look up SF User by email (the loan officer who picked up) ───────────────

async function findSFUserByEmail(email) {
  if (!email) return null;
  const records = await sfQuery(
    `SELECT Id, Name, Email FROM User WHERE Email = '${email}' AND IsActive = true LIMIT 1`
  );
  return records[0] || null;
}

// ─── Reassign Lead or Contact owner ──────────────────────────────────────────

async function reassignOwner(recordId, isLead, newOwnerId) {
  const { accessToken, instanceUrl } = await getSalesforceToken();
  const sobject = isLead ? 'Lead' : 'Contact';
  try {
    await axios.patch(
      `${instanceUrl}/services/data/v59.0/sobjects/${sobject}/${recordId}`,
      { OwnerId: newOwnerId },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[SF] ${sobject} ${recordId} reassigned to User ${newOwnerId}`);
  } catch (err) {
    console.error(`[SF] Reassign failed for ${sobject} ${recordId}:`, err.response?.data || err.message);
  }
}

// ─── Build & post activity Task in Salesforce ────────────────────────────────

async function logCallActivity(payload, externalBorrower, sfUser) {
  const { direction, external_number, internal_number, call_id, target, contact } = payload;

  const description = [
    `Dialpad Call Connected`,
    `────────────────────────────`,
    `Call ID      : ${call_id}`,
    `Direction    : ${direction}`,
    ``,
    `─── Loan Officer (Picked Up) ─`,
    `Name         : ${target?.name || 'Unknown'}`,
    `Email        : ${target?.email || '—'}`,
    `Number       : ${internal_number}`,
    `SF User ID   : ${sfUser?.Id || 'Not found'}`,
    ``,
    `─── Borrower (External) ──────`,
    `Name         : ${contact?.name || 'Unknown'}`,
    `Email        : ${contact?.email || '—'}`,
    `Number       : ${external_number}`,
    ``,
    `─── SF Records Found ─────────`,
    `Contacts     : ${externalBorrower.contacts.length}`,
    `Leads        : ${externalBorrower.leads.length}`,
    `Owner Reassigned: ${sfUser ? 'Yes → ' + (target?.name || target?.email) : 'No (LO not found in SF)'}`,
  ].join('\n');

  // Attach task to first matched Contact or Lead from external (borrower) side
  const allExternal = [...externalBorrower.contacts, ...externalBorrower.leads];
  const primaryRecord = allExternal[0];

  const taskBase = {
    Subject: `📞 Dialpad Call Connected — ${contact?.name || external_number}`,
    Status: 'Completed',
    Priority: 'Normal',
    ActivityDate: new Date().toISOString().slice(0, 10),
    Description: description,
    CallType: direction === 'inbound' ? 'Inbound' : 'Outbound',
    CallDurationInSeconds: 0,
    TaskSubtype: 'Call',
  };

  if (primaryRecord?.Id) {
    taskBase.WhoId = primaryRecord.Id;
  }

  // Assign task to the LO who picked up (not the API user)
  if (sfUser?.Id) {
    taskBase.OwnerId = sfUser.Id;
  }

  try {
    const result = await sfCreateTask(taskBase);
    console.log('[SF] Task created:', result.id);
    return result;
  } catch (err) {
    console.error('[SF] Task creation failed:', err.response?.data || err.message);
  }
}

// ─── Decode Dialpad payload (JWT or plain JSON) ───────────────────────────────

function decodeDialpadPayload(req) {
  const secret = process.env.DIALPAD_WEBHOOK_SECRET;
  const raw = req.rawBody || req.body;

  // Try JWT first if secret is configured
  if (secret && typeof raw === 'string' && raw.includes('.')) {
    try {
      const decoded = jwt.verify(raw, secret, { algorithms: ['HS256'] });
      console.log('[Webhook] JWT verified successfully');
      return decoded;
    } catch (err) {
      console.error('[Webhook] JWT verification failed:', err.message);
      // Fall through to try plain JSON
    }
  }

  // Try plain JSON string
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('[Webhook] Failed to parse body as JSON:', raw.slice(0, 100));
      return null;
    }
  }

  // Already parsed object
  if (typeof raw === 'object' && raw !== null && Object.keys(raw).length > 0) {
    return raw;
  }

  console.error('[Webhook] Could not decode payload, raw:', String(raw).slice(0, 200));
  return null;
}

// ─── Main Webhook Route ───────────────────────────────────────────────────────

app.post('/webhook/dialpad', async (req, res) => {
  console.log('[Webhook] Raw body type:', typeof req.body);
  console.log('[Webhook] Raw body preview:', JSON.stringify(req.body)?.slice(0, 300));

  const payload = decodeDialpadPayload(req);

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or unverified payload' });
  }

  console.log('[Webhook] Decoded payload keys:', Object.keys(payload));
  console.log(`[Webhook] Event: state=${payload.state} call_id=${payload.call_id} dir=${payload.direction}`);

  // Only act on inbound connected calls — borrower picked up or LO answered inbound
  if (payload.state !== 'connected') {
    return res.status(200).json({ skipped: true, reason: 'not connected', state: payload.state });
  }
  if (payload.direction !== 'inbound') {
    return res.status(200).json({ skipped: true, reason: 'outbound call ignored', call_id: payload.call_id });
  }

  const externalPhone = normalizePhone(payload.external_number);
  const internalPhone = normalizePhone(payload.internal_number);
  const loEmail = payload.target?.email;

  console.log(`[Webhook] Connected call — ext=${externalPhone} int=${internalPhone} lo=${loEmail}`);

  // Skip entry-point legs (no LO email means it's a call center routing leg, not an answered call)
  if (!loEmail) {
    console.log('[Webhook] Skipping — no LO email (entry point leg, not operator leg)');
    return res.status(200).json({ skipped: true, reason: 'no LO email' });
  }

  try {

    // Look up borrower by phone AND loan officer by email concurrently
    console.log(`[SF] Starting lookup — phone: ${externalPhone}, LO: ${loEmail}`);
    const [externalBorrower, sfUser] = await Promise.all([
      findBorrowersByPhone(externalPhone),
      findSFUserByEmail(loEmail),
    ]);

    console.log(`[SF] Borrower matches: ${externalBorrower.contacts.length} contacts, ${externalBorrower.leads.length} leads`);
    console.log(`[SF] Lead IDs found: ${externalBorrower.leads.map(l => l.Id).join(', ') || 'none'}`);
    console.log(`[SF] Loan officer SF User: ${sfUser ? sfUser.Name + ' (' + sfUser.Id + ')' : 'NOT FOUND — email: ' + loEmail}`);

    // Reassign only the single most recently created Lead
    if (sfUser) {
      const primaryLead = externalBorrower.leads[0];
      if (primaryLead) {
        await reassignOwner(primaryLead.Id, true, sfUser.Id);
      } else {
        console.log(`[SF] No matching Lead found for ${externalPhone}`);
      }
    } else {
      console.log(`[SF] Skipping reassignment — LO email ${loEmail} not found in SF`);
    }

    // Log call activity Task
    await logCallActivity(payload, externalBorrower, sfUser);

    return res.status(200).json({
      ok: true,
      call_id: payload.call_id,
      loan_officer: sfUser ? { id: sfUser.Id, name: sfUser.Name } : null,
      borrower: {
        phone: externalPhone,
        contacts: externalBorrower.contacts.map(c => ({ id: c.Id, name: c.Name })),
        leads: externalBorrower.leads.map(l => ({ id: l.Id, name: l.Name })),
      },
      reassigned: !!sfUser && (externalBorrower.contacts.length + externalBorrower.leads.length) > 0,
    });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Error]', detail);
    return res.status(500).json({ error: detail });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));