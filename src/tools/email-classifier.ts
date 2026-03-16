export interface ClassifiedEmail {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  fromDomain: string;
  subject: string;
  snippet: string;
  date: Date;
  category: EmailCategory;
  priority: "high" | "medium" | "low" | "ignore";
  tags: string[];
}

export type EmailCategory =
  | "needs_reply"
  | "money"
  | "urgent"
  | "shipping"
  | "security"
  | "newsletter"
  | "social"
  | "promotion"
  | "receipt"
  | "automated"
  | "unknown";

const IGNORE_DOMAINS = new Set([
  "linkedin.com", "facebookmail.com", "twitter.com", "x.com",
  "instagram.com", "tiktok.com", "pinterest.com", "reddit.com",
  "quora.com", "medium.com", "substack.com",
  "mailchimp.com", "sendgrid.net", "hubspot.com",
]);

const IGNORE_DOMAIN_PREFIXES = ["marketing.", "promo.", "deals.", "offers.", "news.", "newsletter."];

const RECEIPT_DOMAINS = new Set([
  "amazon.com", "amazon.in", "flipkart.com", "myntra.com",
  "swiggy.in", "zomato.com", "uber.com", "ola.money",
  "netflix.com", "spotify.com", "apple.com", "google.com",
  "paypal.com", "razorpay.com", "paytm.com",
]);

const MONEY_DOMAINS = new Set([
  "stripe.com", "razorpay.com", "paypal.com", "wise.com",
  "bankofamerica.com", "chase.com", "icicibank.com", "hdfcbank.com",
  "sbi.co.in", "axisbank.com",
]);

const PAYMENT_FAILURE_KEYWORDS = [
  "payment failed", "payment declined", "card declined",
  "insufficient funds", "update payment", "action required",
  "subscription cancelled", "account suspended", "past due",
  "invoice due", "payment reminder", "final notice",
];

const NEEDS_REPLY_KEYWORDS = [
  "can you", "could you", "would you", "please review",
  "your thoughts", "what do you think", "need your input",
  "waiting for", "following up", "quick question",
  "let me know", "get back to me", "reply needed",
  "eod", "end of day", "asap", "urgent",
];

const SECURITY_KEYWORDS = [
  "otp", "verification code", "login attempt", "new device",
  "password reset", "security alert", "suspicious activity",
  "two-factor", "2fa", "verify your",
];

const IGNORE_KEYWORDS = [
  "unsubscribe", "view in browser", "email preferences",
  "weekly digest", "daily digest", "newsletter",
  "you might like", "recommended for you", "trending",
  "sale ends", "limited time", "discount code", "% off",
];

