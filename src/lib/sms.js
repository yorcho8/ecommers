import "dotenv/config";

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

export function maskPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return "";
  if (normalized.length <= 4) return normalized;
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

export async function sendSmsVerificationCode({ to, code, appName = "Grupo Ortiz" }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  const fromNumber = process.env.TWILIO_FROM_NUMBER || "";

  const destination = normalizePhone(to);
  if (!destination) {
    return { sent: false, reason: "SMS_DESTINATION_INVALID" };
  }

  if (!accountSid || !authToken || !fromNumber) {
    return { sent: false, reason: "SMS_NOT_CONFIGURED" };
  }

  const bodyText = `Codigo de verificacion ${appName}: ${code}. Expira en 15 minutos.`;
  const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const payload = new URLSearchParams({
    To: destination,
    From: fromNumber,
    Body: bodyText,
  });

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "SMS provider error");
      return { sent: false, reason: "SMS_SEND_FAILED", detail };
    }

    return { sent: true, provider: "twilio", to: destination };
  } catch (error) {
    return {
      sent: false,
      reason: "SMS_SEND_FAILED",
      detail: error?.message || "SMS provider error",
    };
  }
}
