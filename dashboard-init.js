// dashboard-init.js — Wire the dashboard into the main DRiX server
// Add to server.js:  require('./dashboard-init')(app, { db, ingestOne, extractPainPoints, brain, normUrl });

const ddb = require('./dashboard-db');

module.exports = function initDashboard(app, deps) {
  // Share the same Postgres pool from db.js
  const mainPool = deps.db.getPool();
  if (!mainPool) {
    console.warn('[dashboard] No database pool available — dashboard will not function');
    return;
  }
  ddb.init(mainPool);

  // Init dashboard schema (additive — never touches existing tables)
  ddb.initDashboardSchema().then(() => {
    console.log('[dashboard] Tables ready');
  }).catch(e => {
    console.error('[dashboard] Schema init error:', e.message);
  });

  // Install all /api/dashboard/* routes
  require('./dashboard-routes')(app, deps);

  // Serve dashboard SPA for /dashboard/* paths (React Router handles routing)
  // The dashboard pages are part of the same React build as the main app
  const path = require('path');
  const fs = require('fs');
  const distIndex = path.join(__dirname, 'dist', 'index.html');
  app.get('/dashboard*', (_req, res) => {
    if (fs.existsSync(distIndex)) {
      res.sendFile(distIndex);
    } else {
      res.status(503).send('Dashboard not available — build the client first');
    }
  });

  console.log('[dashboard] Routes mounted at /api/dashboard/*');
};
