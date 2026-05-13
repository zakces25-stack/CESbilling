const { Client } = require('pg');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  // Verify admin secret
  const secret = event.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { action } = body;
  const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL });

  try {
    await client.connect();

    // ── CREATE ──
    if (action === 'create') {
      const { username, password, customerId, companyName } = body;

      if (!username || !password || !customerId || !companyName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'All fields required' }) };
      }

      // Check username not already taken
      const existing = await client.query(
        'SELECT id FROM customers WHERE username = $1',
        [username.toLowerCase().trim()]
      );
      if (existing.rows.length > 0) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Username already exists' }) };
      }

      await client.query(
        `INSERT INTO customers (username, password_hash, customer_id, company_name, is_admin)
         VALUES ($1, $2, $3, $4, false)`,
        [username.toLowerCase().trim(), password, customerId.toLowerCase().trim(), companyName.trim()]
      );

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── UPDATE PASSWORD ──
    if (action === 'update_password') {
      const { username, newPassword } = body;
      if (!username || !newPassword) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Username and new password required' }) };
      }

      const result = await client.query(
        'UPDATE customers SET password_hash = $1 WHERE username = $2 AND is_admin = false',
        [newPassword, username.toLowerCase().trim()]
      );

      if (result.rowCount === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Customer not found' }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── DELETE ──
    if (action === 'delete') {
      const { username } = body;
      if (!username) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Username required' }) };
      }

      // Get customer_id first so we can delete their reports too
      const custResult = await client.query(
        'SELECT customer_id FROM customers WHERE username = $1 AND is_admin = false',
        [username.toLowerCase().trim()]
      );

      if (custResult.rows.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Customer not found' }) };
      }

      const customerId = custResult.rows[0].customer_id;

      // Delete reports first (foreign key safety)
      await client.query('DELETE FROM reports WHERE customer_id = $1', [customerId]);
      await client.query('DELETE FROM customers WHERE username = $1', [username.toLowerCase().trim()]);

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Save customer error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  } finally {
    await client.end();
  }
};
