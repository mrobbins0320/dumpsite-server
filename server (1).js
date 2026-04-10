// ═══════════════════════════════════════════════════════════════
// DumpSite.io — Auto-Report Server v2
// Uses in-memory storage (no native compilation needed)
// Deploy on Render free tier
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── IN-MEMORY STORE ───────────────────────────────────────────
const stats    = {}; // { repId_date: { ...data } }
const pipeline = {}; // { repId: [ ...orders ] }

// ── REP ROSTER ────────────────────────────────────────────────
const REPS = [
  { id:'TX-01', name:"Zy'kira",  market:'DFW Core',      state:'tx', tz:'America/Chicago' },
  { id:'TX-02', name:'Arlett',   market:'DFW East/West',  state:'tx', tz:'America/Chicago' },
  { id:'TX-03', name:'Katie',    market:'DFW North',      state:'tx', tz:'America/Chicago' },
  { id:'TX-04', name:'Daniel',   market:'DFW TBD',        state:'tx', tz:'America/Chicago' },
  { id:'CO-01', name:'CO Rep 1', market:'Denver North',   state:'co', tz:'America/Denver'  },
  { id:'CO-02', name:'CO Rep 2', market:'Denver West',    state:'co', tz:'America/Denver'  },
];

const MICAH_PHONE = process.env.MICAH_PHONE || '+13034098337';

// ── TWILIO (optional — only fires if creds are set) ───────────
function sendSMS(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    console.log('[SMS skipped — no Twilio creds]', body);
    return;
  }
  const twilio = require('twilio')(sid, token);
  twilio.messages.create({ to, from, body })
    .then(m => console.log('SMS sent:', m.sid))
    .catch(e => console.error('SMS error:', e.message));
}

// ── ENDPOINTS ─────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'DumpSite Server', reps: REPS.length });
});

// Rep syncs their daily stats
app.post('/sync', (req, res) => {
  const { rep_id, date, posts_done, total_slots, cities, leads, revenue } = req.body;
  if (!rep_id || !date) return res.status(400).json({ error: 'missing rep_id or date' });
  const key = `${rep_id}_${date}`;
  stats[key] = {
    rep_id, date,
    posts_done:  posts_done  || 0,
    total_slots: total_slots || 12,
    cities:      cities      || '',
    leads:       leads       || 0,
    revenue:     revenue     || 0,
    updated_at:  new Date().toISOString()
  };
  res.json({ ok: true });
});

// Get today's stats for one rep
app.get('/stats/:repId', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const key   = `${req.params.repId}_${today}`;
  res.json(stats[key] || { rep_id: req.params.repId, date: today, posts_done: 0, total_slots: 12 });
});

// Leaderboard — all reps today
app.get('/leaderboard', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const board = REPS.map(r => {
    const s = stats[`${r.id}_${today}`] || {};
    return { ...r, posts_done: s.posts_done || 0, total_slots: s.total_slots || 12, leads: s.leads || 0, revenue: s.revenue || 0 };
  }).sort((a, b) => b.posts_done - a.posts_done);
  res.json(board);
});

// Team summary
app.get('/summary', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  let total_posts = 0, total_leads = 0, total_revenue = 0, active = 0;
  REPS.forEach(r => {
    const s = stats[`${r.id}_${today}`] || {};
    total_posts   += s.posts_done || 0;
    total_leads   += s.leads      || 0;
    total_revenue += s.revenue    || 0;
    if (s.posts_done > 0) active++;
  });
  res.json({ date: today, total_posts, total_leads, total_revenue, active_reps: active, total_reps: REPS.length });
});

// Pipeline for one rep
app.get('/pipeline/:repId', (req, res) => {
  res.json({ orders: pipeline[req.params.repId] || [] });
});

// Update pipeline order
app.post('/pipeline/:repId', (req, res) => {
  const { repId } = req.params;
  if (!pipeline[repId]) pipeline[repId] = [];
  const order = { ...req.body, id: Date.now().toString() };
  pipeline[repId].push(order);
  res.json({ ok: true, order });
});

// ── 9 PM CRON REPORTS ─────────────────────────────────────────
// Fires every minute, checks if it's 9 PM for each rep's timezone
cron.schedule('* * * * *', () => {
  const now = new Date();
  REPS.forEach(rep => {
    try {
      const local = new Date(now.toLocaleString('en-US', { timeZone: rep.tz }));
      if (local.getHours() === 21 && local.getMinutes() === 0) {
        const today = local.toISOString().slice(0, 10);
        const key   = `${rep.id}_${today}`;
        const s     = stats[key] || {};
        const pct   = s.total_slots > 0 ? Math.round((s.posts_done || 0) / s.total_slots * 100) : 0;
        const msg   = `📊 ${rep.name} (${rep.id})\n` +
                      `Posts: ${s.posts_done || 0}/${s.total_slots || 12} (${pct}%)\n` +
                      `Leads: ${s.leads || 0} | Revenue: $${s.revenue || 0}\n` +
                      `Market: ${rep.market}`;
        sendSMS(MICAH_PHONE, msg);
        console.log(`[9PM Report] ${rep.name}:`, msg);
      }
    } catch(e) {
      console.error('Cron error for', rep.id, e.message);
    }
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DumpSite Server running on port ${PORT}`);
  console.log(`Reps loaded: ${REPS.length}`);
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured (SMS disabled)'}`);
});
