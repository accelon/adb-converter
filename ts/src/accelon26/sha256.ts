/** Web Crypto SHA-256；回傳小寫 hex。 */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}
