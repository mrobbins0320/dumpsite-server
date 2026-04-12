// ═══════════════════════════════════════════════════════════════
// DumpSite.io — Auto-Report Server v3
// + Twilio webhook for live order pipeline
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for Twilio webhooks

// ── SUPABASE CLIENT ───────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabaseInsert(table, data){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function supabaseQuery(table, filters){
  let url = `${SUPABASE_URL}/rest/v1/${table}?`;
  Object.entries(filters).forEach(([k,v]) => url += `${k}=eq.${encodeURIComponent(v)}&`);
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  return res.json();
}

// ── IN-MEMORY STORE (fallback) ────────────────────────────────
const stats = {};
const pipeline = {};

// ── REP ROSTER ────────────────────────────────────────────────
const REPS = [
  { id:'TX-01', name:"Zy'kira",  market:'DFW Core',       state:'tx', tz:'America/Chicago', phone: null },
  { id:'TX-02', name:'Arlett',   market:'DFW East & West', state:'tx', tz:'America/Chicago', phone: null },
  { id:'TX-03', name:'Katie',    market:'DFW North',       state:'tx', tz:'America/Chicago', phone: null },
  { id:'TX-04', name:'Melissa',  market:'DFW Mid-Cities',  state:'tx', tz:'America/Chicago', phone: null },
];

// Bot number → rep mapping
// Add rep bot numbers here as they get assigned
const BOT_NUMBER_TO_REP = {
  // Bot numbers added via env vars — format: BOT_REPID=phone
};

const MICAH_PHONE = process.env.MICAH_PHONE;
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN= process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER;

// ── ORDER PARSER ──────────────────────────────────────────────
// Parses: "New order received: Jesus/ 50yds fill Dirt to North Richland Hills/ $600"
function parseOrderMessage(body){
  try {
    // Remove "New order received:" prefix
    const clean = body.replace(/new order received:?\s*/i, '').trim();

    // Split on /
    const parts = clean.split('/').map(p => p.trim());

    // Part 0 = customer name
    const customer_name = parts[0] || 'Unknown';

    // Part 1 = quantity + product + city
    // e.g. "50yds fill Dirt to North Richland Hills"
    const orderPart = parts[1] || '';
    const qtyMatch = orderPart.match(/(\d+)\s*yds?/i);
    const quantity  = qtyMatch ? qtyMatch[1] + ' yards' : null;

    // Extract city — everything after "to "
    const toMatch = orderPart.match(/to\s+(.+)$/i);
    const city = toMatch ? toMatch[1].trim() : 'Unknown';

    // Product — clean fill or structural fill
    const product = /structural/i.test(orderPart) ? 'Structural Fill' : 'Clean Fill Dirt';

    // Part 2 = amount
    const amountPart = parts[2] || '';
    const amountMatch = amountPart.match(/\$?([\d,]+)/);
    const amount = amountMatch ? parseInt(amountMatch[1].replace(',','')) : 0;

    return { customer_name, quantity, city, product, amount, raw: body };
  } catch(e){
    console.error('Parse error:', e.message);
    return null;
  }
}

// ── TWILIO SMS ────────────────────────────────────────────────
function sendSMS(to, body){
  if(!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM){
    console.log('[SMS skipped — no Twilio creds]', body);
    return;
  }
  const twilio = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
  twilio.messages.create({ to, from: TWILIO_FROM, body })
    .then(m => console.log('SMS sent:', m.sid))
    .catch(e => console.error('SMS error:', e.message));
}

// ── ENDPOINTS ─────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'DumpSite Server v3', reps: REPS.length });
});

