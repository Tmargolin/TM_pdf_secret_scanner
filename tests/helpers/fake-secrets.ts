// Secret-like values for tests (docs/agents/testing.md → "Secrets in
// committed files"). The only literal secret in the repo is AWS's documented
// example key; any other realistic-looking value is built while the test runs,
// so nothing that could pass for a real credential is ever committed.

/** AWS's documented example access key ID – public, never a real credential. */
export const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';

/** An APP-ID-shaped value that shares nothing with a real APP-ID. */
export const FAKE_APP_ID = '00000000-1111-4222-8333-944455556666';

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * A random AWS-format access key ID (prefix + 16 characters), different on
 * every run – for tests that must hold for any key, not just the example.
 */
export function fakeAwsKeyId(prefix: 'AKIA' | 'ASIA' = 'AKIA'): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return prefix + Array.from(random, (byte) => KEY_ALPHABET[byte % KEY_ALPHABET.length]).join('');
}
