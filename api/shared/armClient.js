const https = require('https');

/**
 * Make an authenticated REST call to management.azure.com.
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {string} path - Full path including query string (e.g. /subscriptions/...)
 * @param {string} token - Bearer token
 * @param {object|null} [body] - Optional JSON body for POST/PUT
 * @returns {Promise<object>} Parsed JSON response
 */
function armRequest(method, path, token, body) {
  const postData = body ? JSON.stringify(body) : null;

  const options = {
    hostname: 'management.azure.com',
    path: path,
    method: method.toUpperCase(),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (postData) {
    options.headers['Content-Length'] = Buffer.byteLength(postData);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error(`ARM ${method} ${path} returned ${res.statusCode}: ${json.error?.message || data.substring(0, 500)}`);
            err.statusCode = res.statusCode;
            err.body = json;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Failed to parse ARM response: ${e.message} — raw: ${data.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = { armRequest };
