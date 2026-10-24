'use strict';

/**
 * Normalize X-Forwarded-For for a single trusted reverse proxy.
 * Clients can prepend fake IPs; nginx appends the real peer with
 * $proxy_add_x_forwarded_for — so the *last* hop is the real client.
 */
function xffSanitizer(req, res, next) {
  let ipHeader = req.headers['x-forwarded-for'];
  if (ipHeader) {
    if (Array.isArray(ipHeader)) {
      ipHeader = ipHeader.join(',');
    }
    if (typeof ipHeader === 'string') {
      const parts = ipHeader.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) {
        req.headers['x-forwarded-for'] = parts[parts.length - 1];
      }
    }
  }
  next();
}

module.exports = { xffSanitizer };