// ── TWILIO WEBHOOK — receives order messages ──────────────────
app.post('/order', async (req, res) => {
  try {
    const from = req.body.From || req.body.from || '';
    const body = req.body.Body || req.body.body || '';

    console.log(`[ORDER WEBHOOK] From: ${from} | Body: ${body}`);

    // Only process "New order received" messages
    if(!/new order received/i.test(body)){
      console.log('[WEBHOOK] Not an order message — ignoring');
      res.set('Content-Type', 'text/xml');
      res.send('<Response></Response>');
      return;
    }

    // Parse the order
    const order = parseOrderMessage(body);
    if(!order){
      console.error('[WEBHOOK] Could not parse order');
      res.set('Content-Type', 'text/xml');
      res.send('<Response></Response>');
      return;
    }

    // Find which rep owns this bot number
    const repId = BOT_NUMBER_TO_REP[from] || BOT_NUMBER_TO_REP[TWILIO_FROM] || 'TX-01';
    console.log(`[ORDER] Rep: ${repId} | Customer: ${order.customer_name} | City: ${order.city} | Amount: $${order.amount}`);

    // Insert into Supabase pipeline
    const inserted = await supabaseInsert('pipeline_orders', {
      rep_id:        repId,
      status:        'new',
      city:          order.city,
      product:       order.product,
      amount:        order.amount,
      quantity:      order.quantity,
      customer_name: order.customer_name,
      created_at:    new Date().toISOString()
    });

    console.log('[SUPABASE] Order inserted:', JSON.stringify(inserted));

    // Also store in memory as backup
    if(!pipeline[repId]) pipeline[repId] = [];
    pipeline[repId].unshift({ ...order, rep_id: repId, status: 'new', id: Date.now().toString() });

    // Send confirmation SMS to Micah
    sendSMS(MICAH_PHONE,
      `🚛 New Order!\nRep: ${repId}\nCustomer: ${order.customer_name}\nCity: ${order.city}\n${order.quantity||''} ${order.product}\nAmount: $${order.amount}`
    );

  } catch(e){
    console.error('[WEBHOOK ERROR]', e.message);
  }

  // Always return empty TwiML so Twilio doesn't retry
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// Rep syncs daily stats
app.post('/sync', (req, res) => {
  const { rep_id, date, posts_done, total_slots, cities } = req.body;
  if(!rep_id || !date) return res.status(400).json({ error: 'missing fields' });
  const key = `${rep_id}_${date}`;
  stats[key] = { rep_id, date, posts_done: posts_done||0, total_slots: total_slots||9, cities: cities||'', updated_at: new Date().toISOString() };
  res.json({ ok: true });
});

// Get stats for one rep
app.get('/stats/:repId', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  res.json(stats[`${req.params.repId}_${today}`] || { rep_id: req.params.repId, date: today, posts_done: 0, total_slots: 9 });
});

// Leaderboard
app.get('/leaderboard', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const board = REPS.map(r => {
    const s = stats[`${r.id}_${today}`] || {};
    return { ...r, posts_done: s.posts_done||0, total_slots: s.total_slots||9 };
  }).sort((a,b) => b.posts_done - a.posts_done);
  res.json(board);
});

// Pipeline for one rep — reads from Supabase
app.get('/pipeline/:repId', async (req, res) => {
  try {
    const data = await supabaseQuery('pipeline_orders', { rep_id: req.params.repId });
    res.json({ orders: Array.isArray(data) ? data : [] });
  } catch(e) {
    res.json({ orders: pipeline[req.params.repId] || [] });
  }
});

// Update order status
app.post('/pipeline/:repId/update', async (req, res) => {
  const { order_id, status } = req.body;
  try {
    const updates = { status };
    if(status === 'delivered') updates.delivered_at = new Date().toISOString();

    const result = await fetch(`${SUPABASE_URL}/rest/v1/pipeline_orders?id=eq.${order_id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify(updates)
    });
    res.json({ ok: result.ok });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Summary
app.get('/summary', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  let total_posts=0, active=0;
  REPS.forEach(r => {
    const s = stats[`${r.id}_${today}`] || {};
    total_posts += s.posts_done||0;
    if(s.posts_done > 0) active++;
  });
  res.json({ date: today, total_posts, active_reps: active, total_reps: REPS.length });
});

// ── 9 PM CRON REPORTS ─────────────────────────────────────────
cron.schedule('* * * * *', () => {
  const now = new Date();
  REPS.forEach(rep => {
    try {
      const local = new Date(now.toLocaleString('en-US', { timeZone: rep.tz }));
      if(local.getHours() === 21 && local.getMinutes() === 0){
        const today = local.toISOString().slice(0,10);
        const s = stats[`${rep.id}_${today}`] || {};
        const pct = s.total_slots > 0 ? Math.round((s.posts_done||0)/s.total_slots*100) : 0;
        const msg = `📊 ${rep.name} (${rep.id})\nPosts: ${s.posts_done||0}/${s.total_slots||9} (${pct}%)\nMarket: ${rep.market}`;
        sendSMS(MICAH_PHONE, msg);
        console.log(`[9PM Report] ${rep.name}`);
      }
    } catch(e){ console.error('Cron error:', e.message); }
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DumpSite Server v3 running on port ${PORT}`);
  console.log(`Webhook URL: https://dumpsite-server.onrender.com/order`);
  console.log(`Twilio: ${TWILIO_SID ? 'configured' : 'not configured'}`);
});
