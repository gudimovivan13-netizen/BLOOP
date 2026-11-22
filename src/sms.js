// Доставка SMS-кода входа BLOOP НА УКАЗАННЫЙ НОМЕР через SMS-шлюз.
//
// Настоящая SMS «из воздуха» не отправляется: оператор не принимает
// сообщения из интернета без посредника-шлюза. Этот слой подключает
// реальных провайдеров — код уходит обычной SMS на номер, который ввёл
// пользователь. Провайдер выбирается переменной BLOOP_SMS_PROVIDER или
// определяется автоматически по заполненным переменным окружения:
//
//   BLOOP_SMS_PROVIDER=smsru    SMS.ru    BLOOP_SMSRU_API_ID
//   BLOOP_SMS_PROVIDER=smsc     SMSC.ru   BLOOP_SMSC_LOGIN, BLOOP_SMSC_PSW
//   BLOOP_SMS_PROVIDER=twilio   Twilio    BLOOP_TWILIO_ACCOUNT_SID, BLOOP_TWILIO_AUTH_TOKEN, BLOOP_TWILIO_FROM
//   BLOOP_SMS_PROVIDER=webhook  свой шлюз BLOOP_SMS_WEBHOOK_URL (POST {phone, code, text})
//
// Если ни один провайдер не настроен — код печатается в консоль сервера:
// регистрация работает на этапе разработки; BLOOP_SMS_DEBUG=1 дополнительно
// вернёт код в API-ответе.
//
// Никаких внешних пакетов: только встроенный fetch (Node 18+).

const SMS_TEXT = (code) => `BLOOP: код ${code}. Никому не говорите. Действует 5 минут.`;

const PROVIDERS = {
  smsru: {
    env: ['BLOOP_SMSRU_API_ID'],
    async send(api, phone, code) {
      const p = new URLSearchParams({ api_id: api.BLOOP_SMSRU_API_ID, to: phone, msg: SMS_TEXT(code), json: 1 });
      const r = await fetch(`https://sms.ru/sms/send?${p}`);
      const j = await r.json();
      const ok = j.status_code === 100 && j.sms?.[phone]?.status_code === 100;
      if (!ok) throw new Error(`SMS.ru: ${j.status_code} ${j.status_text || ''}`);
    },
  },

  smsc: {
    env: ['BLOOP_SMSC_LOGIN', 'BLOOP_SMSC_PSW'],
    async send(api, phone, code) {
      const p = new URLSearchParams({
        login: api.BLOOP_SMSC_LOGIN,
        psw: api.BLOOP_SMSC_PSW,
        phones: phone,
        mes: SMS_TEXT(code),
        fmt: 3, // JSON-ответ
      });
      if (api.BLOOP_SMSC_SENDER) p.set('sender', api.BLOOP_SMSC_SENDER);
      const r = await fetch('https://smsc.ru/sys/send.php', { method: 'POST', body: p });
      const j = await r.json();
      if (j.error) throw new Error(`SMSC: ${j.error} (код ${j.error_code})`);
    },
  },

  twilio: {
    env: ['BLOOP_TWILIO_ACCOUNT_SID', 'BLOOP_TWILIO_AUTH_TOKEN', 'BLOOP_TWILIO_FROM'],
    async send(api, phone, code) {
      const auth = Buffer.from(`${api.BLOOP_TWILIO_ACCOUNT_SID}:${api.BLOOP_TWILIO_AUTH_TOKEN}`).toString('base64');
      const body = new URLSearchParams({ To: phone, From: api.BLOOP_TWILIO_FROM, Body: SMS_TEXT(code) });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${api.BLOOP_TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = await r.json();
      if (!r.ok || !j.sid) throw new Error(`Twilio: HTTP ${r.status} ${j.message || ''}`);
    },
  },

  webhook: {
    env: ['BLOOP_SMS_WEBHOOK_URL'],
    async send(api, phone, code) {
      const r = await fetch(api.BLOOP_SMS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code, text: SMS_TEXT(code) }),
      });
      if (!r.ok) throw new Error(`webhook вернул HTTP ${r.status}`);
    },
  },
};

/** Имя активного провайдера: BLOOP_SMS_PROVIDER либо первый настроенный. */
export function activeProvider() {
  const forced = (process.env.BLOOP_SMS_PROVIDER || '').trim().toLowerCase();
  if (forced) return forced; // задан явно, даже если не настроен — deliverCode честно сообщит об ошибке
  for (const [name, def] of Object.entries(PROVIDERS)) {
    if (def.env.every(k => process.env[k])) return name;
  }
  return 'console';
}

/**
 * Отправляет код активному провайдеру НА УКАЗАННЫЙ НОМЕР.
 * @returns {Promise<{channel: string, provider: string|null}>}
 *   channel: 'sms' (шлюз принял сообщение) | 'console' (не настроен или сбой — код в логе)
 */
export async function deliverCode(phone, code) {
  const provider = activeProvider();

  if (provider !== 'console') {
    const def = PROVIDERS[provider];
    if (!def) {
      console.error(`❌ Неизвестный BLOOP_SMS_PROVIDER=${provider} (варианты: ${Object.keys(PROVIDERS).join(', ')})`);
    } else if (!def.env.every(k => process.env[k])) {
      console.error(`❌ Для ${provider} не заданы переменные: ${def.env.join(', ')} — SMS не уйдёт`);
    } else {
      try {
        await def.send(process.env, phone, code);
        console.log(`✅ SMS-код для ${phone} отправлен через ${provider}`);
        return { channel: 'sms', provider };
      } catch (e) {
        console.error(`❌ ${provider} не смог доставить SMS на ${phone}: ${e.message}`);
      }
    }
    console.log(`📱 Fallback — код для ${phone}: ${code}`);
    return { channel: 'console', provider };
  }

  console.log(`📱 SMS-код для ${phone}: ${code} (SMS-шлюз не настроен — задайте BLOOP_SMS_PROVIDER, см. README)`);
  return { channel: 'console', provider: null };
}
