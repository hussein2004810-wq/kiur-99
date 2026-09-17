/**
 * Email service — mirrors Python app/mailer.py.
 * Uses fetch() to call an SMTP relay API (e.g. Resend, Brevo, Mailgun REST API).
 * Note: Cloudflare Workers cannot open raw TCP SMTP connections;
 * we use HTTP-based transactional email APIs instead.
 * If SMTP_HOST is set to "resend", "brevo", or "mailgun", we call those APIs.
 * If SMTP_HOST is not set, emailConfigured() returns false and nothing is sent.
 */

export interface MailerConfig {
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  smtpFromName?: string;
}

export function emailConfigured(config: MailerConfig): boolean {
  return Boolean(config.smtpHost && (config.smtpFrom || config.smtpUser));
}

/**
 * Send email via HTTP API.
 * Supports: Resend (smtpHost="resend"), Brevo (smtpHost="brevo"),
 * Mailgun (smtpHost="{domain}.mailgun.org"), or any compatible REST endpoint.
 */
export async function sendEmail(
  config: MailerConfig,
  to: string,
  subject: string,
  textBody: string,
  htmlBody?: string
): Promise<boolean> {
  if (!emailConfigured(config)) {
    console.warn(`[mailer] email not configured (SMTP_HOST unset) — nothing sent to ${to}`);
    return false;
  }

  const from = config.smtpFrom || config.smtpUser || '';
  const fromName = config.smtpFromName || 'Kiur';
  const fromAddr = fromName ? `${fromName} <${from}>` : from;
  const host = config.smtpHost?.toLowerCase() ?? '';

  try {
    // ── Resend.com ──────────────────────────────────────────────
    if (host === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.smtpPassword}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddr,
          to: [to],
          subject,
          text: textBody,
          ...(htmlBody ? { html: htmlBody } : {}),
        }),
      });
      return res.ok;
    }

    // ── Brevo (Sendinblue) ───────────────────────────────────────
    if (host === 'brevo' || host === 'smtp-relay.brevo.com') {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': config.smtpPassword ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: fromName, email: from },
          to: [{ email: to }],
          subject,
          textContent: textBody,
          ...(htmlBody ? { htmlContent: htmlBody } : {}),
        }),
      });
      return res.ok;
    }

    // ── Mailgun ─────────────────────────────────────────────────
    if (host.includes('mailgun')) {
      const domain = host.replace('smtp.', '').replace('api.', '');
      const form = new FormData();
      form.append('from', fromAddr);
      form.append('to', to);
      form.append('subject', subject);
      form.append('text', textBody);
      if (htmlBody) form.append('html', htmlBody);

      const creds = btoa(`api:${config.smtpPassword}`);
      const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${creds}` },
        body: form,
      });
      return res.ok;
    }

    console.warn(`[mailer] Unknown SMTP_HOST: ${config.smtpHost}. Use 'resend', 'brevo', or a Mailgun domain.`);
    return false;
  } catch (err) {
    console.error(`[mailer] Failed to send email to ${to}:`, err);
    return false;
  }
}

export async function sendPasswordReset(
  config: MailerConfig,
  to: string,
  fullName: string,
  resetUrl: string,
  ttlMinutes: number
): Promise<boolean> {
  const greeting = fullName ? `مرحباً ${fullName}،` : 'مرحباً،';
  const textBody = [
    greeting,
    '',
    'وصلنا طلب لإعادة تعيين كلمة مرور حسابك في Kiur.',
    `افتح هذا الرابط لاختيار كلمة مرور جديدة (صالح لمدة ${ttlMinutes} دقيقة):`,
    '',
    resetUrl,
    '',
    'إذا لم تطلب هذا، تجاهل الرسالة — كلمة مرورك الحالية تبقى كما هي.',
    '',
    '— Kiur',
  ].join('\n');

  const htmlBody = `<!doctype html>
<html lang="ar" dir="rtl">
  <body style="margin:0;padding:24px;background:#EAF0FF;font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#16213A;">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;padding:32px 28px;">
      <div style="font-size:1.2rem;font-weight:700;margin-bottom:18px;">Kiur</div>
      <p style="margin:0 0 14px;line-height:1.9;">${greeting}</p>
      <p style="margin:0 0 22px;line-height:1.9;">
        وصلنا طلب لإعادة تعيين كلمة مرور حسابك. اضغط الزر لاختيار كلمة مرور جديدة —
        الرابط صالح لمدة ${ttlMinutes} دقيقة.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${resetUrl}"
           style="display:inline-block;background:#4C5FE0;color:#fff;text-decoration:none;
                  padding:13px 26px;border-radius:999px;font-weight:700;">
          تعيين كلمة مرور جديدة
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:.85rem;color:#4A5578;line-height:1.9;">
        إذا لم تطلب هذا، تجاهل الرسالة — كلمة مرورك الحالية تبقى كما هي.
      </p>
      <p style="margin:0;font-size:.75rem;color:#7E88AC;word-break:break-all;">
        أو انسخ هذا الرابط: ${resetUrl}
      </p>
    </div>
  </body>
</html>`;

  return sendEmail(config, to, 'إعادة تعيين كلمة المرور — Kiur', textBody, htmlBody);
}
