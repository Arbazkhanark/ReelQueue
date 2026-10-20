/**
 * Transactional e-mail templates (HTML + plain-text alternative). Table layout and inline CSS only, because mail clients
 * ignore <style>/flexbox. Every dynamic value is HTML-escaped; the link is the only call to action.
 */
export interface RenderedMail { subject: string; text: string; html: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

interface Parts { subject: string; preheader: string; heading: string; intro: string; button: string; link: string; outro: string; expiry: string }

function layout(p: Parts, brand: string): RenderedMail {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f4f5f7;">${esc(p.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:28px 36px 0 36px;font-size:20px;font-weight:700;color:#111827;">${esc(brand)}</td></tr>
<tr><td style="padding:20px 36px 0 36px;font-size:22px;line-height:30px;font-weight:600;color:#111827;">${esc(p.heading)}</td></tr>
<tr><td style="padding:12px 36px 0 36px;font-size:15px;line-height:24px;color:#374151;">${esc(p.intro)}</td></tr>
<tr><td style="padding:24px 36px 0 36px;"><a href="${esc(p.link)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 26px;border-radius:8px;">${esc(p.button)}</a></td></tr>
<tr><td style="padding:20px 36px 0 36px;font-size:13px;line-height:20px;color:#6b7280;">${esc(p.expiry)}</td></tr>
<tr><td style="padding:16px 36px 0 36px;font-size:13px;line-height:20px;color:#6b7280;">If the button does not work, copy and paste this link into your browser:<br><a href="${esc(p.link)}" style="color:#4f46e5;word-break:break-all;">${esc(p.link)}</a></td></tr>
<tr><td style="padding:20px 36px 0 36px;font-size:13px;line-height:20px;color:#6b7280;">${esc(p.outro)}</td></tr>
<tr><td style="padding:24px 36px 28px 36px;"><div style="border-top:1px solid #e5e7eb;padding-top:16px;font-size:12px;line-height:18px;color:#9ca3af;">This is an automated message from ${esc(brand)}. Please do not reply to this e-mail.</div></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${brand}\n\n${p.heading}\n\n${p.intro}\n\n${p.button}: ${p.link}\n\n${p.expiry}\n\n${p.outro}\n\n--\nThis is an automated message from ${brand}. Please do not reply to this e-mail.\n`;
  return { subject: p.subject, text, html };
}

export function verificationMail(link: string, brand = 'ReelQueue'): RenderedMail {
  return layout({ subject: `Verify your email address for ${brand}`, preheader: 'Confirm your email to activate your account.', heading: 'Confirm your email address', intro: `Welcome to ${brand}! Please confirm your email address to activate your account and start scheduling your Reels.`, button: 'Verify email address', link, expiry: 'For your security, this link can be used once and expires soon.', outro: 'If you did not create an account, you can safely ignore this email.' }, brand);
}
export function passwordResetMail(link: string, brand = 'ReelQueue'): RenderedMail {
  return layout({ subject: `Reset your ${brand} password`, preheader: 'Use this link to choose a new password.', heading: 'Reset your password', intro: `We received a request to reset the password for your ${brand} account. Click the button below to choose a new password.`, button: 'Reset password', link, expiry: 'For your security, this link can be used once and expires soon.', outro: 'If you did not request a password reset, you can safely ignore this email; your password will not change.' }, brand);
}
