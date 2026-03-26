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
const qs = require('querystring');

const app = express();
app.use(express.json());
app.use(express.text({ type: 'text/plain' }));

// ─── Salesforce Auth ──────────────────────────────────────────────────────────

let sfAccessToken = null;
let sfInstanceUrl = null;

async function getSalesforceToken() {
  if (sfAccessToken) return { accessToken: sfAccessToken, instanceUrl: sfInstanceUrl };

  const params = qs.stringify({
    grant_type: 'password',
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
    username: process.env.SF_USERNAME,
    password: `${process.env.SF_PASSWORD}${process.env.SF_SECURITY_TOKEN || ''}`,
  });

  const res = await axios.post(
    `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  sfAccessToken = res.data.access_token;
  sfInstanceUrl = res.data.instance_url;
  console.log('[SF] Authenticated. Instance:', sfInstanceUrl);
  return { accessToken: sfAccessToken, instanceUrl: sfInstanceUrl };
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
      sfAccessToken = null; // force re-auth on next call
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
    sfQuery(`SELECT Id, Name, Phone, MobilePhone, Email, AccountId
             FROM Contact
             WHERE Phone IN (${phoneVariants})
                OR MobilePhone IN (${phoneVariants})
             LIMIT 10`),
    sfQuery(`SELECT Id, Name, Phone, MobilePhone, Email, Status
             FROM Lead
             WHERE Phone IN (${phoneVariants})
                OR MobilePhone IN (${phoneVariants})
             AND IsConverted = false
             LIMIT 10`),
  ]);

  return { contacts, leads };
}

// ─── Build & post activity Task in Salesforce ────────────────────────────────

async function logCallActivity(payload, internalBorrower, externalBorrower) {
  const { direction, external_number, internal_number, call_id, target, contact } = payload;

  const description = [
    `Dialpad Call Connected`,
    `────────────────────────────`,
    `Call ID      : ${call_id}`,
    `Direction    : ${direction}`,
    ``,
    `─── Agent (Internal) ─────────`,
    `Name         : ${target?.name || 'Unknown'}`,
    `Email        : ${target?.email || '—'}`,
    `Number       : ${internal_number}`,
    ``,
    `─── Contact (External) ───────`,
    `Name         : ${contact?.name || 'Unknown'}`,
    `Email        : ${contact?.email || '—'}`,
    `Number       : ${external_number}`,
    ``,
    `─── SF Records Found ─────────`,
    `Internal     : ${internalBorrower.contacts.length} contacts, ${internalBorrower.leads.length} leads`,
    `External     : ${externalBorrower.contacts.length} contacts, ${externalBorrower.leads.length} leads`,
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
    CallDurationInSeconds: 0, // call just connected — update on hangup if desired
    TaskSubtype: 'Call',
  };

  if (primaryRecord?.Id) {
    const isLead = 'Status' in primaryRecord;
    taskBase[isLead ? 'WhoId' : 'WhoId'] = primaryRecord.Id;
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
  const raw = req.body;

  if (secret && typeof raw === 'string') {
    // JWT signed payload
    try {
      return jwt.verify(raw, secret, { algorithms: ['HS256'] });
    } catch (err) {
      console.error('[Webhook] JWT verification failed:', err.message);
      return null;
    }
  }

  // Plain JSON (no secret configured)
  return typeof raw === 'object' ? raw : null;
}

// ─── Main Webhook Route ───────────────────────────────────────────────────────

app.post('/webhook/dialpad', async (req, res) => {
  const payload = decodeDialpadPayload(req);

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or unverified payload' });
  }

  console.log(`[Webhook] Event: state=${payload.state} call_id=${payload.call_id} dir=${payload.direction}`);

  // Only act on "connected" — this is the "phone picked up" moment
  if (payload.state !== 'connected') {
    return res.status(200).json({ skipped: true, state: payload.state });
  }

  const externalPhone = normalizePhone(payload.external_number);
  const internalPhone = normalizePhone(payload.internal_number);

  console.log(`[Webhook] Connected call — ext=${externalPhone} int=${internalPhone}`);

  try {
    // Look up both sides concurrently
    const [externalBorrower, internalBorrower] = await Promise.all([
      findBorrowersByPhone(externalPhone),
      findBorrowersByPhone(internalPhone),
    ]);

    console.log(`[SF] External matches: ${externalBorrower.contacts.length} contacts, ${externalBorrower.leads.length} leads`);
    console.log(`[SF] Internal matches: ${internalBorrower.contacts.length} contacts, ${internalBorrower.leads.length} leads`);

    // Log activity to Salesforce
    await logCallActivity(payload, internalBorrower, externalBorrower);

    return res.status(200).json({
      ok: true,
      call_id: payload.call_id,
      external: {
        phone: externalPhone,
        contacts: externalBorrower.contacts.map(c => ({ id: c.Id, name: c.Name })),
        leads: externalBorrower.leads.map(l => ({ id: l.Id, name: l.Name })),
      },
      internal: {
        phone: internalPhone,
        contacts: internalBorrower.contacts.map(c => ({ id: c.Id, name: c.Name })),
        leads: internalBorrower.leads.map(l => ({ id: l.Id, name: l.Name })),
      },
    });
  } catch (err) {
    console.error('[Error]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));
