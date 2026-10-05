// Finds and masks secrets and personal details.
// Patterns adapted from Nate Herk's Recording Mode (MIT licence):
// https://github.com/nateherkai/claude-code-mods

const DOTS = '••••••••'

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|live-|test-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:hf|r8|pk_live|sk_live|rk_live|whsec|pat|key)_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]

// NAME=value or "name": "value" where the name looks like a credential
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTH)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*["']?)([^\s"'`,;}{]{6,})/gi

// "my password is X", "ο κωδικός μου είναι X"
const PHRASE =
  /(?<!\p{L})((?:password|passcode|passphrase|pin|κωδικ[όο]ς(?: πρόσβασης)?|συνθηματικ[όο])(?:\s+(?:μου|is|my))?\s*(?:is|είναι|ειναι|=|:)\s*["']?)([^\s"']{4,})/giu

const CARD = /(?<![\w-])(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d{2,4}){3,4}(?![\w-])/g
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const PHONE = /(?<![\w.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/g
const PHONE_INTL = /(?<![\w.])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?![\w.])/g

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

function isCard(match: string): boolean {
  const digits = match.replace(/\D/g, '')
  return digits.length >= 13 && digits.length <= 19 && luhn(digits)
}

/** What kinds of secret a message holds: passwords, keys, card or bank numbers. */
export function findSecrets(text: string): string[] {
  const kinds = new Set<string>()
  if (SECRET_PATTERNS.some(re => new RegExp(re.source, re.flags).test(text))) kinds.add('a key or token')
  if (new RegExp(ASSIGNMENT.source, ASSIGNMENT.flags).test(text)) kinds.add('a password or key')
  if (new RegExp(PHRASE.source, PHRASE.flags).test(text)) kinds.add('a password')
  if ((text.match(CARD) ?? []).some(isCard)) kinds.add('a card number')
  if (new RegExp(IBAN.source, IBAN.flags).test(text)) kinds.add('a bank account number')

  return [...kinds]
}

/** Masks secrets and personal details for the screen; what Claude reads is unchanged. */
export function maskPrivate(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, DOTS)
  out = out.replace(ASSIGNMENT, (_, name: string, sep: string) => name + sep + DOTS)
  out = out.replace(PHRASE, (_, head: string) => head + DOTS)
  out = out.replace(CARD, match => (isCard(match) ? '•••• •••• •••• ••••' : match))
  out = out.replace(IBAN, '•••')
  out = out.replace(EMAIL, '•••@•••')
  out = out.replace(PHONE, '•••-•••-••••')
  out = out.replace(PHONE_INTL, '+•• •••')

  return out
}
