/**
 * Solana address validation.
 *
 * Strict, allow-list based: the input must be exactly one Base58 string that
 * decodes to 32 bytes. URLs, prompt text, multiple addresses and any other
 * chain's address format are rejected before anything expensive happens.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX: Record<string, number> = Object.fromEntries(
  [...BASE58_ALPHABET].map((c, i) => [c, i] as const),
);

export const MAX_INPUT_LENGTH = 64;

export type AddressRejection =
  | "empty"
  | "too_long"
  | "looks_like_url"
  | "multiple_addresses"
  | "contains_prompt_text"
  | "unsupported_chain"
  | "invalid_base58"
  | "invalid_length";

export type AddressValidation =
  | { ok: true; address: string }
  | { ok: false; code: AddressRejection };

export function decodeBase58(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = BASE58_INDEX[ch];
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1' characters are leading zero bytes.
  for (let i = 0; i < input.length && input[i] === "1"; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/** Ethereum/BSC-style hex address, so the user gets an accurate message. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Bitcoin bech32 and Tron prefixes, both of which are frequently pasted by mistake. */
const OTHER_CHAIN = /^(bc1[0-9a-z]{20,}|T[1-9A-HJ-NP-Za-km-z]{33}|(cosmos|osmo|inj)1[0-9a-z]{20,})$/;

const PROMPT_TEXT = /(ignore|disregard|instruction|system prompt|you are|assistant|pretend|jailbreak|\bprompt\b|<\/?[a-z]|```)/i;

export function validateSolanaAddress(rawInput: string): AddressValidation {
  const input = String(rawInput ?? "").trim();

  if (input.length === 0) return { ok: false, code: "empty" };
  if (input.length > MAX_INPUT_LENGTH) return { ok: false, code: "too_long" };
  if (/[\s ​-‍]/.test(input)) {
    // Any interior whitespace means this is not a bare address. Distinguish the
    // "two addresses" case for a better message.
    const parts = input.split(/[\s,;]+/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => looksBase58Address(p))) {
      return { ok: false, code: "multiple_addresses" };
    }
    if (PROMPT_TEXT.test(input)) return { ok: false, code: "contains_prompt_text" };
    return { ok: false, code: "invalid_base58" };
  }
  if (/[:/?#@]|^www\./i.test(input) || /^[a-z][a-z0-9+.\-]*:/i.test(input)) {
    return { ok: false, code: "looks_like_url" };
  }
  if (input.includes(",") || input.includes(";")) {
    const parts = input.split(/[,;]+/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => looksBase58Address(p))) {
      return { ok: false, code: "multiple_addresses" };
    }
    return { ok: false, code: "invalid_base58" };
  }
  if (EVM_ADDRESS.test(input) || OTHER_CHAIN.test(input)) {
    return { ok: false, code: "unsupported_chain" };
  }
  if (PROMPT_TEXT.test(input)) return { ok: false, code: "contains_prompt_text" };

  if (input.length < 32 || input.length > 44) return { ok: false, code: "invalid_length" };
  const decoded = decodeBase58(input);
  if (!decoded) return { ok: false, code: "invalid_base58" };
  if (decoded.length !== 32) return { ok: false, code: "invalid_length" };

  return { ok: true, address: input };
}

function looksBase58Address(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  const d = decodeBase58(s);
  return d !== null && d.length === 32;
}

/** Solana addresses are case-sensitive; normalization is identity plus trim. */
export function normalizeAddress(address: string): string {
  return address.trim();
}

export const ADDRESS_MESSAGES: Record<AddressRejection, string> = {
  empty: "Paste a Solana token contract address to begin.",
  too_long: "That input is too long. A Solana address is 32-44 characters.",
  looks_like_url: "Paste the contract address itself, not a link.",
  multiple_addresses: "One address at a time, please.",
  contains_prompt_text: "That doesn't look like a contract address.",
  unsupported_chain: "Only Solana addresses are supported right now.",
  invalid_base58: "That isn't a valid Solana address.",
  invalid_length: "That isn't a valid Solana address.",
};
