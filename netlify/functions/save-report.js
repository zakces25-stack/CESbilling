const { Client } = require('@neondatabase/serverless');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const secret = event.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { customerId, month, year, sites, totalNet, failCount, warnCount, fileContent } = body;

  if (!customerId || !month || !year) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'customerId, month, and year are required' }) };
  }

  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const monthNum  = monthNames.indexOf(month) + 1;
  const shortMon  = month.slice(0, 3);
  const period    = `${shortMon}-${String(year).slice(2)}`;
  const issues    = (parseInt(failCount) || 0) + (parseInt(warnCount) || 0);
  const reportId  = `${customerId}-${shortMon.toLowerCase()}-${String(year).slice(2)}`;

  let hasFile = false;
  if (fileContent) {
    try {
      const store = getStore('reports');
      const htmlContent = Buffer.from(fileContent, 'base64').toString('utf8');
      await store.set(reportId, htmlContent, {
        metadata: { customerId, month, year, period }
      });
      hasFile = true;
    } catch (blobErr) {
      console.error('Blob storage error:', blobErr);
    }
  }

  const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL });

  try {
    await client.connect();

    await client.query(`
      INSERT INTO reports
        (id, customer_id, month, month_num, year, period, sites, issues,
         fail_count, warn_count, total_net, file_content, has_file, uploaded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
      ON CONFLICT (id) DO UPDATE SET
        sites       = EXCLUDED.sites,
        issues      = EXCLUDED.issues,
        fail_count  = EXCLUDED.fail_count,
        warn_count  = EXCLUDED.warn_count,
        total_net   = EXCLUDED.total_net,
        has_file    = EXCLUDED.has_file,
        uploaded_at = NOW()
    `, [
      reportId, customerId, month, monthNum, parseInt(year), period,
      parseInt(sites) || 0, issues,
      parseInt(failCount) || 0, parseInt(warnCount) || 0,
      totalNet || '—', null, hasFile,
    ]);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, reportId, hasFile }) };

  } catch (err) {
    console.error('Save report error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  } finally {
    await client.end();
  }
};
