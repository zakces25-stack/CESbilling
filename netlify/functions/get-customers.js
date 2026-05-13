const { Client } = require('pg');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  // Verify admin secret
  const secret = event.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL });

  try {
    await client.connect();

    const result = await client.query(`
      SELECT
        c.id, c.username, c.password_hash, c.customer_id,
        c.company_name, c.is_admin, c.created_at,
        COUNT(r.id) AS report_count
      FROM customers c
      LEFT JOIN reports r ON r.customer_id = c.customer_id
      WHERE c.is_admin = false
      GROUP BY c.id, c.username, c.password_hash, c.customer_id, c.company_name, c.is_admin, c.created_at
      ORDER BY c.company_name ASC
    `);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ customers: result.rows }),
    };
  } catch (err) {
    console.error('Get customers error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  } finally {
    await client.end();
  }
};
