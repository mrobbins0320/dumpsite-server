// ═══════════════════════════════════════════════════════════════
// DumpSite.io — Dashboard Server v4
// Handles order webhooks from Juan's system + rep posting reports
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CONFIG ────────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const MICAH_PHONE       = process.env.MICAH_PHONE;
const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN      = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM       = process.env.TWILIO_PHONE_NUMBER;
const DASHBOARD_SECRET  = process.env.DASHBOARD_SECRET || '66ad738dd8107f8c4496635050513265';

// ── SUPABASE HELPERS ──────────────────────────────────────────
async function sbInsert(table, data){
  if(!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=representation'
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function sbUpsert(table, data, onConflict){
  if(!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function sbPatch(table, id, data){
  if(!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify(data)
  });
  return res.ok;
}

async function sbSelect(table, filters){
  if(!SUPABASE_URL || !SUPABASE_KEY) return [];
  let url = `${SUPABASE_URL}/rest/v1/${table}?`;
  if(filters) Object.entries(filters).forEach(([k,v]) => url += `${k}=eq.${encodeURIComponent(v)}&`);
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── IN-MEMORY FALLBACK ────────────────────────────────────────
const stats = {};

// ── TWILIO SMS ────────────────────────────────────────────────
function sendSMS(to, body){
  if(!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return;
  const twilio = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
  twilio.messages.create({ to, from: TWILIO_FROM, body })
    .then(m => console.log('[SMS]', m.sid))
    .catch(e => console.error('[SMS error]', e.message));
}

// ── ORDER MESSAGE PARSER (fallback if payload fields missing) ──
function parseOrderBody(body){
  try {
    const clean = body.replace(/new order received:?\s*/i, '').trim();
    const parts = clean.split('/').map(p => p.trim());
    const customer_name = parts[0] || 'Unknown';
    const orderPart = parts[1] || '';
    const qtyMatch = orderPart.match(/(\d+)\s*yds?/i);
    const quantity  = qtyMatch ? qtyMatch[1] + ' yards' : null;
    const toMatch   = orderPart.match(/to\s+(.+)$/i);
    const city      = toMatch ? toMatch[1].trim() : 'Unknown';
    const product   = /structural/i.test(orderPart) ? 'Structural Fill' : 'Clean Fill Dirt';
    const amountPart  = parts[2] || '';
    const amountMatch = amountPart.match(/\$?([\d,]+)/);
    const amount      = amountMatch ? parseInt(amountMatch[1].replace(',','')) : 0;
    return { customer_name, quantity, city, product, amount };
  } catch(e){ return null; }
}

// ── ENDPOINTS ─────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'DumpSite Dashboard Server v4',
    time:    new Date().toISOString()
  });
});

// ── MAIN ORDER WEBHOOK ────────────────────────────────────────
// Receives POSTs from Juan's system for both order_placed and order_delivered
app.post('/order', async (req, res) => {

  // Validate secret
  const secret = req.headers['x-dashboard-secret'] || req.body.secret;
  if(secret !== DASHBOARD_SECRET){
    console.warn('[ORDER] Rejected — bad secret');
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const body = req.body;
    console.log('[ORDER]', JSON.stringify(body));

    // Extract fields from Juan's payload
    const eventType        = body.EventType        || 'order_placed';
    const agentId          = body.AgentId          || null;
    const agentName        = body.AgentName        || 'Unknown';
    const amountDollars    = parseInt(body.AmountDollars || body.amount || 0);
    const agentCommission  = parseInt(body.AgentCommission  || Math.round(amountDollars * 0.10));
    const managerCommission= parseInt(body.ManagerCommission || Math.round(amountDollars * 0.05));
    const fromNumber       = body.From             || '';

    // Parse order details — use dedicated fields if available, else parse Body
    let customer_name, quantity, city, product;
    if(body.CustomerName){
      customer_name = body.CustomerName;
      quantity      = body.Quantity;
      city          = body.City;
      product       = body.Material || 'Clean Fill Dirt';
    } else {
      const parsed = parseOrderBody(body.Body || '');
      if(parsed){
        customer_name = parsed.customer_name;
        quantity      = parsed.quantity;
        city          = parsed.city;
        product       = parsed.product;
      }
    }

    // Find rep_id from agent's Twilio number or AgentId
    let rep_id = agentId;
    if(!rep_id && fromNumber){
      const reps = await sbSelect('reps', { phone: fromNumber });
      if(reps.length > 0) rep_id = reps[0].id;
    }
    if(!rep_id) rep_id = 'TX-01'; // fallback

    if(eventType === 'order_placed'){
      // Insert new pipeline order
      await sbInsert('pipeline_orders', {
        rep_id,
        status:        'new',
        city:          city          || 'Unknown',
        product:       product       || 'Clean Fill Dirt',
        amount:        amountDollars,
        quantity:      quantity      || null,
        customer_name: customer_name || 'Unknown',
        created_at:    new Date().toISOString()
      });

      console.log(`[ORDER PLACED] Rep: ${rep_id} | ${customer_name} | ${city} | $${amountDollars}`);

    } else if(eventType === 'order_delivered'){
      // Update existing order to delivered
      // Find the most recent non-delivered order for this rep
      const orders = await sbSelect('pipeline_orders', { rep_id });
      const pending = orders
        .filter(o => o.status !== 'delivered' && o.customer_name === customer_name)
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

      if(pending.length > 0){
        await sbPatch('pipeline_orders', pending[0].id, {
          status:       'delivered',
          delivered_at: new Date().toISOString()
        });
        console.log(`[ORDER DELIVERED] Rep: ${rep_id} | ${customer_name} | $${amountDollars}`);
      } else {
        // Insert as delivered if no pending found
        await sbInsert('pipeline_orders', {
          rep_id,
          status:        'delivered',
          city:          city          || 'Unknown',
          product:       product       || 'Clean Fill Dirt',
          amount:        amountDollars,
          quantity:      quantity      || null,
          customer_name: customer_name || 'Unknown',
          delivered_at:  new Date().toISOString(),
          created_at:    new Date().toISOString()
        });
      }
    }

    res.json({ ok: true, event: eventType, rep: rep_id });

  } catch(e){
    console.error('[ORDER ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── REP DAILY STATS SYNC ──────────────────────────────────────
app.post('/sync', async (req, res) => {
  const { rep_id, date, posts_done, total_slots } = req.body;
  if(!rep_id || !date) return res.status(400).json({ error: 'missing fields' });

  // Store in memory
  stats[`${rep_id}_${date}`] = {
    rep_id, date,
    posts_done:  posts_done  || 0,
    total_slots: total_slots || 9,
    updated_at:  new Date().toISOString()
  };

  // Also upsert to Supabase
  await sbUpsert('rep_stats', {
    rep_id, date,
    posts_done:  posts_done  || 0,
    total_slots: total_slots || 9,
    updated_at:  new Date().toISOString()
  }, 'rep_id,date');

  res.json({ ok: true });
});

// ── PIPELINE FOR ONE REP ──────────────────────────────────────
app.get('/pipeline/:repId', async (req, res) => {
  try {
    const orders = await sbSelect('pipeline_orders', { rep_id: req.params.repId });
    res.json({ orders: orders.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)) });
  } catch(e){
    res.json({ orders: [] });
  }
});

// ── UPDATE ORDER STATUS ───────────────────────────────────────
app.post('/pipeline/:repId/update', async (req, res) => {
  const { order_id, status } = req.body;
  const updates = { status };
  if(status === 'delivered') updates.delivered_at = new Date().toISOString();
  const ok = await sbPatch('pipeline_orders', order_id, updates);
  res.json({ ok });
});

// ── LEADERBOARD ───────────────────────────────────────────────
app.get('/leaderboard', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const reps  = await sbSelect('reps');
    const allStats = await sbSelect('rep_stats', { date: today });
    const board = reps
      .filter(r => !r.is_manager)
      .map(r => {
        const s = allStats.find(s => s.rep_id === r.id) || {};
        return { ...r, posts_done: s.posts_done||0, total_slots: s.total_slots||9 };
      })
      .sort((a,b) => b.posts_done - a.posts_done);
    res.json(board);
  } catch(e){
    res.json([]);
  }
});

// ── SUMMARY ───────────────────────────────────────────────────
app.get('/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const allStats = await sbSelect('rep_stats', { date: today });
    let total_posts=0, active=0;
    allStats.forEach(s => {
      total_posts += s.posts_done||0;
      if(s.posts_done > 0) active++;
    });
    res.json({ date: today, total_posts, active_reps: active });
  } catch(e){
    res.json({ date: new Date().toISOString().slice(0,10), total_posts: 0, active_reps: 0 });
  }
});

// ── 9 PM REP POSTING REPORTS ──────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date();
  try {
    const reps = await sbSelect('reps');
    reps.filter(r => !r.is_manager && r.active).forEach(rep => {
      const tz    = rep.state === 'co' ? 'America/Denver' : 'America/Chicago';
      const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      if(local.getHours() === 21 && local.getMinutes() === 0){
        const today = local.toISOString().slice(0,10);
        const s     = stats[`${rep.id}_${today}`] || {};
        const pct   = s.total_slots > 0 ? Math.round((s.posts_done||0)/s.total_slots*100) : 0;
        const msg   = `${rep.name} (${rep.id})\nPosts: ${s.posts_done||0}/${s.total_slots||9} (${pct}%)\nMarket: ${rep.market||''}`;
        sendSMS(MICAH_PHONE, msg);
        console.log(`[9PM] ${rep.name}`);
      }
    });
  } catch(e){ console.error('[Cron error]', e.message); }
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DumpSite Server v4 on port ${PORT}`);
  console.log(`Webhook: https://dumpsite-server.onrender.com/order`);
  console.log(`Secret: ${DASHBOARD_SECRET ? 'configured' : 'NOT SET'}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'configured' : 'NOT SET'}`);
});
