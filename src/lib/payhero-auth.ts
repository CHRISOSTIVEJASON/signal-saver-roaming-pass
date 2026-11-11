export function getPayHeroAuthHeader(credentials: { api_token?: string; username?: string; password?: string }) {
  const u = (credentials.username || '').trim();
  const p = (credentials.password || '').trim();
  const token = (credentials.api_token || '').trim();

  // If username and password are provided without a separate token, use HTTP Basic auth with username:password
  if (u && p && !token) {
    return `Basic ${btoa(`${u}:${p}`)}`;
  }

  if (token) {
    if (token.toLowerCase().startsWith('basic ')) return token;
    if (token.toLowerCase().startsWith('bearer ')) return token;
    // If it already looks like base64-encoded credentials (min 16 chars, no spaces, valid base64 chars)
    if (/^[A-Za-z0-9+/=]{16,}$/.test(token) && !token.includes(':')) {
      try {
        const decoded = atob(token);
        if (decoded.includes(':') || decoded.length > 5) {
          return `Basic ${token}`;
        }
      } catch {}
    }
    if (token.includes(':')) return `Basic ${btoa(token)}`;
    return `Basic ${btoa(`${token}:`)}`;
  }

  if (u && p) {
    return `Basic ${btoa(`${u}:${p}`)}`;
  }
  return '';
}
