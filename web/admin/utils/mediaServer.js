const axios = require('axios');

const RTMP_SERVER_IP = process.env.RTMP_SERVER_IP || '127.0.0.1';
const RTMP_API_PORT = process.env.RTMP_API_PORT || '9997';
const BASE_URL = `http://${RTMP_SERVER_IP}:${RTMP_API_PORT}`;

/**
 * Kick/disconnect a publisher on MediaMTX
 * @param {string} shortname - The channel shortname
 */
async function kickStream(shortname) {
  if (!shortname) return;
  let baseShortname = shortname;
  const match = shortname.match(/^(.+)_(1|2|3)$/);
  if (match) {
    baseShortname = match[1];
  }
  
  const targetLower = new Set([
    `live/${baseShortname.toLowerCase()}`,
    `live/${baseShortname.toLowerCase()}_2`,
    `live/${baseShortname.toLowerCase()}_3`,
    baseShortname.toLowerCase(),
    `${baseShortname.toLowerCase()}_2`,
    `${baseShortname.toLowerCase()}_3`
  ]);

  let kickedCount = 0;
  let kickedIp = null;

  const extractIp = (remoteAddr) => {
    if (!remoteAddr) return null;
    if (remoteAddr.startsWith('[')) {
      const closeBracketIndex = remoteAddr.indexOf(']');
      if (closeBracketIndex !== -1) {
        return remoteAddr.substring(1, closeBracketIndex);
      }
    }
    return remoteAddr.split(':')[0];
  };

  try {
    // Kick RTMP publishers
    const listUrl = `${BASE_URL}/v3/rtmpconns/list`;
    const response = await axios.get(listUrl, { timeout: 3000 });
    if (response.status === 200 && response.data && response.data.items) {
      for (const item of response.data.items) {
        if (item.state === 'publish' && item.path && targetLower.has(item.path.toLowerCase())) {
          const kickUrl = `${BASE_URL}/v3/rtmpconns/kick/${item.id}`;
          console.log(`[MediaMTX API] Kicking RTMP publisher ${item.id} for path: ${item.path}`);
          try {
            await axios.post(kickUrl);
            kickedCount++;
            kickedIp = extractIp(item.remoteAddr) || kickedIp;
          } catch (kickErr) {
            console.error(`[MediaMTX API] Failed to kick RTMP connection ${item.id}:`, kickErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[MediaMTX API] Error listing RTMP for ${shortname}:`, err.message);
  }

  try {
    // Kick WebRTC/WHIP publishers (browser studio)
    const wcUrl = `${BASE_URL}/v3/webrtcsessions/list`;
    const wcRes = await axios.get(wcUrl, { timeout: 3000 });
    if (wcRes.status === 200 && wcRes.data && wcRes.data.items) {
      for (const item of wcRes.data.items) {
        const path = (item.path || '').toLowerCase();
        if (item.state === 'publish' && path && targetLower.has(path)) {
          const kickUrl = `${BASE_URL}/v3/webrtcsessions/kick/${item.id}`;
          console.log(`[MediaMTX API] Kicking WebRTC publisher ${item.id} for path: ${item.path}`);
          try {
            await axios.post(kickUrl);
            kickedCount++;
            kickedIp = extractIp(item.remoteAddr) || kickedIp;
          } catch (kickErr) {
            console.error(`[MediaMTX API] Failed to kick WebRTC session ${item.id}:`, kickErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[MediaMTX API] Error listing WebRTC for ${shortname}:`, err.message);
  }

  return { kicked: kickedCount > 0, ip: kickedIp };
}

/**
 * Kick every active RTMP/WebRTC publisher whose remoteAddr matches ip.
 */
async function kickConnectionsByIp(ip) {
  if (!ip) return { kicked: 0 };
  const target = String(ip).trim().toLowerCase();
  if (!target) return { kicked: 0 };

  const extractIp = (remoteAddr) => {
    if (!remoteAddr) return null;
    if (remoteAddr.startsWith('[')) {
      const closeBracketIndex = remoteAddr.indexOf(']');
      if (closeBracketIndex !== -1) {
        return remoteAddr.substring(1, closeBracketIndex);
      }
    }
    return remoteAddr.split(':')[0];
  };

  let kickedCount = 0;

  const kickList = async (listUrl, kickPath) => {
    try {
      const response = await axios.get(listUrl, { timeout: 3000 });
      if (!(response.status === 200 && response.data && response.data.items)) return;
      for (const item of response.data.items) {
        if (item.state !== 'publish') continue;
        const connIp = (extractIp(item.remoteAddr) || '').toLowerCase();
        if (!connIp || connIp !== target) continue;
        try {
          await axios.post(`${BASE_URL}${kickPath}/${item.id}`);
          kickedCount++;
          console.log(`[MediaMTX API] Kicked ${kickPath} ${item.id} from IP ${connIp}`);
        } catch (kickErr) {
          console.error(`[MediaMTX API] Failed to kick by IP ${item.id}:`, kickErr.message);
        }
      }
    } catch (err) {
      console.error(`[MediaMTX API] Error listing for IP kick:`, err.message);
    }
  };

  await kickList(`${BASE_URL}/v3/rtmpconns/list`, '/v3/rtmpconns/kick');
  await kickList(`${BASE_URL}/v3/webrtcsessions/list`, '/v3/webrtcsessions/kick');

  return { kicked: kickedCount };
}

/**
 * Kick every active RTMP/WebRTC publisher (global RTMP lockdown).
 */
async function kickAllPublishers() {
  let kickedCount = 0;

  const kickAll = async (listUrl, kickPath) => {
    try {
      const response = await axios.get(listUrl, { timeout: 5000 });
      if (!(response.status === 200 && response.data && response.data.items)) return;
      for (const item of response.data.items) {
        if (item.state !== 'publish') continue;
        try {
          await axios.post(`${BASE_URL}${kickPath}/${item.id}`);
          kickedCount++;
          console.log(`[MediaMTX API] Global kick ${kickPath} ${item.id} path=${item.path || ''}`);
        } catch (kickErr) {
          console.error(`[MediaMTX API] Failed global kick ${item.id}:`, kickErr.message);
        }
      }
    } catch (err) {
      console.error(`[MediaMTX API] Error listing for global kick:`, err.message);
    }
  };

  await kickAll(`${BASE_URL}/v3/rtmpconns/list`, '/v3/rtmpconns/kick');
  await kickAll(`${BASE_URL}/v3/webrtcsessions/list`, '/v3/webrtcsessions/kick');

  return { kicked: kickedCount };
}

/**
 * Check if the MediaMTX server is online
 */
async function isServerAlive() {
  try {
    const url = `${BASE_URL}/v3/paths/list`;
    const response = await axios.get(url, { timeout: 3000 });
    return response.status === 200;
  } catch (err) {
    console.error('[MediaMTX API] Server health check failed:', err.message);
    return false;
  }
}

module.exports = {
  kickStream,
  kickConnectionsByIp,
  kickAllPublishers,
  isServerAlive
};
