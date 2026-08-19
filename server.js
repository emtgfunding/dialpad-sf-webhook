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

// ─── Dialpad Helpers ─────────────────────────────────────────────────────────

async function getDialpadUserByEmail(email) {
  if (!email) return null;
  const apiKey = process.env.DIALPAD_API_KEY;
  console.log('[Dialpad] Using API key prefix:', apiKey ? apiKey.slice(0,8) + '...' : 'MISSING');
  try {
    const res = await axios.get(
      `https://dialpad.com/api/v2/users?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    const items = res.data?.items || [];
    return items[0] || null;
  } catch (err) {
    console.error('[Dialpad] User lookup failed:', err.response?.data || err.message);
    return null;
  }
}

async function fireScreenPop(dialpadUserId, sfLeadUrl) {
  const apiKey = process.env.DIALPAD_API_KEY;
  try {
    const res = await axios.post(
      `https://dialpad.com/api/v2/users/${dialpadUserId}/screenpop`,
      { screen_pop_uri: sfLeadUrl },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Dialpad] Screen pop fired for user ${dialpadUserId} → ${sfLeadUrl}`);
    return res.data;
  } catch (err) {
    console.error('[Dialpad] Screen pop failed:', err.response?.data || err.message);
  }
}

// ─── Salesforce Auth ──────────────────────────────────────────────────────────

let sfAccessToken = null;
let sfInstanceUrl = null;
let sfTokenExpiry = 0;

async function getSalesforceToken() {
  // Return cached token if still valid (cache for 55 min)
  if (sfAccessToken && Date.now() < sfTokenExpiry) {
    return { accessToken: sfAccessToken, instanceUrl: sfInstanceUrl };
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  });

  const loginUrl = process.env.SF_LOGIN_URL || 'https://emtg.my.salesforce.com';
  const res = await axios.post(
    `${loginUrl}/services/oauth2/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  sfAccessToken = res.data.access_token;
  sfInstanceUrl = res.data.instance_url;
  sfTokenExpiry = Date.now() + (55 * 60 * 1000); // cache 55 minutes
  console.log('[SF] Token refreshed via client credentials. Instance:', sfInstanceUrl);
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
      console.error('[SF] Token expired — clearing cache to force re-auth on next call');
      sfAccessToken = null;
      sfTokenExpiry = 0;
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

const LEAD_FIELDS = `Id, Name, Phone, MobilePhone, Email, Status, CreatedDate, OwnerId,
                     Dialer_Agent__c, Dialpad_Call_Id__c, Transfer_Answered_At__c`;

function phoneVariantList(phone10) {
  return [
    phone10,
    `(${phone10.slice(0,3)}) ${phone10.slice(3,6)}-${phone10.slice(6)}`,
    `${phone10.slice(0,3)}-${phone10.slice(3,6)}-${phone10.slice(6)}`,
    `+1${phone10}`,
  ].map(v => `'${v}'`).join(',');
}

async function findLeadsByPhone(phone10) {
  if (!phone10) return [];
  const phoneVariants = phoneVariantList(phone10);
  return sfQuery(`SELECT ${LEAD_FIELDS}
                  FROM Lead
                  WHERE (Phone IN (${phoneVariants})
                     OR MobilePhone IN (${phoneVariants}))
                  AND IsConverted = false
                  ORDER BY CreatedDate DESC
                  LIMIT 10`);
}

async function findLeadByCallId(masterCallId) {
  if (!masterCallId) return null;
  const records = await sfQuery(`SELECT ${LEAD_FIELDS}
                                 FROM Lead
                                 WHERE Dialpad_Call_Id__c = '${masterCallId}'
                                 AND IsConverted = false
                                 ORDER BY CreatedDate DESC
                                 LIMIT 1`);
  return records[0] || null;
}

async function findBorrowersByPhone(phone10, masterCallId) {
  if (!phone10) return { contacts: [], leads: [] };

  const phoneVariants = phoneVariantList(phone10);

  const [contacts, boundLead, phoneLeads] = await Promise.all([
    sfQuery(`SELECT Id, Name, Phone, MobilePhone, Email, AccountId, CreatedDate
             FROM Contact
             WHERE Phone IN (${phoneVariants})
                OR MobilePhone IN (${phoneVariants})
             ORDER BY CreatedDate DESC
             LIMIT 1`),
    findLeadByCallId(masterCallId),
    findLeadsByPhone(phone10),
  ]);

  // The lead bound to this exact call wins; otherwise prefer the pool-owned copy
  // over vendor duplicates, then any transfer lead, then simply the newest.
  const pick = boundLead
    || phoneLeads.find(l => l.OwnerId === POOL_OWNER_ID)
    || phoneLeads.find(l => l.Dialer_Agent__c)
    || phoneLeads[0];

  return { contacts, leads: pick ? [pick] : [] };
}

// ─── Look up SF User by email (the loan officer who picked up) ───────────────

// Dialpad account emails that don't match the SF User email — map Dialpad → SF.
const DIALPAD_TO_SF_EMAIL = {
  'navaehy@emtg.com': 'nevaehy@emtg.com', // Nevaeh Younan — Dialpad spells it "navaehy"
};

async function findSFUserByEmail(email) {
  if (!email) return null;
  const sfEmail = DIALPAD_TO_SF_EMAIL[email.toLowerCase()] || email;
  const records = await sfQuery(
    `SELECT Id, Name, Email FROM User WHERE Email = '${sfEmail}' AND IsActive = true LIMIT 1`
  );
  return records[0] || null;
}

// ─── Transfer assignment tuning ──────────────────────────────────────────────

const POOL_OWNER_ID = '005Hr00000IS9pcIAD'; // Talk IT Pro pool user

// A retransfer (telemarketer re-bridges after a drop) is a NEW call id arriving
// shortly after the webhook assigned the lead. Within this window the new
// answerer takes the lead; outside it, owners are never touched.
const RETRANSFER_WINDOW_MIN = parseInt(process.env.RETRANSFER_WINDOW_MIN || '30', 10);

// First answered leg of a call wins — later legs of the SAME call never
// re-assign (kills the same-second double-assign race). In-memory is enough:
// the durable stamp on the lead covers restarts.
const claimedCalls = new Map(); // masterCallId -> { userId, ts }
function claimCall(masterCallId, userId) {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [k, v] of claimedCalls) if (v.ts < cutoff) claimedCalls.delete(k);
  claimedCalls.set(masterCallId, { userId, ts: Date.now() });
}

function getMasterCallId(payload) {
  const id = payload.entry_point_call_id || payload.master_call_id || payload.call_id;
  return id == null ? null : String(id);
}

// ─── Reassign Lead or Contact owner ──────────────────────────────────────────

async function reassignOwner(recordId, isLead, newOwnerId, extraFields) {
  const { accessToken, instanceUrl } = await getSalesforceToken();
  const sobject = isLead ? 'Lead' : 'Contact';
  try {
    await axios.patch(
      `${instanceUrl}/services/data/v59.0/sobjects/${sobject}/${recordId}`,
      { OwnerId: newOwnerId, ...(extraFields || {}) },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[SF] ${sobject} ${recordId} reassigned to User ${newOwnerId}`);
    return true;
  } catch (err) {
    console.error(`[SF] Reassign failed for ${sobject} ${recordId}:`, err.response?.data || err.message);
    return false;
  }
}

// ─── Stamp call-binding fields on a Lead (no owner change) ───────────────────

async function stampLead(leadId, fields) {
  const { accessToken, instanceUrl } = await getSalesforceToken();
  try {
    await axios.patch(
      `${instanceUrl}/services/data/v59.0/sobjects/Lead/${leadId}`,
      fields,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[SF] Lead ${leadId} stamped:`, JSON.stringify(fields));
    return true;
  } catch (err) {
    console.error(`[SF] Stamp failed for Lead ${leadId}:`, err.response?.data || err.message);
    return false;
  }
}

// ─── Grant the answering LO edit access to ONE specific Lead ─────────────────
// Fallback only: used when a Talk IT Pro pool lead's reassignment fails, so the LO
// can still work the call while the lead sits in the pool owner's name. Leads owned
// by other LOs are never shared. Duplicate/owner shares fail harmlessly.
async function grantLeadAccess(leadId, userId) {
  const { accessToken, instanceUrl } = await getSalesforceToken();
  try {
    await axios.post(
      `${instanceUrl}/services/data/v59.0/sobjects/LeadShare`,
      { LeadId: leadId, UserOrGroupId: userId, LeadAccessLevel: 'Edit', RowCause: 'Manual' },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[SF] Granted Edit access on Lead ${leadId} to User ${userId}`);
  } catch (err) {
    console.warn(`[SF] grantLeadAccess note for ${leadId}:`, err.response?.data || err.message);
  }
}

// ─── Build & post activity Task in Salesforce ────────────────────────────────

async function logCallActivity(payload, externalBorrower, sfUser, assignAction) {
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
    `Assignment   : ${assignAction || 'none'}`,
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
  const masterCallId = getMasterCallId(payload);

  console.log(`[Webhook] Connected call — ext=${externalPhone} int=${internalPhone} lo=${loEmail} master=${masterCallId}`);

  // Entry-point leg (call hit the department line, no LO yet): bind this call to
  // its pool-owned transfer lead so the answered leg finds the EXACT record even
  // if vendor duplicates arrive later. No ownership change, no task.
  if (!loEmail) {
    try {
      if (externalPhone && masterCallId) {
        const leads = await findLeadsByPhone(externalPhone);
        const poolLead = leads.find(l => l.OwnerId === POOL_OWNER_ID);
        if (poolLead) {
          await stampLead(poolLead.Id, { Dialpad_Call_Id__c: masterCallId });
          console.log(`[Webhook] Entry leg — bound call ${masterCallId} to Lead ${poolLead.Id}`);
          return res.status(200).json({ skipped: true, reason: 'entry point leg', bound: poolLead.Id });
        }
      }
    } catch (err) {
      console.error('[Webhook] Entry-leg bind failed:', err.response?.data || err.message);
    }
    return res.status(200).json({ skipped: true, reason: 'entry point leg', bound: null });
  }

  try {

    // Look up borrower by phone/call-id AND loan officer by email concurrently
    console.log(`[SF] Starting lookup — phone: ${externalPhone}, LO: ${loEmail}, call: ${masterCallId}`);
    const [externalBorrower, sfUser] = await Promise.all([
      findBorrowersByPhone(externalPhone, masterCallId),
      findSFUserByEmail(loEmail),
    ]);

    console.log(`[SF] Borrower matches: ${externalBorrower.contacts.length} contacts, ${externalBorrower.leads.length} leads`);
    console.log(`[SF] Lead IDs found: ${externalBorrower.leads.map(l => l.Id).join(', ') || 'none'}`);
    console.log(`[SF] Loan officer SF User: ${sfUser ? sfUser.Name + ' (' + sfUser.Id + ')' : 'NOT FOUND — email: ' + loEmail}`);

    const primaryLead = externalBorrower.leads[0];
    let assignAction = 'none';

    if (sfUser && primaryLead) {
      // Assignment rules:
      //  - pool-owned            → assign to the answerer (stamp call id + answered-at)
      //  - already the answerer  → refresh stamps only
      //  - owned by another LO   → reassign ONLY for a genuine retransfer: a DIFFERENT
      //    call id arriving within RETRANSFER_WINDOW_MIN of the webhook's own last
      //    assignment. A later leg of the SAME call never re-assigns, and leads the
      //    webhook didn't assign (or assigned long ago) are never touched.
      const claimed = claimedCalls.get(masterCallId);
      const answeredAtMs = primaryLead.Transfer_Answered_At__c ? Date.parse(primaryLead.Transfer_Answered_At__c) : null;
      const withinRetransferWindow = answeredAtMs !== null
        && (Date.now() - answeredAtMs) <= RETRANSFER_WINDOW_MIN * 60 * 1000;
      const isSameCall = !!masterCallId && primaryLead.Dialpad_Call_Id__c === masterCallId;

      if (primaryLead.OwnerId === sfUser.Id) {
        // Bind the call id for same-call dedupe, but do NOT touch
        // Transfer_Answered_At__c — that field marks webhook ASSIGNMENTS only,
        // so an owner taking a routine call never re-opens the retransfer window.
        assignAction = 'already-owner';
        if (masterCallId && primaryLead.Dialpad_Call_Id__c !== masterCallId) {
          await stampLead(primaryLead.Id, { Dialpad_Call_Id__c: masterCallId });
        }
      } else if (claimed && claimed.userId !== sfUser.Id) {
        assignAction = 'skip-same-call-already-claimed';
        console.log(`[SF] Call ${masterCallId} already claimed by User ${claimed.userId} — not re-assigning Lead ${primaryLead.Id}`);
      } else if (primaryLead.OwnerId === POOL_OWNER_ID) {
        assignAction = 'assigned';
        claimCall(masterCallId, sfUser.Id);
        console.log(`[SF] Reassigning Lead ${primaryLead.Id} to ${sfUser.Name}`);
        const ok = await reassignOwner(primaryLead.Id, true, sfUser.Id, {
          Dialpad_Call_Id__c: masterCallId,
          Transfer_Answered_At__c: new Date().toISOString(),
        });
        if (!ok) {
          assignAction = 'assign-failed-shared';
          await grantLeadAccess(primaryLead.Id, sfUser.Id);
        }
      } else if (isSameCall) {
        assignAction = 'skip-same-call-already-claimed';
        console.log(`[SF] Lead ${primaryLead.Id} already claimed via call ${masterCallId} — leaving owner unchanged`);
      } else if (withinRetransferWindow) {
        assignAction = 'reassigned-retransfer';
        claimCall(masterCallId, sfUser.Id);
        console.log(`[SF] Retransfer — Lead ${primaryLead.Id} moves from ${primaryLead.OwnerId} to ${sfUser.Name} (new call ${masterCallId} within ${RETRANSFER_WINDOW_MIN} min)`);
        const ok = await reassignOwner(primaryLead.Id, true, sfUser.Id, {
          Dialpad_Call_Id__c: masterCallId,
          Transfer_Answered_At__c: new Date().toISOString(),
        });
        if (!ok) assignAction = 'retransfer-reassign-failed';
      } else {
        assignAction = 'left-other-owner';
        console.log(`[SF] Lead ${primaryLead.Id} owned by ${primaryLead.OwnerId} (not pool, no recent webhook assignment) — leaving ownership unchanged`);
      }

      // Fire screen pop — opens the Lead record in the LO's browser via Dialpad
      const leadUrl = `https://emtg.lightning.force.com/lightning/r/Lead/${primaryLead.Id}/view`;
      const dialpadUser = await getDialpadUserByEmail(loEmail);
      console.log('[Dialpad] User found:', JSON.stringify(dialpadUser));
      if (dialpadUser?.id) {
        await fireScreenPop(dialpadUser.id, leadUrl);
      } else {
        console.log(`[Dialpad] Could not find Dialpad user for ${loEmail} — skipping screen pop`);
      }
    } else if (!sfUser) {
      console.log(`[SF] Skipping — LO email ${loEmail} not found in SF`);
    } else {
      console.log(`[SF] No matching Lead found for ${externalPhone}`);
    }

    // Log call activity Task
    await logCallActivity(payload, externalBorrower, sfUser, assignAction);

    return res.status(200).json({
      ok: true,
      call_id: payload.call_id,
      master_call_id: masterCallId,
      loan_officer: sfUser ? { id: sfUser.Id, name: sfUser.Name } : null,
      borrower: {
        phone: externalPhone,
        contacts: externalBorrower.contacts.map(c => ({ id: c.Id, name: c.Name })),
        leads: externalBorrower.leads.map(l => ({ id: l.Id, name: l.Name })),
      },
      assignment: assignAction,
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