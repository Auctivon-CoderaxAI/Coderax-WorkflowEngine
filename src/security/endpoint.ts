export function credentialEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Invalid credential endpoint.');
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) {
    throw new Error('Remote credential endpoints require HTTPS.');
  }
  return endpoint;
}
