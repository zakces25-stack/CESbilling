const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const reportId = event.queryStringParameters && event.queryStringParameters.reportId;
  if (!reportId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'reportId required' }) };
  }

  try {
    const store = getStore('reports', {
      siteID: process.env.NETLIFY_SITE_ID,
      token:  process.env.NETLIFY_API_TOKEN,
    });

    const content = await store.get(reportId);

    if (!content) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Report file not found' }) };
    }

    const base64 = Buffer.from(content).toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ fileContent: base64 }),
    };

  } catch (err) {
    console.error('Get report file error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
