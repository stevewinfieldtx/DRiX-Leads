// dashboard-routes.js — DRiX Vendor Dashboard API
// Mounts at /api/dashboard/* on the main Express app.
// Deps: dashboard-db, the main db (for DRiX Lead runs), crypto for sessions.
const crypto = require('crypto');
const multer = require('multer');
const csvParse = require('csv-parse/sync');

const ddb = require('./dashboard-db');
const drixAuth = require('./drix-auth'); // shared DRiX identity + SSO session cookie

const DASHBOARD_SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET
  || crypto.createHash('sha256').update('drix-dashboard::' + (process.env.OPENROUTER_API_KEY || 'fallback')).digest('hex');

const DASHBOARD_SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// Email config
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const DASHBOARD_FROM_EMAIL = process.env.DASHBOARD_FROM_EMAIL || 'nick@getthedrix.com';
const DASHBOARD_APP_URL = process.env.DASHBOARD_APP_URL || process.env.APP_URL || '';

// ─── SESSION HELPERS ───────────────────────────────────────────────────────────

// Middleware: require a valid central SSO session AND a dashboard profile (role).
// auth.js resolves the central session onto req._drix upstream; we fall back to a
// direct lookup so the dashboard also works if mounted without that middleware.
async function requireDashAuth(req, res, next) {
  let email = req._drix && req._drix.email;
  if (!email) {
    const m = await drixAuth.me(drixAuth.readToken(req));
    email = m && m.user && m.user.email;
  }
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const user = await ddb.getUserByEmail(email);
  if (!user) return res.status(403).json({ error: 'No dashboard access for this account.' });
  req.dashUser = user; // { id, email, name, role, company }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.dashUser) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.dashUser.role)) return res.status(403).json({ error: `Requires ${roles.join(' or ')} role` });
    next();
  };
}

// CSV upload (memory storage, 5MB limit)
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── EMAIL HELPERS ─────────────────────────────────────────────────────────────

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log(`[dashboard] Email skipped (no RESEND_API_KEY): ${to} — ${subject}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: DASHBOARD_FROM_EMAIL, to: [to], subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[dashboard] Email failed: ${data.message || res.status}`);
      return false;
    }
    console.log(`[dashboard] Email sent to ${to}: ${subject}`);
    return true;
  } catch (e) {
    console.error(`[dashboard] Email error: ${e.message}`);
    return false;
  }
}

function generateTempPassword() {
  return crypto.randomBytes(4).toString('hex'); // 8 char hex string
}

// ─── INSTALL ROUTES ────────────────────────────────────────────────────────────

