const tokenPattern = /[A-Za-z0-9_-]{20,}/g;
const authorizationPattern = /(Authorization\s*:\s*Bearer\s+)([^\s,;"'}]+)/gi;
const cookiePattern = /((?:Cookie|Set-Cookie)\s*:\s*)([^,\n\r]+)/gi;
const apiKeyPattern = /((?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OBJECT_STORAGE_SECRET_ACCESS_KEY|OBJECT_STORAGE_ACCESS_KEY_ID|CODEX_[A-Z_]*TOKEN)\s*[=:]\s*)([^\s,;"'}]+)/gi;
const credentialUrlPattern = /\b(postgresql|postgres|redis):\/\/([^@\s]+)@([^\s"'<>]+)/gi;

export const redactString = (input: string) => {
  let output = input
    .replace(authorizationPattern, "$1[REDACTED]")
    .replace(cookiePattern, "$1[REDACTED]")
    .replace(apiKeyPattern, "$1[REDACTED]")
    .replace(credentialUrlPattern, (_match, protocol: string, _credentials: string, rest: string) => `${protocol}://[REDACTED]@${rest}`);

  output = output.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const parsed = new URL(url);
      const signedKeys = ["X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token", "Expires", "Signature"];
      if (signedKeys.some((key) => parsed.searchParams.has(key))) {
        return `${parsed.origin}${parsed.pathname}?signature=[REDACTED]`;
      }
      return url;
    } catch {
      return url;
    }
  });

  return output.replace(tokenPattern, (match) => (/\d/.test(match) ? `${match.slice(0, 4)}...[REDACTED]` : match));
};

export const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (/authorization|cookie|token|secret|password|api[_-]?key/i.test(key)) return [key, "[REDACTED]"];
        return [key, redactValue(item)];
      }),
    );
  }
  return value;
};

export const redactAndTruncate = (value: unknown, maxLength = 4096) => {
  const redacted = typeof value === "string" ? redactString(value) : JSON.stringify(redactValue(value));
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
};

export const containsUnredactedSecret = (serialized: string, secrets: string[]) => secrets.some((secret) => secret.length > 0 && serialized.includes(secret));
