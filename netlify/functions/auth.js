const { Client } = require('pg');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { username, password } = body;
  if (!username || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Username and password required' }) };
  }

  const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL });

  try {
    await client.connect();

    const result = await client.query(
      'SELECT id, username, password_hash, customer_id, company_name, is_admin FROM customers WHERE username = $1',
      [username.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    const user = result.rows[0];

    // Simple password comparison (plain text for now — upgrade to bcrypt when ready)
    if (user.password_hash !== password) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        username:    user.username,
        customerId:  user.customer_id,
        name:        user.company_name,
        isAdmin:     user.is_admin,
      }),
    };
  } catch (err) {
    console.error('Auth error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  } finally {
    await client.end();
  }
};