module.exports = function installDashboardRoutes(app, { db, ingestOne, extractPainPoints, brain, normUrl }) {

  // Cookie parser (lightweight, just reads drix_dash_session)
  app.use((req, _res, next) => {
    if (!req.cookies) {
      req.cookies = {};
      const raw = req.headers.cookie || '';
      raw.split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
      });
    }
    next();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════════════════════════════════════

  // POST /api/dashboard/login
  app.post('/api/dashboard/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const r = await drixAuth.login(email, password);
    if (!r.ok) return res.status(401).json({ error: 'Invalid credentials' });
    const user = await ddb.getUserByEmail(email);
    if (!user) return res.status(403).json({ error: 'No dashboard access for this account.' });
    drixAuth.setSessionCookie(res, r.data.session_token); // shared drix_session cookie (SSO)
    res.json({ ok: true, user });
  });

  // POST /api/dashboard/logout
  app.post('/api/dashboard/logout', async (req, res) => {
    try { await drixAuth.logout(drixAuth.readToken(req)); } catch (_) {}
    drixAuth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  // GET /api/dashboard/me — who am I
  app.get('/api/dashboard/me', requireDashAuth, (req, res) => {
    res.json({ user: req.dashUser });
  });

  // POST /api/dashboard/register-vendor — bootstrap: create the first vendor account
  // In production this would be admin-only. For now, open for setup.
  app.post('/api/dashboard/register-vendor', async (req, res) => {
    const { email, password, name, company } = req.body || {};
    if (!email || !password || !name || !company) {
      return res.status(400).json({ error: 'email, password, name, company required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    try {
      const user = await ddb.createUser({ email, password, name, role: 'vendor', company });
      const r = await drixAuth.login(email, password);
      if (r.ok) drixAuth.setSessionCookie(res, r.data.session_token);
      res.json({ ok: true, user });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // CSV UPLOAD + OPPORTUNITY CREATION
  // ══════════════════════════════════════════════════════════════════════════════

  app.post('/api/dashboard/upload-csv', requireDashAuth, requireRole('vendor', 'manager'), csvUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let rows;
    try {
      rows = csvParse.parse(req.file.buffer.toString('utf-8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (e) {
      return res.status(400).json({ error: `CSV parse error: ${e.message}` });
    }

    if (!rows.length) return res.status(400).json({ error: 'CSV is empty' });

    // Validate required columns
    const required = ['customer_name', 'customer_url', 'solution_url', 'partner_company', 'partner_url', 'manager_name', 'manager_email', 'estimated_value', 'lead_source'];
    const headers = Object.keys(rows[0]);
    const missing = required.filter(r => !headers.includes(r));
    if (missing.length) {
      return res.status(400).json({ error: `Missing columns: ${missing.join(', ')}`, expected: required });
    }

    // Validate rows
    const errors = [];
    rows.forEach((row, i) => {
      if (!row.customer_name?.trim()) errors.push(`Row ${i + 1}: missing customer_name`);
      if (!row.customer_url?.trim()) errors.push(`Row ${i + 1}: missing customer_url`);
      if (!row.solution_url?.trim()) errors.push(`Row ${i + 1}: missing solution_url`);
      if (!row.partner_company?.trim()) errors.push(`Row ${i + 1}: missing partner_company`);
      if (!row.partner_url?.trim()) errors.push(`Row ${i + 1}: missing partner_url`);
      if (!row.manager_email?.trim()) errors.push(`Row ${i + 1}: missing manager_email`);
      if (!row.lead_source?.trim()) errors.push(`Row ${i + 1}: missing lead_source`);
    });
    if (errors.length) {
      return res.status(400).json({ error: 'Validation errors', details: errors.slice(0, 10) });
    }

    const createdOpps = [];
    const managersCreated = [];

    for (const row of rows) {
      try {
        // Find or create manager account
        let manager = await ddb.getUserByEmail(row.manager_email.trim());
        if (!manager) {
          const tempPw = generateTempPassword();
          manager = await ddb.createUser({
            email: row.manager_email.trim(),
            password: tempPw,
            name: row.manager_name?.trim() || row.manager_email.split('@')[0],
            role: 'manager',
            company: row.partner_company.trim(),
          });
          managersCreated.push({ email: manager.email, name: manager.name, tempPassword: tempPw });
        }

        // Create opportunity
        const opp = await ddb.createOpportunity({
          customer_name: row.customer_name.trim(),
          customer_url: row.customer_url.trim(),
          solution_url: row.solution_url.trim(),
          partner_company: row.partner_company.trim(),
          partner_url: row.partner_url.trim(),
          estimated_value: parseInt(String(row.estimated_value).replace(/[^0-9]/g, '')) || 0,
          lead_source: row.lead_source?.trim() || 'Vendor Assigned',
          notes: row.notes?.trim() || null,
          vendor_user_id: req.dashUser.role === 'vendor' ? req.dashUser.id : null,
          manager_user_id: manager.id,
        });
        createdOpps.push(opp);
      } catch (e) {
        console.error(`[dashboard] Opp create error for ${row.customer_name}:`, e.message);
        errors.push(`${row.customer_name}: ${e.message}`);
      }
    }

    // Send welcome emails to new managers (fire-and-forget)
    for (const mgr of managersCreated) {
      const loginUrl = DASHBOARD_APP_URL ? `${DASHBOARD_APP_URL}/dashboard/login` : 'the DRiX Dashboard';
      sendEmail(
        mgr.email,
        `You have ${createdOpps.filter(o => o.manager_user_id).length} new opportunities in DRiX`,
        `<p>Hi ${mgr.name},</p>
         <p>You've been assigned opportunities in the DRiX Vendor Dashboard. Log in to review them and assign sales reps.</p>
         <p><strong>Email:</strong> ${mgr.email}<br>
         <strong>Temporary password:</strong> ${mgr.tempPassword}</p>
         <p>${loginUrl ? `<a href="${loginUrl}">Log in to DRiX Dashboard</a>` : 'Log in to the DRiX Dashboard'}</p>
         <p>— DRiX by WinTech Partners</p>`
      );
    }

    // Kick off DRiX Lead processing for each opp (background, non-blocking)
    for (const opp of createdOpps) {
      processDrixLead(opp, { ingestOne, extractPainPoints, brain, normUrl }).catch(e => {
        console.error(`[dashboard] DRiX Lead failed for opp ${opp.id} (${opp.customer_name}):`, e.message);
        ddb.updateOppDrixFailed(opp.id, e.message);
      });
    }

    res.json({
      ok: true,
      created: createdOpps.length,
      managers_created: managersCreated.length,
      errors: errors.length ? errors : undefined,
      opportunities: createdOpps.map(o => ({ id: o.id, customer_name: o.customer_name, status: o.status })),
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // DASHBOARD QUERIES
  // ══════════════════════════════════════════════════════════════════════════════

  // GET /api/dashboard/opportunities — role-filtered list
  app.get('/api/dashboard/opportunities', requireDashAuth, async (req, res) => {
    try {
      const opps = await ddb.getOpportunities(req.dashUser);
      // Strip heavy JSONB from list view
      const lite = opps.map(o => ({
        id: o.id,
        customer_name: o.customer_name,
        customer_url: o.customer_url,
        solution_url: o.solution_url,
        partner_company: o.partner_company,
        estimated_value: o.estimated_value,
        lead_source: o.lead_source,
        status: o.status,
        manager_name: o.manager_name,
        manager_email: o.manager_email,
        rep_name: o.rep_name,
        rep_email: o.rep_email,
        chosen_strategy_title: o.chosen_strategy_title,
        created_at: o.created_at,
        assigned_at: o.assigned_at,
        last_accessed_at: o.last_accessed_at,
        view_count: o.view_count,
        tools_used_count: o.tools_used_count,
        notes: o.notes,
      }));
      res.json({ opportunities: lite });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/dashboard/stats — summary counts + values by status
  app.get('/api/dashboard/stats', requireDashAuth, async (req, res) => {
    try {
      const stats = await ddb.getStats(req.dashUser);
      res.json({ stats });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/dashboard/opp/:id — full opportunity detail (with DRiX result)
  app.get('/api/dashboard/opp/:id', requireDashAuth, async (req, res) => {
    try {
      const opp = await ddb.getOpportunityById(parseInt(req.params.id));
      if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
      if (!ddb.userCanAccess(req.dashUser, opp)) return res.status(403).json({ error: 'Access denied' });

      // Log access
      ddb.recordAccess(opp.id, req.dashUser.id, 'viewed').catch(() => {});

      // If rep is viewing strategies for first time, move to reviewing
      if (req.dashUser.role === 'rep' && opp.status === 'assigned') {
        ddb.updateOppStatus(opp.id, 'reviewing').catch(() => {});
        opp.status = 'reviewing';
      }

      res.json({ opportunity: opp });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ══════════════════════════════════════════════════════════════════════════════

  // POST /api/dashboard/opp/:id/assign — manager assigns a rep
  app.post('/api/dashboard/opp/:id/assign', requireDashAuth, requireRole('manager', 'vendor'), async (req, res) => {
    const { rep_name, rep_email } = req.body || {};
    if (!rep_name || !rep_email) return res.status(400).json({ error: 'rep_name and rep_email required' });

    try {
      const opp = await ddb.getOpportunityById(parseInt(req.params.id));
      if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
      if (!ddb.userCanAccess(req.dashUser, opp)) return res.status(403).json({ error: 'Access denied' });

      // Find or create rep
      let rep = await ddb.getUserByEmail(rep_email);
      let tempPw = null;
      if (!rep) {
        tempPw = generateTempPassword();
        rep = await ddb.createUser({
          email: rep_email.trim(),
          password: tempPw,
          name: rep_name.trim(),
          role: 'rep',
          company: opp.partner_company,
        });
      }

      await ddb.assignRep(opp.id, rep.id);
      ddb.recordAccess(opp.id, req.dashUser.id, 'assigned_rep', `Assigned to ${rep.name} (${rep.email})`).catch(() => {});

      // Send welcome/notification email to rep
      const loginUrl = DASHBOARD_APP_URL ? `${DASHBOARD_APP_URL}/dashboard/login` : 'the DRiX Dashboard';
      sendEmail(
        rep.email,
        `New opportunity assigned: ${opp.customer_name}`,
        `<p>Hi ${rep.name},</p>
         <p>You've been assigned a new opportunity in the DRiX Dashboard:</p>
         <p><strong>${opp.customer_name}</strong> — $${(opp.estimated_value || 0).toLocaleString()}</p>
         <p>Intelligence has been built for this opportunity. Log in to review the strategies and select your approach.</p>
         ${tempPw ? `<p><strong>Email:</strong> ${rep.email}<br><strong>Temporary password:</strong> ${tempPw}</p>` : ''}
         <p>${loginUrl ? `<a href="${loginUrl}">Log in to DRiX Dashboard</a>` : 'Log in to the DRiX Dashboard'}</p>
         <p>— DRiX by WinTech Partners</p>`
      );

      res.json({ ok: true, rep: { id: rep.id, name: rep.name, email: rep.email } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/dashboard/opp/:id/select-strategy — rep picks a strategy, triggers hydration
  app.post('/api/dashboard/opp/:id/select-strategy', requireDashAuth, async (req, res) => {
    const { strategy_id } = req.body || {};
    if (!strategy_id) return res.status(400).json({ error: 'strategy_id required' });

    try {
      const opp = await ddb.getOpportunityById(parseInt(req.params.id));
      if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
      if (!ddb.userCanAccess(req.dashUser, opp)) return res.status(403).json({ error: 'Access denied' });

      const drixResult = opp.drix_result || {};
      const strategies = drixResult.strategies?.strategies || [];
      const chosen = strategies.find(s => s.id === strategy_id);
      if (!chosen) return res.status(400).json({ error: `Strategy ${strategy_id} not found in this opportunity` });

      // Call the hydration engine (same logic as /api/hydrate but using stored data)
      const run = drixResult;
      const solutionIntel = synthesizeSolutionFromStored(run.solution, run.pain_groups);

      const hydration = await require('./drix-brain').discoveryIntel.generateDiscoveryIntel({
        customer: run.customer,
        solutionIntel,
        painGroups: run.pain_groups,
        chosenStrategy: chosen,
        customerName: opp.customer_name,
        customerWebsite: opp.customer_url,
        industryName: run.customer?.industry || '',
      });

      if (!hydration) throw new Error('Hydration returned no data');

      // Save to opportunity
      await ddb.selectStrategy(opp.id, {
        strategyId: strategy_id,
        strategyTitle: chosen.title,
        hydration_result: hydration,
      });

      ddb.recordAccess(opp.id, req.dashUser.id, 'selected_strategy', chosen.title).catch(() => {});

      res.json({ ok: true, chosen_strategy: chosen, hydration });
    } catch (e) {
      console.error(`[dashboard] Strategy select failed for opp ${req.params.id}:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/dashboard/opp/:id/status — update status (active/won/lost)
  app.post('/api/dashboard/opp/:id/status', requireDashAuth, async (req, res) => {
    const { status } = req.body || {};
    if (!['active', 'won', 'lost'].includes(status)) {
      return res.status(400).json({ error: 'Status must be active, won, or lost' });
    }
    try {
      const opp = await ddb.getOpportunityById(parseInt(req.params.id));
      if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
      if (!ddb.userCanAccess(req.dashUser, opp)) return res.status(403).json({ error: 'Access denied' });

      await ddb.updateOppStatus(opp.id, status);
      ddb.recordAccess(opp.id, req.dashUser.id, 'updated_status', status).catch(() => {});

      res.json({ ok: true, status });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/dashboard/change-password
  app.post('/api/dashboard/change-password', requireDashAuth, async (_req, res) => {
    // Passwords are managed by the central DRiX auth service, which doesn't yet
    // expose a change-password endpoint. Stubbed until it does.
    res.status(503).json({ error: 'Password changes are handled centrally and not available yet.', code: 'CHANGE_PW_UNAVAILABLE' });
  });

  // GET /api/dashboard/reps — manager gets their reps (for assignment dropdown)
  app.get('/api/dashboard/reps', requireDashAuth, requireRole('manager', 'vendor'), async (req, res) => {
    try {
      const reps = await ddb.getRepsByCompany(req.dashUser.company);
      res.json({ reps });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};

// ─── BACKGROUND: DRiX Lead Processing ──────────────────────────────────────────
// Runs ingest + pain + strategies for one opportunity. Called after CSV upload.

async function processDrixLead(opp, { ingestOne, extractPainPoints, brain, normUrl }) {
  const t0 = Date.now();
  console.log(`[dashboard] DRiX Lead starting for opp ${opp.id}: ${opp.customer_name}`);

  try {
    // Parallel ingest: partner (sender), solution, customer
    const [senderRes, solutionRes, customerRes] = await Promise.allSettled([
      ingestOne({ url: normUrl(opp.partner_url), role: 'sender' }),
      ingestOne({ url: normUrl(opp.solution_url), role: 'solution' }),
      ingestOne({ url: normUrl(opp.customer_url), role: 'customer' }),
    ]);

    if (senderRes.status === 'rejected') throw new Error(`Sender ingest failed: ${senderRes.reason.message}`);
    if (solutionRes.status === 'rejected') throw new Error(`Solution ingest failed: ${solutionRes.reason.message}`);
    if (customerRes.status === 'rejected') throw new Error(`Customer ingest failed: ${customerRes.reason.message}`);

    const sender = senderRes.value;
    const solution = solutionRes.value;
    const customer = customerRes.value;

    // Pain points
    const pain_groups = await extractPainPoints(customer, {});

    // Strategies
    const stratInput = JSON.stringify({
      sender: { name: sender.target?.name, summary: sender.summary, atoms: sender.atoms },
      solution: { name: solution.target?.name, summary: solution.summary, atoms: solution.atoms },
      customer: { name: customer.target?.name, summary: customer.summary, atoms: customer.atoms, is_archetype: !!customer.target?.is_archetype },
      individual: null,
      recipient_role: 'Senior executive',
    });
    const strategies = await brain.strategyIntel.generateStrategies(stratInput, { flowMode: 'default' });

    const run_id = `dash_${opp.id}_${Date.now().toString(36)}`;
    const drix_result = {
      sender: { target: sender.target, summary: sender.summary, atoms: sender.atoms, source: sender.source },
      solution: { target: solution.target, summary: solution.summary, atoms: solution.atoms, source: solution.source },
      customer: { target: customer.target, summary: customer.summary, atoms: customer.atoms, source: customer.source },
      pain_groups,
      strategies,
    };

    await ddb.updateOppDrixResult(opp.id, { run_id, drix_result });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[dashboard] DRiX Lead complete for opp ${opp.id}: ${opp.customer_name} (${elapsed}s, ${(sender.atoms?.length || 0) + (solution.atoms?.length || 0) + (customer.atoms?.length || 0)} atoms, ${strategies?.strategies?.length || 0} strategies)`);
  } catch (e) {
    console.error(`[dashboard] DRiX Lead failed for opp ${opp.id}:`, e.message);
    await ddb.updateOppDrixFailed(opp.id, e.message);
  }
}

// Synthesize solution intel from stored atoms (mirrors server.js synthesizeSolutionFromAtoms)
function synthesizeSolutionFromStored(solutionEntry, painGroups) {
  const atoms = solutionEntry?.atoms || [];
  const byType = (t) => atoms.filter(a => a.type === t).map(a => a.claim).filter(Boolean);
  const capabilities = [...byType('product'), ...byType('differentiator')].slice(0, 8);
  const differentiators = byType('differentiator').slice(0, 5);
  const icpClaims = byType('icp');
  const targetMarket = icpClaims.length ? icpClaims.join(' ') : (solutionEntry?.summary || '');
  const pg = painGroups || {};
  const painPointsSolved = [
    ...(pg.company_pain || []),
    ...(pg.subindustry_pain || []),
    ...(pg.industry_pain || []),
  ].map(p => p.title || p.description).filter(Boolean).slice(0, 10);
  return { name: solutionEntry?.target?.name || 'Solution', type: 'Business Software', description: solutionEntry?.summary || '', capabilities, targetMarket, differentiators, painPointsSolved };
}
