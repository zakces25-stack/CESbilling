const { Client } = require('pg');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const customerId = event.queryStringParameters && event.queryStringParameters.customerId;
  if (!customerId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'customerId required' }) };
  }

  const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL });

  try {
    await client.connect();

    // If admin requesting all reports
    if (customerId === '__admin__') {
      const result = await client.query(`
        SELECT r.id, r.customer_id, c.company_name, r.month, r.year, r.period,
               r.sites, r.issues, r.fail_count, r.warn_count, r.total_net,
               r.uploaded_at, r.has_file
        FROM reports r
        JOIN customers c ON c.customer_id = r.customer_id
        ORDER BY r.year DESC, r.month_num DESC
      `);
      return { statusCode: 200, headers, body: JSON.stringify({ reports: result.rows }) };
    }

    // Customer requesting their own reports
    const result = await client.query(`
      SELECT id, customer_id, month, year, period, sites, issues,
             fail_count, warn_count, total_net, uploaded_at, has_file
      FROM reports
      WHERE customer_id = $1
      ORDER BY year DESC, month_num DESC
    `, [customerId]);

    return { statusCode: 200, headers, body: JSON.stringify({ reports: result.rows }) };

  } catch (err) {
    console.error('Get reports error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  } finally {
    await client.end();
  }
};