export function classifyEmail(
  from: string,
  fromName: string,
  subject: string,
  snippet: string,
  labels: string[]
): { category: EmailCategory; priority: "high" | "medium" | "low" | "ignore"; tags: string[] } {
  const subjectLower = subject.toLowerCase();
  const snippetLower = snippet.toLowerCase();
  const combined = `${subjectLower} ${snippetLower}`;
  const fromLower = from.toLowerCase();
  const tags: string[] = [];

  const domainMatch = from.match(/@([^>]+)/);
  const domain = domainMatch ? domainMatch[1].toLowerCase() : "";

  // 1. Ignore domains
  for (const ignoreDomain of IGNORE_DOMAINS) {
    if (domain.includes(ignoreDomain) || fromLower.includes(ignoreDomain)) {
      if (domain.includes("linkedin")) return { category: "social", priority: "ignore", tags: ["linkedin"] };
      if (domain.includes("facebook")) return { category: "social", priority: "ignore", tags: ["facebook"] };
      if (domain.includes("twitter") || domain.includes("x.com")) return { category: "social", priority: "ignore", tags: ["twitter"] };
      if (domain.includes("instagram")) return { category: "social", priority: "ignore", tags: ["instagram"] };
      if (domain.includes("substack") || domain.includes("medium")) return { category: "newsletter", priority: "ignore", tags: ["blog"] };
      return { category: "promotion", priority: "ignore", tags: ["marketing"] };
    }
  }
  for (const prefix of IGNORE_DOMAIN_PREFIXES) {
    if (domain.startsWith(prefix)) {
      return { category: "promotion", priority: "ignore", tags: ["marketing"] };
    }
  }

  // Check ignore keywords
  for (const keyword of IGNORE_KEYWORDS) {
    if (combined.includes(keyword)) {
      return { category: "promotion", priority: "ignore", tags: ["marketing"] };
    }
  }

  // 2. Payment failures → high
  for (const keyword of PAYMENT_FAILURE_KEYWORDS) {
    if (combined.includes(keyword)) {
      tags.push("payment-issue");
      return { category: "money", priority: "high", tags };
    }
  }

  const isNoReply =
    fromLower.includes("noreply") ||
    fromLower.includes("no-reply") ||
    fromLower.includes("donotreply") ||
    fromLower.includes("notifications@");

  // 3. Needs reply from real people
  if (!isNoReply) {
    for (const keyword of NEEDS_REPLY_KEYWORDS) {
      if (combined.includes(keyword)) {
        tags.push("needs-reply");
        if (combined.includes("urgent") || combined.includes("asap") || combined.includes("eod")) {
          tags.push("urgent");
          return { category: "urgent", priority: "high", tags };
        }
        return { category: "needs_reply", priority: "high", tags };
      }
    }
  }

  // 4. Security alerts
  for (const keyword of SECURITY_KEYWORDS) {
    if (combined.includes(keyword)) {
      tags.push("security");
      return { category: "security", priority: "medium", tags };
    }
  }

  // 5. Money domains (non-failure)
  for (const moneyDomain of MONEY_DOMAINS) {
    if (domain.includes(moneyDomain)) {
      tags.push("financial");
      return { category: "money", priority: "medium", tags };
    }
  }

  // 6. Receipt domains
  for (const receiptDomain of RECEIPT_DOMAINS) {
    if (domain.includes(receiptDomain)) {
      if (combined.includes("shipped") || combined.includes("delivered") || combined.includes("out for delivery")) {
        tags.push("shipping");
        return { category: "shipping", priority: "low", tags };
      }
      tags.push("receipt");
      return { category: "receipt", priority: "ignore", tags };
    }
  }

  // 7. No-reply → automated
  if (isNoReply) {
    return { category: "automated", priority: "ignore", tags: ["automated"] };
  }

  // 8. Shipping keywords
  if (
    combined.includes("shipped") ||
    combined.includes("delivered") ||
    combined.includes("tracking") ||
    combined.includes("out for delivery")
  ) {
    return { category: "shipping", priority: "low", tags: ["shipping"] };
  }

  // 9. Looks like a real person
  const looksLikeRealPerson =
    /^[A-Z][a-z]+ [A-Z][a-z]+/.test(fromName) &&
    !fromName.toLowerCase().includes("team") &&
    !fromName.toLowerCase().includes("support");

  if (looksLikeRealPerson && !isNoReply) {
    return { category: "needs_reply", priority: "medium", tags: ["person"] };
  }

  return { category: "unknown", priority: "low", tags };
}

export function summarizeEmailStats(emails: ClassifiedEmail[]): {
  actionable: ClassifiedEmail[];
  ignored: { category: string; count: number }[];
  summary: string;
} {
  const actionable = emails.filter((e) => e.priority === "high" || e.priority === "medium");

  const ignoredCounts: Record<string, number> = {};
  emails
    .filter((e) => e.priority === "ignore" || e.priority === "low")
    .forEach((e) => {
      ignoredCounts[e.category] = (ignoredCounts[e.category] || 0) + 1;
    });

  const ignored = Object.entries(ignoredCounts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const summary =
    actionable.length === 0
      ? "No emails need your attention right now."
      : `${actionable.length} email${actionable.length !== 1 ? "s" : ""} need${actionable.length === 1 ? "s" : ""} your attention.`;

  return { actionable, ignored, summary };
}
