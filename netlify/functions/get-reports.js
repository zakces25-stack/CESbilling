const { Client } = require('@neondatabase/serverless');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const reportId = event.queryStringParameters && event.queryStringParameters.reportId;
  if (!reportId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'reportId required' }) };

  // 1. Try Blobs first
  try {
    const store = getStore('reports');           // <-- the fix (same as save-report)
    const content = await store.get(reportId);
    if (content) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ fileContent: Buffer.from(content).toString('base64') }),
      };
    }
  } catch (err) {
    console.error('Blob fetch failed, will try DB:', err.message);
  }

  // 2. Fall back to DB column
  const client = new Client({ connectionString: process.env.NETLIFY_DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT file_content FROM reports WHERE id = $1 AND file_content IS NOT NULL',
      [reportId]
    );
    if (result.rows.length === 0 || !result.rows[0].file_content) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Report file not found' }) };
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        fileContent: Buffer.from(result.rows[0].file_content).toString('base64'),
      }),
    };
  } catch (err) {
    console.error('DB fallback fetch failed:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  } finally {
    await client.end();
  }
};
