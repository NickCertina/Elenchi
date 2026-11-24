const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function issueSessionCookieValue(secret: string, existingSessionId?: string): Promise<{
  sessionId: string;
  cookieValue: string;
}> {
  const sessionId = existingSessionId ?? crypto.randomUUID();
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(sessionId)));
  return {
    sessionId,
    cookieValue: `${sessionId}.${toBase64Url(sig)}`,
  };
}

export async function verifySessionCookieValue(
  cookieHeader: string | null,
  secret: string
): Promise<string | null> {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)elenchi_sid=([^;]+)/);
  if (!match?.[1]) return null;

  const parts = match[1].trim().split(".");
  if (parts.length !== 2) return null;
  const [sessionId, sigB64] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;

  try {
    const key = await importHmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sigB64),
      encoder.encode(sessionId)
    );
    return ok ? sessionId : null;
  } catch {
    return null;
  }
}

export async function encryptPromptAtRest(plaintext: string, secret: string): Promise<string> {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext))
  );
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

export async function decryptPromptAtRest(blob: string, secret: string): Promise<string | null> {
  try {
    const [ivPart, ctPart] = blob.split(".");
    if (!ivPart || !ctPart) return null;
    const key = await deriveAesKey(secret);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart) },
      key,
      fromBase64Url(ctPart)
    );
    return decoder.decode(plainBuf);
  } catch {
    return null;
  }
}
