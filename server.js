// ═══════════════════════════════════════════════════════════════
// DumpSite.io — Auto-Report Server
// • Receives rep data from dashboards silently throughout the day
// • At 9 PM local time per rep's timezone, fires SMS to Micah
// • Deploy on Render (free tier works)
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const twilio   = require('twilio');
const Database = require('better-sqlite3');
const path     = require('path');
const cron     = require('node-cron');

const app    = express();
const PORT   = process.env.PORT || 3000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(cors());
app.use(express.json());

// ── DATABASE ───────────────────────────────────────────────────
const db = new Database(path.join(process.env.DB_PATH || __dirname, 'dumpsite.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reps (
    rep_id   TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    market   TEXT,
    state    TEXT,
    timezone TEXT DEFAULT 'America/Denver'
  );
  CREATE TABLE IF NOT EXISTS daily_stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rep_id       TEXT NOT NULL,
    date         TEXT NOT NULL,
    posts_done   INTEGER DEFAULT 0,
    total_slots  INTEGER DEFAULT 0,
    leads        INTEGER DEFAULT 0,
    revenue      INTEGER DEFAULT 0,
    commission   INTEGER DEFAULT 0,
    cities       TEXT DEFAULT '',
    reported     INTEGER DEFAULT 0,
    updated_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(rep_id, date)
  );
`);

// ── SEED REPS ──────────────────────────────────────────────────
const seedReps = [
  ['CO-01','CO Rep 1','Denver Metro North','co','America/Denver'],
  ['CO-02','CO Rep 2','Denver Metro West','co','America/Denver'],
  ['CO-03','CO Rep 3','Aurora & East','co','America/Denver'],
  ['CO-04','CO Rep 4','Westminster & NW','co','America/Denver'],
  ['CO-05','CO Rep 5','South Metro','co','America/Denver'],
  ['CO-06','CO Rep 6','Parker & South','co','America/Denver'],
  ['CO-07','CO Rep 7','Boulder County','co','America/Denver'],
  ['CO-08','CO Rep 8','Longmont & North','co','America/Denver'],
  ['CO-09','CO Rep 9','Commerce & NE','co','America/Denver'],
  ['CO-10','CO Rep 10','Foothills & Mtn','co','America/Denver'],
  ['CO-11','CO Rep 11','SE Metro & Rural','co','America/Denver'],
  ['TX-01','TX Rep 1','Dallas Core','tx','America/Chicago'],
  ['TX-02','TX Rep 2','Fort Worth Core','tx','America/Chicago'],
  ['TX-03','TX Rep 3','Arlington & Mids','tx','America/Chicago'],
  ['TX-04','TX Rep 4','Plano & N Dallas','tx','America/Chicago'],
  ['TX-05','TX Rep 5','Irving & Coppell','tx','America/Chicago'],
  ['TX-06','TX Rep 6','Grand Prairie & SW','tx','America/Chicago'],
  ['TX-07','TX Rep 7','McKinney & North','tx','America/Chicago'],
  ['TX-08','TX Rep 8','Lewisville & NW','tx','America/Chicago'],
  ['TX-09','TX Rep 9','Grapevine & Keller','tx','America/Chicago'],
  ['TX-10','TX Rep 10','Mansfield & SE','tx','America/Chicago'],
  ['TX-11','TX Rep 11','East DFW & Outer','tx','America/Chicago'],
];
const upsertRep = db.prepare(`
  INSERT INTO reps (rep_id,name,market,state,timezone) VALUES (?,?,?,?,?)
  ON CONFLICT(rep_id) DO UPDATE SET name=excluded.name, market=excluded.market
