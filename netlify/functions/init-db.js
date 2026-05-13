const { Client } = require('@neondatabase/serverless');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const secret = event.queryStringParameters && event.queryStringParameters.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL });

  try {
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id           SERIAL PRIMARY KEY,
        username     VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        customer_id  VARCHAR(100) UNIQUE NOT NULL,
        company_name VARCHAR(255) NOT NULL,
        is_admin     BOOLEAN DEFAULT false,
        created_at   TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id           VARCHAR(100) PRIMARY KEY,
        customer_id  VARCHAR(100) NOT NULL,
        month        VARCHAR(20) NOT NULL,
        month_num    INTEGER NOT NULL,
        year         INTEGER NOT NULL,
        period       VARCHAR(20) NOT NULL,
        sites        INTEGER DEFAULT 0,
        issues       INTEGER DEFAULT 0,
        fail_count   INTEGER DEFAULT 0,
        warn_count   INTEGER DEFAULT 0,
        total_net    VARCHAR(50) DEFAULT '—',
        file_content TEXT,
        has_file     BOOLEAN DEFAULT false,
        uploaded_at  TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      INSERT INTO customers (username, password_hash, customer_id, company_name, is_admin)
      VALUES ('admin', 'CESadmin2025!', '__admin__', 'CES Admin', true)
      ON CONFLICT (username) DO NOTHING
    `);

    await client.query(`
      INSERT INTO customers (username, password_hash, customer_id, company_name, is_admin)
      VALUES ('blanktable', 'ces2025!', 'blank-table', 'Blank Table Ltd', false)
      ON CONFLICT (username) DO NOTHING
    `);

    const custCount   = await client.query('SELECT COUNT(*) FROM customers');
    const reportCount = await client.query('SELECT COUNT(*) FROM reports');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:   true,
        message:   'Database initialised successfully',
        customers: parseInt(custCount.rows[0].count),
        reports:   parseInt(reportCount.rows[0].count),
      }),
    };

  } catch (err) {
    console.error('Init DB error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  } finally {
    await client.end();
  }
};
