// Доставка кода входа BLOOP НА УКАЗАННУЮ ПОЧТУ через SMTP (nodemailer).
//
// Настраивается переменными окружения (любой почтовый SMTP-аккаунт —
// Gmail с паролем приложения, Яндекс, Mail.ru и т. д.):
//
//   BLOOP_SMTP_HOST=smtp.gmail.com
//   BLOOP_SMTP_PORT=465           (опционально; 465 → SSL, 587 → STARTTLS)
//   BLOOP_SMTP_USER=user@gmail.com
//   BLOOP_SMTP_PASS=пароль-приложения
//   BLOOP_SMTP_FROM="BLOOP <no-reply@gmail.com>"   (опционально)
//
// Без SMTP-конфигурации код печатается в консоль сервера — регистрация
// работает на этапе разработки. BLOOP_EMAIL_DEBUG=1 дополнительно
// возвращает код в API-ответе (только для разработки/тестов).
import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.BLOOP_SMTP_HOST || '';
const SMTP_PORT = Number(process.env.BLOOP_SMTP_PORT) || 0;
const SMTP_USER = process.env.BLOOP_SMTP_USER || '';
const SMTP_PASS = process.env.BLOOP_SMTP_PASS || '';
const SMTP_FROM = process.env.BLOOP_SMTP_FROM || '';

/** SMTP настроен и код реально уйдёт письмом. */
export function smtpConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function mailHtml(code) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0e1420;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:440px;margin:0 auto;padding:32px 16px;">
    <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:22px;padding:34px 28px;text-align:center;">
      <div style="font-size:30px;font-weight:800;letter-spacing:4px;background:linear-gradient(135deg,#7aa2ff,#8f6cff);-webkit-background-clip:text;background-clip:text;color:transparent;">BLOOP</div>
      <div style="color:#8d9ab5;font-size:13px;margin:6px 0 22px;">код подтверждения входа</div>
      <div style="display:inline-block;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.14);border-radius:16px;padding:14px 26px;font-size:40px;font-weight:800;letter-spacing:10px;color:#e8ecf5;">${code}</div>
      <div style="color:#8d9ab5;font-size:13px;line-height:1.6;margin-top:22px;">
        Код действует <b style="color:#e8ecf5;">5 минут</b> и работает один раз.<br>
        Никому его не говорите — даже «поддержке BLOOP».
      </div>
      <div style="border-top:1px solid rgba(255,255,255,0.1);margin-top:22px;padding-top:14px;color:#5c6a86;font-size:11px;">
        Если код пришёл не вам — просто игнорируйте это письмо.
      </div>
    </div>
  </div>
</body></html>`;
}

/**
 * Отправляет код на указанный адрес.
 * @returns {Promise<{channel: 'smtp'|'console'}>}
 */
export async function deliverEmailCode(email, code) {
  if (!smtpConfigured()) {
    console.log(`📧 Код входа для ${email}: ${code} (SMTP не настроен — задайте BLOOP_SMTP_*, см. README)`);
    return { channel: 'console' };
  }
  const port = SMTP_PORT || 465;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  try {
    await transporter.sendMail({
      from: SMTP_FROM || `BLOOP <${SMTP_USER}>`,
      to: email,
      subject: `BLOOP — код входа ${code}`,
      text: `BLOOP: код входа ${code}. Действует 5 минут. Никому его не говорите.`,
      html: mailHtml(code),
    });
    console.log(`✅ Код входа для ${email} отправлен письмом через ${SMTP_HOST}`);
    return { channel: 'smtp' };
  } catch (err) {
    console.error(`❌ SMTP ${SMTP_HOST} не смог доставить письмо на ${email}: ${err.message}`);
    console.log(`📧 Fallback — код для ${email}: ${code}`);
    return { channel: 'console' };
  }
}
