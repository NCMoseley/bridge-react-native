// Inbound TradersPost email ingest.
//
// TradersPost reports broker-side failures (order rejected at Tradovate after
// the webhook was accepted) only by email. An inbound-mail relay — e.g. a
// Cloudflare Email Worker — POSTs a normalized JSON body to
// POST /email/:userId/:accountId/:secret. These helpers normalize whatever the
// relay sent, gate on the TP sender domain, and extract the fields needed to
// correlate the failure back to a broker_orders row.

export interface InboundEmail {
  from: string;
  subject: string;
  text: string;
  html?: string;
  to?: string;
  receivedAt?: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function nestedString(obj: unknown, ...path: string[]): string | undefined {
  let current = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim().length > 0 ? current.trim() : undefined;
}

// Relays that forward the raw RFC822 message (e.g. the Cloudflare Email Worker
// posts message.raw verbatim) hand us headers + base64/quoted-printable parts.
// Decode out the readable text/plain and text/html bodies so downstream
// extraction sees the same text a parsed provider would have sent.
function decodeMimeParts(raw: string): { text?: string; html?: string } {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd === -1) return {};
  const headerBlock = raw.slice(0, headerEnd);
  if (!/content-type:/i.test(headerBlock) && !/mime-version:/i.test(headerBlock)) return {};

  const out: { text?: string; html?: string } = {};
  const outerBoundary = headerBlock.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  const stack = outerBoundary ? raw.split(`--${outerBoundary}`) : [raw];

  while (stack.length > 0) {
    const part = stack.shift()!;
    const sep = part.search(/\r?\n\r?\n/);
    if (sep === -1) continue;
    const partHeaders = part.slice(0, sep);
    let partBody = part.slice(sep).trim();
    const contentType = (partHeaders.match(/content-type:\s*([^;\r\n]+)/i)?.[1] ?? '')
      .trim()
      .toLowerCase();

    if (contentType.startsWith('multipart/')) {
      const nestedBoundary = partHeaders.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
      if (nestedBoundary) stack.unshift(...partBody.split(`--${nestedBoundary}`));
      continue;
    }

    const encoding = partHeaders.match(/content-transfer-encoding:\s*(\S+)/i)?.[1]?.toLowerCase();
    if (encoding === 'base64') {
      try {
        partBody = Buffer.from(partBody.replace(/\s+/g, ''), 'base64').toString('utf8');
      } catch {
        // leave undecoded
      }
    } else if (encoding === 'quoted-printable') {
      partBody = partBody
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }

    if (!partBody) continue;
    if (contentType.startsWith('text/html')) {
      out.html ??= partBody;
    } else if (!contentType || contentType.startsWith('text/plain')) {
      out.text ??= partBody;
    }
  }
  return out;
}

function mimeHeader(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const head = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  return head.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();
}

// Accepts the JSON contract our relay worker posts plus common field names from
// form-style inbound providers (Mailgun/SendGrid post urlencoded or multipart;
// relays can forward the same fields as JSON).
export function normalizeInboundEmail(body: unknown): InboundEmail | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const rawMessage = firstString(record.raw, record.text, record.TextBody);
  const from = firstString(
    record.from,
    record.From,
    record.sender,
    nestedString(record, 'FromFull', 'Email'),
    nestedString(record, 'envelope', 'from'),
    nestedString(record, 'headers', 'from'),
    nestedString(record, 'headers', 'From'),
    mimeHeader(rawMessage, 'From'),
  );
  const subject = firstString(
    record.subject,
    record.Subject,
    nestedString(record, 'headers', 'subject'),
    nestedString(record, 'headers', 'Subject'),
    mimeHeader(rawMessage, 'Subject'),
  ) ?? '';
  let text = firstString(
    record.text,
    record.TextBody,
    record['body-plain'],
    record['stripped-text'],
    record.plain,
    record.body,
    record.raw,
  );
  let html = firstString(record.html, record.HtmlBody, record['body-html'], record['stripped-html']);
  if (text) {
    const mime = decodeMimeParts(text);
    if (mime.text) text = mime.text;
    if (!html && mime.html) html = mime.html;
  }
  const to = firstString(
    record.to,
    record.To,
    record.recipient,
    nestedString(record, 'envelope', 'to'),
    nestedString(record, 'headers', 'Delivered-To'),
    mimeHeader(rawMessage, 'Delivered-To') ?? mimeHeader(rawMessage, 'To'),
  );
  const receivedAt = firstString(
    record.receivedAt,
    record.date,
    nestedString(record, 'headers', 'date'),
    nestedString(record, 'headers', 'Date'),
  );
  if (!from || !text) return undefined;
  return {
    from,
    subject,
    text,
    ...(html ? { html } : {}),
    ...(to ? { to } : {}),
    ...(receivedAt ? { receivedAt } : {}),
  };
}