`);
seedReps.forEach(r => upsertRep.run(...r));

// ── HELPERS ────────────────────────────────────────────────────
function localDateStr(d) {
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function buildReport(rep, s) {
  const pct  = s.total_slots > 0 ? Math.round(s.posts_done/s.total_slots*100) : 0;
  const fill = Math.round(pct/10);
  const bar  = '█'.repeat(fill)+'░'.repeat(10-fill);
  return [
    `📋 EOD — ${rep.name} (${rep.rep_id})`,
    `📅 ${s.date}`,
    ``,
    `Posts:   ${s.posts_done}/${s.total_slots} [${bar}] ${pct}%`,
    `Leads:   ${s.leads}`,
    `Revenue: $${Number(s.revenue||0).toLocaleString()}`,
    `Comm:    $${Number(s.commission||0).toLocaleString()} (15%)`,
    `Cities:  ${s.cities || rep.market}`,
  ].join('\n');
}

// ── ROUTES ─────────────────────────────────────────────────────

// Dashboard silently POSTs this on every checkbox tick + lead log
app.post('/sync', (req, res) => {
  const { rep_id, date, posts_done, total_slots, leads, revenue, commission, cities } = req.body;
  if (!rep_id || !date) return res.status(400).json({ error:'Missing fields' });
  db.prepare(`
    INSERT INTO daily_stats (rep_id,date,posts_done,total_slots,leads,revenue,commission,cities,updated_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(rep_id,date) DO UPDATE SET
      posts_done=excluded.posts_done, total_slots=excluded.total_slots,
      leads=excluded.leads, revenue=excluded.revenue,
      commission=excluded.commission, cities=excluded.cities,
      updated_at=excluded.updated_at
  `).run(rep_id,date,posts_done||0,total_slots||0,leads||0,revenue||0,commission||0,cities||'');
  res.json({ ok:true });
});

app.get('/stats/:repId', (req, res) => {
  const date = req.query.date || localDateStr(new Date());
  const row  = db.prepare('SELECT * FROM daily_stats WHERE rep_id=? AND date=?').get(req.params.repId, date);
  res.json(row || { rep_id:req.params.repId, date, posts_done:0, leads:0, revenue:0, commission:0 });
});

app.get('/leaderboard', (req, res) => {
  const date = req.query.date || localDateStr(new Date());
  const rows = db.prepare(`
    SELECT r.rep_id,r.name,r.market,
      COALESCE(d.posts_done,0) posts_done, COALESCE(d.total_slots,12) total_slots,
      COALESCE(d.leads,0) leads, COALESCE(d.commission,0) commission
    FROM reps r LEFT JOIN daily_stats d ON d.rep_id=r.rep_id AND d.date=?
    ORDER BY commission DESC, leads DESC
  `).all(date);
  res.json({ date, reps:rows });
});

app.get('/summary', (req, res) => {
  const date = req.query.date || localDateStr(new Date());
  const row  = db.prepare(`
    SELECT COUNT(DISTINCT rep_id) active_reps,
      SUM(posts_done) total_posts, SUM(leads) total_leads,
      SUM(revenue) total_revenue, SUM(commission) total_commission
    FROM daily_stats WHERE date=?
  `).get(date);
  res.json({ date, ...row });
});

app.get('/', (_,res) => res.json({ status:'DumpSite running', time:new Date().toISOString() }));

// ── 9 PM CRON ─────────────────────────────────────────────────
// Checks every minute. Fires when it's 9:00 PM in the rep's timezone.
cron.schedule('* * * * *', async () => {
  const micah = process.env.MICAH_PHONE;
  if (!micah) { console.warn('MICAH_PHONE not set — skipping reports'); return; }

  const reps = db.prepare('SELECT * FROM reps').all();
  const now  = new Date();

  for (const rep of reps) {
    try {
      const tz    = rep.timezone || 'America/Denver';
      const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      if (local.getHours() !== 21 || local.getMinutes() !== 0) continue;

      const dateStr = localDateStr(local);
      const stat    = db.prepare('SELECT * FROM daily_stats WHERE rep_id=? AND date=?').get(rep.rep_id, dateStr);
      if (stat && stat.reported === 1) continue;

      const s   = stat || { date:dateStr, posts_done:0, total_slots:12, leads:0, revenue:0, commission:0, cities:'' };
      const msg = buildReport(rep, s);

      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   micah,
        body: msg,
      });

      db.prepare(`
        INSERT INTO daily_stats (rep_id,date,reported,updated_at) VALUES (?,?,1,datetime('now'))
        ON CONFLICT(rep_id,date) DO UPDATE SET reported=1,updated_at=datetime('now')
      `).run(rep.rep_id, dateStr);

      console.log(`✓ Report sent: ${rep.rep_id} | ${tz}`);
    } catch(err) {
      console.error(`✗ Report failed: ${rep.rep_id}`, err.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  console.log(`Auto-reports: ON | To: ${process.env.MICAH_PHONE || '⚠ MICAH_PHONE not set'}`);
});