export function isTradersPostSender(from: string): boolean {
  const match = from.match(/[a-z0-9._%+-]+@([a-z0-9.-]+)/i);
  const domain = match?.[1]?.toLowerCase();
  return domain === 'traderspost.io' || (domain != null && domain.endsWith('.traderspost.io'));
}

export interface ParsedTradersPostEmail {
  isFailure: boolean;
  errorText: string;
  bracketId?: string;
  tradeId?: string;
  ticker?: string;
  action?: string;
  bracketSide?: 'long' | 'short';
  strategy?: string;
  tpAccount?: string;
}

const FAILURE_PATTERN = /\b(fail\w*|error\w*|reject\w*|declin\w*|unable|not executed|could not|invalid)\b/i;

function extractJsonStringField(source: string, field: string): string | undefined {
  const match = source.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
  return match?.[1];
}

// Futures tickers appear in emails as continuous (MBT1!) or explicit contracts
// (MBTZ5). The trailing lookahead keeps the '!' attached and stops mid-word
// false positives like SELL100.
const TICKER_PATTERN = /\b([A-Z]{1,5}(?:[FGHJKMNQUVXZ]\d{1,2}|\d)!?)(?![A-Z0-9!])/;

function firstMeaningfulLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('>'))
    .slice(0, count)
    .join(' — ');
}

// TP failure emails put the real broker error in an "Error:" block mid-body
// ("Error:\nInvalidPrice: Please check the order price. ..."), past the intro
// lines. Pull that block first; fall back to an exception-style line anywhere.
function extractErrorMessage(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^error\b:?/i.test(trimmed)) {
      const parts = [trimmed.replace(/^error\b:?\s*/i, '')];
      for (let j = i + 1; j < lines.length && parts.join(' ').length < 300; j += 1) {
        const next = lines[j].trim();
        if (!next || /^(payload|details|review)\b/i.test(next)) break;
        parts.push(next);
      }
      const message = parts.filter(Boolean).join(' ');
      if (message) return message;
    }
  }
  return lines
    .map((line) => line.trim())
    .find((line) => /^(?:[A-Z]\w*(?:Error|Exception)|Invalid\w*)\s*:/.test(line));
}

// TP failure mail can arrive HTML-only with the echoed payload entity-escaped
// ("bracketId&quot;: &quot;..."). Decode entities and strip tags so field
// extraction sees plain text regardless of which MIME part carried it.
export function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function parseTradersPostEmail(email: InboundEmail): ParsedTradersPostEmail {
  const source = htmlToText(`${email.subject}\n${email.text}\n${email.html ?? ''}`);
  const isFailure = FAILURE_PATTERN.test(email.subject) || FAILURE_PATTERN.test(email.text);

  const bracketId = extractJsonStringField(source, 'bracketId');
  const tradeId = extractJsonStringField(source, 'tradeId');
  const action = extractJsonStringField(source, 'action');
  const bracketSideRaw = extractJsonStringField(source, 'bracketSide');
  const ticker =
    extractJsonStringField(source, 'ticker')
    ?? (() => {
      const match = source.match(TICKER_PATTERN);
      return match?.[1];
    })();

  const plainText = htmlToText(email.text);

  // "from your strategy Test Account in your account 83" — TP-internal
  // identifiers, logged for context and used for account attribution.
  const strategy = plainText
    .match(/your strategy\s+([^\r\n]+?)(?:\s+in\s+your\s+account|\s*$)/im)?.[1]
    ?.replace(/[.,;:!?]+$/, '');
  const tpAccount = plainText.match(/your account\s+([^\s,.<]+)/i)?.[1];

  const errorMessage = extractErrorMessage(plainText);
  const errorText = [email.subject, errorMessage ?? firstMeaningfulLines(plainText, 3)]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 500);

  return {
    isFailure,
    errorText: errorText || 'TradersPost failure email',
    ...(bracketId ? { bracketId } : {}),
    ...(tradeId ? { tradeId } : {}),
    ...(ticker ? { ticker } : {}),
    ...(action ? { action } : {}),
    ...(bracketSideRaw === 'long' || bracketSideRaw === 'short' ? { bracketSide: bracketSideRaw } : {}),
    ...(strategy ? { strategy } : {}),
    ...(tpAccount ? { tpAccount } : {}),
  };
}
