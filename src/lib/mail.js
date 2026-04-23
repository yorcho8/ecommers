import 'dotenv/config';

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return defaultValue;
  return value.toLowerCase() === 'true';
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// ── Output encoding helpers ───────────────────────────────────────────────────
/**
 * Escape characters that have special meaning in HTML.
 * Apply to every user-derived string before interpolating into an HTML template.
 */
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Validate a URL for use in an HTML href attribute.
 * Blocks javascript: URIs and returns an HTML-encoded, safe URL string.
 */
function safeHtmlUrl(str) {
  const url = String(str == null ? '' : str).trim();
  if (!url) return '';
  if (/^javascript:/i.test(url)) return '#';
  return escapeHtml(url);
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = parseBoolean(process.env.SMTP_SECURE, false);
  const user = process.env.SMTP_USER || process.env.BREVO_SMTP_USER;
  const pass = process.env.SMTP_PASS || process.env.BREVO_SMTP_KEY;
  const fromCandidates = [
    process.env.SMTP_FROM,
    process.env.BREVO_FROM_EMAIL,
    process.env.SMTP_USER,
    process.env.BREVO_SMTP_USER,
  ];
  const from = fromCandidates.find((v) => isValidEmail(v)) || null;
  const fromName = process.env.BREVO_FROM_NAME || 'NEXUS';

  return { host, port, secure, user, pass, from, fromName };
}

async function getTransporter() {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.port || !cfg.user || !cfg.pass || !cfg.from) {
    console.error('[mail] SMTP no configurado:', { host: cfg.host, port: cfg.port, user: !!cfg.user, pass: !!cfg.pass, from: cfg.from });
    return { transporter: null, cfg, reason: 'SMTP_NOT_CONFIGURED' };
  }

  let nodemailer;
  try {
    const module = await import('nodemailer');
    nodemailer = module.default || module;
  } catch (error) {
    console.error('[mail] nodemailer no esta instalado:', error);
    return { transporter: null, cfg, reason: 'NODEMAILER_NOT_AVAILABLE' };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass }
  });

  return { transporter, cfg };
}

async function sendViaBrevoApi({ to, subject, html, text, senderName, senderEmail }) {
  const apiKey = process.env.BREVO_API_KEY || '';
  if (!apiKey) return { sent: false, reason: 'BREVO_API_NOT_CONFIGURED' };

  if (!isValidEmail(senderEmail)) {
    return { sent: false, reason: 'SMTP_FROM_INVALID' };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName || 'Nexus', email: senderEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => 'Error API Brevo');
      return { sent: false, reason: 'BREVO_API_SEND_FAILED', detail };
    }

    return { sent: true, provider: 'brevo-api' };
  } catch (error) {
    return { sent: false, reason: 'BREVO_API_SEND_FAILED', detail: error?.message || 'Error API Brevo' };
  }
}

// ── Shared helper ────────────────────────────────────────────
async function sendMail({ to, subject, html, text }) {
  const safeTo = String(to || '').trim().toLowerCase();
  if (!isValidEmail(safeTo)) return { sent: false, reason: 'INVALID_TO_EMAIL' };
  const { transporter, cfg, reason } = await getTransporter();
  const senderConfig = cfg || getSmtpConfig();
  if (!transporter) {
    const fallback = await sendViaBrevoApi({ to: safeTo, subject, html, text, senderName: senderConfig.fromName, senderEmail: senderConfig.from });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || reason || 'SMTP_NOT_CONFIGURED', detail: fallback.detail };
  }
  try {
    await transporter.sendMail({ from: `${cfg.fromName} <${cfg.from}>`, to: safeTo, subject, text, html });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    const fallback = await sendViaBrevoApi({ to: safeTo, subject, html, text, senderName: cfg.fromName, senderEmail: cfg.from });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || 'SMTP_SEND_FAILED', detail: fallback.detail || error?.message };
  }
}

// ── Order Confirmation ────────────────────────────────────────
export async function sendOrderConfirmation({ to, name = '', orderNumber, total, items = [], direccion = '', carrier = '', deliveryEstimate = '' }) {
  const safeItems = Array.isArray(items) ? items : [];
  const itemsHtml = safeItems.map(i => `<tr><td style="padding:4px 8px;">${escapeHtml(i.nombre || 'Producto')}</td><td style="padding:4px 8px;text-align:center;">${Number(i.cantidad)}</td><td style="padding:4px 8px;text-align:right;">$${Number(i.precio || 0).toFixed(2)}</td></tr>`).join('');
  const safeName       = escapeHtml(String(name || 'Cliente').trim());
  const safeOrder      = escapeHtml(String(orderNumber || ''));
  const safeDireccion  = escapeHtml(String(direccion || ''));
  const safeCarrier    = escapeHtml(String(carrier || ''));
  const safeEstimate   = escapeHtml(String(deliveryEstimate || ''));
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;margin:0 0 16px;">¡Pedido confirmado! 🎉</h2>
      <p>Hola <strong>${safeName}</strong>,</p>
      <p>Tu pedido <strong>#${safeOrder}</strong> fue confirmado y está siendo procesado.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <thead><tr style="background:#f4f4f4;"><th style="padding:8px;text-align:left;">Producto</th><th style="padding:8px;">Cant.</th><th style="padding:8px;text-align:right;">Precio</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <p style="font-size:18px;"><strong>Total: $${Number(total || 0).toFixed(2)} MXN</strong></p>
      ${safeDireccion ? `<p><strong>Dirección de entrega:</strong> ${safeDireccion}</p>` : ''}
      ${safeCarrier ? `<p><strong>Carrier:</strong> ${safeCarrier}${safeEstimate ? ` — ${safeEstimate}` : ''}</p>` : ''}
      <p>Recibirás otro correo cuando tu pedido sea enviado con el número de guía.</p>
      <p style="color:#888;font-size:12px;margin-top:24px;">Este es un correo automático, no responder.</p>
    </div>`;
  const text = [`Pedido #${orderNumber} confirmado`, `Total: $${Number(total || 0).toFixed(2)} MXN`, direccion ? `Dirección: ${direccion}` : '', carrier ? `Carrier: ${carrier}` : ''].filter(Boolean).join('\n');
  return sendMail({ to, subject: `Pedido #${orderNumber} confirmado — NEXUS`, html, text });
}

// ── Shipping Notification ─────────────────────────────────────
export async function sendShippingNotification({ to, name = '', orderNumber, guia, carrier = '', trackUrl = '' }) {
  const safeName     = escapeHtml(String(name || 'Cliente').trim());
  const safeOrder    = escapeHtml(String(orderNumber || ''));
  const safeGuia     = escapeHtml(String(guia || ''));
  const safeCarrier  = escapeHtml(String(carrier || ''));
  const safeLinkUrl  = safeHtmlUrl(trackUrl);
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;">¡Tu pedido está en camino! 🚚</h2>
      <p>Hola <strong>${safeName}</strong>,</p>
      <p>Tu pedido <strong>#${safeOrder}</strong> ha sido enviado.</p>
      <ul>
        ${safeCarrier ? `<li><strong>Carrier:</strong> ${safeCarrier}</li>` : ''}
        <li><strong>Número de guía:</strong> ${safeGuia}</li>
        ${safeLinkUrl ? `<li><a href="${safeLinkUrl}" style="color:#FF6B35;">Rastrear mi paquete</a></li>` : ''}
      </ul>
      <p style="color:#888;font-size:12px;margin-top:24px;">Este es un correo automático, no responder.</p>
    </div>`;
  const text = [`Pedido #${orderNumber} enviado`, carrier ? `Carrier: ${carrier}` : '', `Guía: ${guia}`, trackUrl ? `Rastrear: ${trackUrl}` : ''].filter(Boolean).join('\n');
  return sendMail({ to, subject: `Tu pedido #${orderNumber} está en camino — NEXUS`, html, text });
}

// ── Low Stock Alert ───────────────────────────────────────────
export async function sendLowStockAlert({ to, products = [] }) {
  const safeProducts = Array.isArray(products) ? products : [];
  if (!safeProducts.length) return { sent: false, reason: 'NO_PRODUCTS' };
  const itemsHtml = safeProducts.map(p => `<li><strong>${escapeHtml(p.nombre)}</strong> — Stock actual: <strong style="color:#e53e3e;">${Number(p.stock)}</strong></li>`).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#e53e3e;">⚠️ Alerta de stock bajo</h2>
      <p>Los siguientes productos tienen stock crítico:</p>
      <ul>${itemsHtml}</ul>
      <p>Revisa el panel de administración para reponer inventario.</p>
    </div>`;
  const text = `Stock bajo:\n${safeProducts.map(p => `- ${p.nombre}: ${p.stock} unidades`).join('\n')}`;
  return sendMail({ to, subject: '⚠️ Alerta stock bajo — NEXUS', html, text });
}

// ── Nueva Empresa Solicitud (a superusuarios) ─────────────────
export async function sendNewEmpresaSolicitudAlert({ to, reviewerName = 'Superusuario', empresaNombre, adminNombre, adminCorreo }) {
  const safeReviewer = escapeHtml(String(reviewerName || 'Superusuario').trim());
  const safeEmpresa  = escapeHtml(String(empresaNombre || '').trim());
  const safeAdmin    = escapeHtml(String(adminNombre || '').trim());
  const safeCorreo   = escapeHtml(String(adminCorreo || '').trim());
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;">Nueva solicitud de empresa</h2>
      <p>Hola <strong>${safeReviewer}</strong>,</p>
      <p>Se recibió una nueva solicitud de registro de empresa.</p>
      <ul>
        <li><strong>Empresa:</strong> ${safeEmpresa}</li>
        <li><strong>Representante:</strong> ${safeAdmin}</li>
        <li><strong>Correo:</strong> ${safeCorreo}</li>
      </ul>
      <p>Revisa el panel de administración para aprobar o rechazar.</p>
    </div>`;
  const text = `Nueva solicitud de empresa: ${empresaNombre}\nRepresentante: ${adminNombre} (${adminCorreo})\nRevisa el panel de administración.`;
  return sendMail({ to, subject: `Nueva solicitud de empresa: ${empresaNombre} — NEXUS`, html, text });
}

// ── Nueva Empresa Registrada directamente (a superusuarios) ──
export async function sendNewEmpresaRegistradaAlert({ to, reviewerName = 'Superusuario', empresaNombre, adminNombre, adminCorreo, empresaId }) {
  const safeReviewer = escapeHtml(String(reviewerName || 'Superusuario').trim());
  const safeEmpresa  = escapeHtml(String(empresaNombre || '').trim());
  const safeAdmin    = escapeHtml(String(adminNombre || '').trim());
  const safeCorreo   = escapeHtml(String(adminCorreo || '').trim());
  const safeId       = Number(empresaId || 0);
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;">Empresa registrada en el sistema</h2>
      <p>Hola <strong>${safeReviewer}</strong>,</p>
      <p>Se registró una nueva empresa directamente en el sistema.</p>
      <ul>
        <li><strong>Empresa:</strong> ${safeEmpresa} (ID: ${safeId})</li>
        <li><strong>Representante:</strong> ${safeAdmin}</li>
        <li><strong>Correo:</strong> ${safeCorreo}</li>
      </ul>
    </div>`;
  const text = `Empresa registrada: ${empresaNombre} (ID: ${empresaId})\nRepresentante: ${adminNombre} (${adminCorreo})`;
  return sendMail({ to, subject: `Empresa registrada: ${empresaNombre} — NEXUS`, html, text });
}

// ── Nueva Categoría Creada (a superusuarios) ──────────────────
export async function sendNewCategoriaAlert({ to, reviewerName = 'Superusuario', categoriaNombre, creadoPor }) {
  const safeReviewer  = escapeHtml(String(reviewerName || 'Superusuario').trim());
  const safeCategoria = escapeHtml(String(categoriaNombre || '').trim());
  const safeCreadoPor = escapeHtml(String(creadoPor || 'Admin').trim());
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;">Nueva categoría creada</h2>
      <p>Hola <strong>${safeReviewer}</strong>,</p>
      <p>El usuario <strong>${safeCreadoPor}</strong> creó la categoría <strong>${safeCategoria}</strong>.</p>
      <p>Revisa el panel de administración si requiere ajustes.</p>
    </div>`;
  const text = `Nueva categoría: "${categoriaNombre}" creada por ${creadoPor}.`;
  return sendMail({ to, subject: `Nueva categoría: ${categoriaNombre} — NEXUS`, html, text });
}

// ── Password Reset ────────────────────────────────────────────
export async function sendPasswordResetCode({ to, code, name = '' }) {
  const cfg = getSmtpConfig();

  if (!cfg.host || !cfg.port || !cfg.user || !cfg.pass || !cfg.from) {
    console.error('[mail] SMTP no configurado. Variables recibidas:', {
      host: cfg.host, port: cfg.port,
      user: !!cfg.user, pass: !!cfg.pass, from: cfg.from
    });
    return { sent: false, reason: 'SMTP_NOT_CONFIGURED', detail: 'Faltan variables de entorno SMTP' };
  }

  let nodemailer;
  try {
    const module = await import('nodemailer');
    nodemailer = module.default || module;
  } catch (error) {
    console.error('[mail] nodemailer no esta instalado:', error);
    return { sent: false, reason: 'NODEMAILER_NOT_AVAILABLE' };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass }
  });

  const safeName    = name ? String(name).trim() : '';
  const greeting    = safeName ? `Hola ${escapeHtml(safeName)},` : 'Hola,';

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px;">Recuperacion de contrasena</h2>
      <p>${greeting}</p>
      <p>Recibimos una solicitud para restablecer tu contrasena en Nexus.</p>
      <p>Tu codigo de verificacion es:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:10px 0 16px;">${code}</p>
      <p>Este codigo expira en 15 minutos.</p>
      <p>Si no solicitaste este cambio, ignora este correo.</p>
    </div>
  `;

  const text = [
    'Recuperacion de contrasena - Nexus', '',

    greeting,
    'Recibimos una solicitud para restablecer tu contrasena en Nexus.',
    `Codigo de verificacion: ${code}`,
    'Este codigo expira en 15 minutos.',
    'Si no solicitaste este cambio, ignora este correo.'
  ].join('\n');

  try {
    await transporter.sendMail({
      from: `${cfg.fromName} <${cfg.from}>`,
      to,
      subject: 'Codigo de recuperacion de contrasena',
      text,
      html,
    });
    return { sent: true };
  } catch (error) {
    console.error('[mail] Error enviando correo SMTP:', error);
    return { sent: false, reason: 'SMTP_SEND_FAILED', detail: error?.message || 'Error SMTP desconocido' };
  }
}

// ── Aprobación de empresa ─────────────────────────────────────
export async function sendCompanyApprovalCredentials({
  to, empresa, nombre, correo, password, loginUrl,
}) {
  const { transporter, cfg, reason } = await getTransporter();

  const safeName    = nombre ? String(nombre).trim() : 'Usuario';
  const safeEmpresa = String(empresa || 'Tu empresa');
  const safeLoginUrl = String(loginUrl || process.env.APP_URL || '').trim();
  const safeNameHtml    = escapeHtml(safeName);
  const safeEmpresaHtml = escapeHtml(safeEmpresa);
  const safeCorreoHtml  = escapeHtml(String(correo || ''));
  const safePassHtml    = escapeHtml(String(password || ''));
  const safeLinkHtml    = safeHtmlUrl(safeLoginUrl);

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px;">Solicitud aprobada - Nexus</h2>
      <p>Hola ${safeNameHtml},</p>
      <p>Tu solicitud para la empresa <strong>${safeEmpresaHtml}</strong> fue aprobada.</p>
      <p>Estas son tus credenciales de acceso:</p>
      <ul>
        <li><strong>Correo:</strong> ${safeCorreoHtml}</li>
        <li><strong>Contrasena temporal:</strong> ${safePassHtml}</li>
      </ul>
      ${safeLinkHtml ? `<p><a href="${safeLinkHtml}">Ingresar a la plataforma</a></p>` : ''}
      <p>Por seguridad, te recomendamos cambiar tu contrasena despues de iniciar sesion.</p>
    </div>
  `;

  const text = [
    'Solicitud aprobada - Nexus', '',
    `Hola ${safeName},`,
    `Tu solicitud para la empresa ${safeEmpresa} fue aprobada.`,
    '',
    `Correo: ${correo}`,
    `Contrasena temporal: ${password}`,
    safeLoginUrl ? `Acceso: ${safeLoginUrl}` : '',
    '',
    'Te recomendamos cambiar tu contrasena despues de iniciar sesion.',
  ].filter(Boolean).join('\n');

  const senderConfig = cfg || getSmtpConfig();

  if (!transporter) {
    const fallback = await sendViaBrevoApi({
      to,
      subject: 'Tu empresa fue aprobada - Credenciales de acceso',
      html,
      text,
      senderName: senderConfig.fromName,
      senderEmail: senderConfig.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || reason || 'SMTP_NOT_CONFIGURED', detail: fallback.detail };
  }

  try {
    await transporter.sendMail({
      from: `${cfg.fromName} <${cfg.from}>`,
      to,
      subject: 'Tu empresa fue aprobada - Credenciales de acceso',
      text,
      html,
    });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    console.error('[mail] Error enviando correo de aprobacion:', error);
    const fallback = await sendViaBrevoApi({
      to,
      subject: 'Tu empresa fue aprobada - Credenciales de acceso',
      html,
      text,
      senderName: cfg.fromName,
      senderEmail: cfg.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || 'SMTP_SEND_FAILED', detail: fallback.detail || error?.message };
  }
}

export async function sendUserAccountCredentials({
  to,
  nombre,
  correo,
  password,
  rol = 'usuario',
  loginUrl,
}) {
  const { transporter, cfg, reason } = await getTransporter();
  const safeTo = String(to || '').trim().toLowerCase();
  if (!isValidEmail(safeTo)) {
    return { sent: false, reason: 'INVALID_TO_EMAIL' };
  }

  const safeName    = String(nombre || '').trim() || 'Usuario';
  const safeCorreo  = String(correo || safeTo).trim().toLowerCase();
  const safePassword = String(password || '').trim();
  const safeRol     = String(rol || 'usuario').trim().toLowerCase();
  const safeLoginUrl = String(loginUrl || process.env.APP_URL || '').trim();

  const subject = 'Tu cuenta fue creada - Credenciales de acceso';
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px;">Bienvenido a Nexus</h2>
      <p>Hola ${escapeHtml(safeName)},</p>
      <p>Se creo una cuenta para ti con rol <strong>${escapeHtml(safeRol)}</strong>.</p>
      <p>Tus credenciales de acceso son:</p>
      <ul>
        <li><strong>Correo:</strong> ${escapeHtml(safeCorreo)}</li>
        <li><strong>Contrasena temporal:</strong> ${escapeHtml(safePassword)}</li>
      </ul>
      ${safeLoginUrl ? `<p><a href="${safeHtmlUrl(safeLoginUrl)}">Ingresar a la plataforma</a></p>` : ''}
      <p>Por seguridad, te recomendamos cambiar la contrasena despues del primer inicio de sesion.</p>
    </div>
  `;

  const text = [
    'Tu cuenta fue creada - Nexus',
    '',
    `Hola ${safeName},`,
    `Se creo una cuenta para ti con rol ${safeRol}.`,
    '',
    `Correo: ${safeCorreo}`,
    `Contrasena temporal: ${safePassword}`,
    safeLoginUrl ? `Acceso: ${safeLoginUrl}` : '',
    '',
    'Te recomendamos cambiar la contrasena despues de iniciar sesion.',
  ].filter(Boolean).join('\n');

  const senderConfig = cfg || getSmtpConfig();

  if (!transporter) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: senderConfig.fromName,
      senderEmail: senderConfig.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || reason || 'SMTP_NOT_CONFIGURED', detail: fallback.detail };
  }

  try {
    await transporter.sendMail({
      from: `${cfg.fromName} <${cfg.from}>`,
      to: safeTo,
      subject,
      text,
      html,
    });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: cfg.fromName,
      senderEmail: cfg.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || 'SMTP_SEND_FAILED', detail: fallback.detail || error?.message };
  }
}

// ── Notificación de cambio de estado de pedido ───────────────
export async function sendOrderStatusNotification({ to, name = '', orderNumber, estado, total = 0, motivo = '' }) {
  const safeName = String(name || 'Cliente').trim();
  const safeEstado = String(estado || '').toLowerCase();
  const safeNumber = String(orderNumber || '');
  const safeTotal = Number(total || 0);
  const safeMotivo = String(motivo || '').trim();

  const configMap = {
    procesando: {
      emoji: '⚙️',
      title: 'Tu pedido está siendo procesado',
      body: 'Estamos preparando tu pedido. Te notificaremos cuando sea enviado.',
      subject: `Pedido #${safeNumber} en proceso — NEXUS`,
      color: '#3182ce',
    },
    enviado: {
      emoji: '🚚',
      title: '¡Tu pedido está en camino!',
      body: 'Tu pedido ha sido enviado. Pronto llegará a tu dirección.',
      subject: `Pedido #${safeNumber} enviado — NEXUS`,
      color: '#38a169',
    },
    entregado: {
      emoji: '✅',
      title: '¡Tu pedido fue entregado!',
      body: 'Tu pedido fue marcado como entregado. Esperamos que estés feliz con tu compra.',
      subject: `Pedido #${safeNumber} entregado — NEXUS`,
      color: '#2f855a',
    },
    cancelado: {
      emoji: '❌',
      title: 'Tu pedido fue cancelado',
      body: safeMotivo
        ? `Tu pedido fue cancelado. Motivo: ${safeMotivo}.`
        : 'Tu pedido fue cancelado. Si realizaste un pago, el reembolso se procesará en 3-5 días hábiles.',
      subject: `Pedido #${safeNumber} cancelado — NEXUS`,
      color: '#e53e3e',
    },
  };

  const cfg = configMap[safeEstado] || {
    emoji: '📦',
    title: `Estado de pedido actualizado: ${safeEstado}`,
    body: `El estado de tu pedido cambió a: ${safeEstado}.`,
    subject: `Actualización pedido #${safeNumber} — NEXUS`,
    color: '#FF6B35',
  };

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:${cfg.color};margin:0 0 16px;">${cfg.emoji} ${cfg.title}</h2>
      <p>Hola <strong>${safeName}</strong>,</p>
      <p>${cfg.body}</p>
      <p><strong>Pedido:</strong> #${safeNumber}</p>
      ${safeTotal > 0 ? `<p><strong>Total:</strong> $${safeTotal.toFixed(2)} MXN</p>` : ''}
      <p style="color:#888;font-size:12px;margin-top:24px;">Este es un correo automático, no responder.</p>
    </div>`;

  const text = [cfg.title, `Hola ${safeName},`, cfg.body, `Pedido: #${safeNumber}`, safeTotal > 0 ? `Total: $${safeTotal.toFixed(2)} MXN` : ''].filter(Boolean).join('\n');

  return sendMail({ to, subject: cfg.subject, html, text });
}

// ── Carrito Abandonado ────────────────────────────────────────
export async function sendAbandonedCartEmail({ to, name = '', items = [], total = 0, cartUrl = '' }) {
  const safeName = String(name || 'Cliente').trim();
  const safeItems = Array.isArray(items) ? items : [];
  const safeTotal = Number(total || 0);
  const safeCartUrl = String(cartUrl || (process.env.APP_URL ? `${process.env.APP_URL}/es/carrito` : '/es/carrito'));

  const itemsHtml = safeItems.slice(0, 5).map(i =>
    `<tr>
      <td style="padding:6px 8px;">${String(i.nombre || 'Producto')}</td>
      <td style="padding:6px 8px;text-align:center;">${Number(i.cantidad || 1)}</td>
      <td style="padding:6px 8px;text-align:right;">$${Number(i.precio || 0).toFixed(2)}</td>
    </tr>`
  ).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;margin:0 0 16px;">🛒 ¡Olvidaste algo en tu carrito!</h2>
      <p>Hola <strong>${safeName}</strong>,</p>
      <p>Dejaste productos en tu carrito. ¡Están esperándote!</p>
      ${safeItems.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <thead><tr style="background:#f4f4f4;"><th style="padding:8px;text-align:left;">Producto</th><th style="padding:8px;">Cant.</th><th style="padding:8px;text-align:right;">Precio</th></tr></thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        ${safeTotal > 0 ? `<p style="font-size:18px;"><strong>Total: $${safeTotal.toFixed(2)} MXN</strong></p>` : ''}
      ` : ''}
      <p style="margin:24px 0;">
        <a href="${safeCartUrl}" style="background:#FF6B35;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">Completar mi compra</a>
      </p>
      <p style="color:#888;font-size:12px;margin-top:24px;">Si ya no te interesa, puedes ignorar este correo.</p>
    </div>`;

  const text = [`¡Olvidaste algo en tu carrito! Hola ${safeName},`, 'Dejaste productos en tu carrito esperándote.', safeCartUrl, 'Ingresa para completar tu compra.'].join('\n');

  return sendMail({ to, subject: '🛒 Tu carrito te está esperando — NEXUS', html, text });
}

// ── Incidencias de pedido ───────────────────────────────────
function priorityLabel(priority) {
  const p = String(priority || '').toLowerCase();
  if (p === 'alta') return 'Alta (roto grave o inutilizable)';
  if (p === 'baja') return 'Baja (detalle menor)';
  return 'Media (faltante parcial o defecto moderado)';
}

export async function sendIncidentCreatedNotification({
  to,
  recipientRole = 'usuario',
  customerName = '',
  orderNumber = '',
  folio = '',
  motive = '',
  priority = 'media',
  detail = '',
  createdAt = '',
}) {
  const { transporter, cfg, reason } = await getTransporter();
  const senderConfig = cfg || getSmtpConfig();
  const safeTo = String(to || '').trim().toLowerCase();
  if (!isValidEmail(safeTo)) {
    return { sent: false, reason: 'INVALID_TO_EMAIL' };
  }

  const isUser = String(recipientRole || '').toLowerCase() === 'usuario';
  const title = isUser
    ? 'Recibimos tu incidencia de pedido'
    : 'Nueva incidencia creada por cliente';
  const safeName     = String(customerName || '').trim() || 'Cliente';
  const safeFolio    = String(folio || '').trim() || 'INC-SIN-FOLIO';
  const safeOrder    = String(orderNumber || '').trim() || '-';
  const safeMotive   = String(motive || '').trim() || 'Sin motivo';
  const safeDetail   = String(detail || '').trim() || 'Sin detalle';
  const safeDate     = String(createdAt || '').trim() || new Date().toISOString();
  const safePriority = priorityLabel(priority);

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px;">${escapeHtml(title)}</h2>
      <p>${isUser ? `Hola ${escapeHtml(safeName)},` : 'Hola equipo superusuario,'}</p>
      <p>Se registro una incidencia de producto vinculada al pedido <strong>#${escapeHtml(safeOrder)}</strong>.</p>
      <ul>
        <li><strong>Folio:</strong> ${escapeHtml(safeFolio)}</li>
        <li><strong>Cliente:</strong> ${escapeHtml(safeName)}</li>
        <li><strong>Motivo:</strong> ${escapeHtml(safeMotive)}</li>
        <li><strong>Prioridad:</strong> ${escapeHtml(safePriority)}</li>
        <li><strong>Fecha:</strong> ${escapeHtml(safeDate)}</li>
      </ul>
      <p><strong>Descripcion:</strong></p>
      <p>${escapeHtml(safeDetail)}</p>
      <p>${isUser ? 'Te notificaremos cuando se emita un veredicto.' : 'Revisa la incidencia en el panel de quejas de productos.'}</p>
    </div>
  `;

  const text = [
    title,
    '',
    isUser ? `Hola ${safeName},` : 'Hola equipo superusuario,',
    `Pedido: #${safeOrder}`,
    `Folio: ${safeFolio}`,
    `Cliente: ${safeName}`,
    `Motivo: ${safeMotive}`,
    `Prioridad: ${safePriority}`,
    `Fecha: ${safeDate}`,
    '',
    `Descripcion: ${safeDetail}`,
  ].join('\n');

  const subject = isUser
    ? `Incidencia recibida (${safeFolio})`
    : `Nueva incidencia de pedido (${safeFolio})`;

  if (!transporter) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: senderConfig.fromName,
      senderEmail: senderConfig.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || reason || 'SMTP_NOT_CONFIGURED', detail: fallback.detail };
  }

  try {
    await transporter.sendMail({
      from: `${cfg.fromName} <${cfg.from}>`,
      to: safeTo,
      subject,
      text,
      html,
    });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: cfg.fromName,
      senderEmail: cfg.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || 'SMTP_SEND_FAILED', detail: fallback.detail || error?.message };
  }
}

export async function sendProductSubmissionReceived({
  to,
  requesterName = '',
  productName = '',
  empresaName = '',
}) {
  const safeTo = String(to || '').trim().toLowerCase();
  if (!isValidEmail(safeTo)) return { sent: false, reason: 'INVALID_TO_EMAIL' };

  const { transporter, cfg, reason } = await getTransporter();
  const senderConfig = cfg || getSmtpConfig();
  const safeName = String(requesterName || '').trim() || 'Usuario';
  const safeProduct = String(productName || '').trim() || 'Producto';
  const safeEmpresa = String(empresaName || '').trim() || 'tu empresa';

  const subject = 'Producto en revision de cumplimiento';
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px;">Producto enviado a revision</h2>
      <p>Hola ${safeName},</p>
      <p>Recibimos tu solicitud para publicar <strong>${safeProduct}</strong> (${safeEmpresa}).</p>
      <p>El producto quedo en estado <strong>pendiente</strong> y sera revisado por un superusuario antes de publicarse.</p>
      <p>Te notificaremos cuando exista una resolucion.</p>
    </div>
  `;
  const text = [
    'Producto enviado a revision',
    '',
    `Hola ${safeName},`,
    `Recibimos tu solicitud para publicar ${safeProduct} (${safeEmpresa}).`,
    'El producto quedo en estado pendiente y sera revisado por un superusuario.',
    'Te notificaremos cuando exista una resolucion.',
  ].join('\n');

  if (!transporter) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: senderConfig.fromName,
      senderEmail: senderConfig.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || reason || 'SMTP_NOT_CONFIGURED', detail: fallback.detail };
  }

  try {
    await transporter.sendMail({
      from: `${cfg.fromName} <${cfg.from}>`,
      to: safeTo,
      subject,
      text,
      html,
    });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: cfg.fromName,
      senderEmail: cfg.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || 'SMTP_SEND_FAILED', detail: fallback.detail || error?.message };
  }
}

export async function sendProductPendingReviewAlert({
  to,
  reviewerName = 'Superusuario',
  requesterName = '',
  productName = '',
  empresaName = '',
}) {
  const safeTo = String(to || '').trim().toLowerCase();
  if (!isValidEmail(safeTo)) return { sent: false, reason: 'INVALID_TO_EMAIL' };

  const { transporter, cfg, reason } = await getTransporter();
  const senderConfig = cfg || getSmtpConfig();
  const safeReviewer  = String(reviewerName || '').trim() || 'Superusuario';
  const safeRequester = String(requesterName || '').trim() || 'Administrador';
  const safeProduct   = String(productName || '').trim() || 'Producto';
  const safeEmpresa   = String(empresaName || '').trim() || 'Empresa';

  const subject = 'Nuevo producto pendiente de aprobacion';
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px;">Moderacion de productos</h2>
      <p>Hola ${escapeHtml(safeReviewer)},</p>
      <p>Se registro un nuevo producto pendiente de revision.</p>
      <ul>
        <li><strong>Producto:</strong> ${escapeHtml(safeProduct)}</li>
        <li><strong>Empresa:</strong> ${escapeHtml(safeEmpresa)}</li>
        <li><strong>Solicitante:</strong> ${escapeHtml(safeRequester)}</li>
      </ul>
      <p>Revisa el panel de superusuario para aprobar o rechazar la publicacion.</p>
    </div>
  `;
  const text = [
    'Nuevo producto pendiente de aprobacion',
    '',
    `Hola ${safeReviewer},`,
    `Producto: ${safeProduct}`,
    `Empresa: ${safeEmpresa}`,
    `Solicitante: ${safeRequester}`,
    'Revisa el panel de superusuario para aprobar o rechazar la publicacion.',
  ].join('\n');

  if (!transporter) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: senderConfig.fromName,
      senderEmail: senderConfig.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || reason || 'SMTP_NOT_CONFIGURED', detail: fallback.detail };
  }

  try {
    await transporter.sendMail({
      from: `${cfg.fromName} <${cfg.from}>`,
      to: safeTo,
      subject,
      text,
      html,
    });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: cfg.fromName,
      senderEmail: cfg.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || 'SMTP_SEND_FAILED', detail: fallback.detail || error?.message };
  }
}

export async function sendProductReviewDecision({
  to,
  requesterName = '',
  productName = '',
  approved = false,
  motivo = '',
}) {
  const safeTo = String(to || '').trim().toLowerCase();
  if (!isValidEmail(safeTo)) return { sent: false, reason: 'INVALID_TO_EMAIL' };

  const { transporter, cfg, reason } = await getTransporter();
  const senderConfig = cfg || getSmtpConfig();
  const safeName    = String(requesterName || '').trim() || 'Usuario';
  const safeProduct = String(productName || '').trim() || 'Producto';
  const safeReason  = String(motivo || '').trim();
  const subject = approved
    ? 'Producto aprobado para publicacion'
    : 'Producto rechazado en revision';

  const html = approved
    ? `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
        <h2 style="margin:0 0 12px;">Producto aprobado</h2>
        <p>Hola ${escapeHtml(safeName)},</p>
        <p>Tu producto <strong>${escapeHtml(safeProduct)}</strong> fue aprobado y ya esta disponible en la tienda.</p>
      </div>
    `
    : `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
        <h2 style="margin:0 0 12px;">Producto rechazado</h2>
        <p>Hola ${escapeHtml(safeName)},</p>
        <p>Tu producto <strong>${escapeHtml(safeProduct)}</strong> no fue aprobado para publicacion.</p>
        <p><strong>Motivo:</strong> ${escapeHtml(safeReason || 'No especificado')}</p>
      </div>
    `;

  const text = approved
    ? [
        'Producto aprobado',
        '',
        `Hola ${safeName},`,
        `Tu producto ${safeProduct} fue aprobado y ya esta disponible en la tienda.`,
      ].join('\n')
    : [
        'Producto rechazado',
        '',
        `Hola ${safeName},`,
        `Tu producto ${safeProduct} no fue aprobado para publicacion.`,
        `Motivo: ${safeReason || 'No especificado'}`,
      ].join('\n');

  if (!transporter) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: senderConfig.fromName,
      senderEmail: senderConfig.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || reason || 'SMTP_NOT_CONFIGURED', detail: fallback.detail };
  }

  try {
    await transporter.sendMail({
      from: `${cfg.fromName} <${cfg.from}>`,
      to: safeTo,
      subject,
      text,
      html,
    });
    return { sent: true, provider: 'smtp' };
  } catch (error) {
    const fallback = await sendViaBrevoApi({
      to: safeTo,
      subject,
      html,
      text,
      senderName: cfg.fromName,
      senderEmail: cfg.from,
    });
    if (fallback.sent) return fallback;
    return { sent: false, reason: fallback.reason || 'SMTP_SEND_FAILED', detail: fallback.detail || error?.message };
  }
}

// ── New Order Alert (empresa owner/admin) ───────────────────
export async function sendEmpresaNewOrderAlert({
  to,
  ownerName = '',
  empresaNombre = '',
  orderNumber,
  pickupEstimate = '',
  items = [],
}) {
  const safeItems = Array.isArray(items) ? items : [];
  const rowsHtml = safeItems
    .map((i) => {
      const qty = Number(i?.cantidad || 0);
      const unit = Number(i?.precioUnitario || 0);
      const subtotal = Number(i?.subtotal || qty * unit || 0);
      return `
        <tr>
          <td style="padding:4px 8px;">${escapeHtml(String(i?.nombre || 'Producto'))}</td>
          <td style="padding:4px 8px;text-align:center;">${qty}</td>
          <td style="padding:4px 8px;text-align:right;">$${unit.toFixed(2)}</td>
          <td style="padding:4px 8px;text-align:right;">$${subtotal.toFixed(2)}</td>
        </tr>
      `;
    })
    .join('');

  const safeOwner    = escapeHtml(String(ownerName || 'Administrador').trim());
  const safeEmpresa  = escapeHtml(String(empresaNombre || 'Tu empresa').trim());
  const safeOrder    = escapeHtml(String(orderNumber || ''));
  const safePickup   = escapeHtml(String(pickupEstimate || 'Por confirmar'));

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:700px;margin:0 auto">
      <h2 style="color:#FF6B35;margin:0 0 16px;">Nuevo pedido recibido</h2>
      <p>Hola <strong>${safeOwner}</strong>,</p>
      <p>La empresa <strong>${safeEmpresa}</strong> recibió un nuevo pedido.</p>
      <ul>
        <li><strong>No. de pedido:</strong> #${safeOrder}</li>
        <li><strong>Recoleccion estimada:</strong> ${safePickup}</li>
      </ul>

      <table style="width:100%;border-collapse:collapse;margin:14px 0;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:8px;text-align:left;">Producto</th>
            <th style="padding:8px;text-align:center;">Cant.</th>
            <th style="padding:8px;text-align:right;">P. Unitario</th>
            <th style="padding:8px;text-align:right;">Subtotal</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <p style="color:#888;font-size:12px;margin-top:24px;">Este es un correo automático, no responder.</p>
    </div>
  `;

  const text = [
    `Nuevo pedido #${orderNumber}`,
    `Empresa: ${empresaNombre || 'Tu empresa'}`,
    `Recoleccion estimada: ${pickupEstimate || 'Por confirmar'}`,
    '',
    'Productos:',
    ...safeItems.map((i) => {
      const qty = Number(i?.cantidad || 0);
      const unit = Number(i?.precioUnitario || 0).toFixed(2);
      const subtotal = Number(i?.subtotal || qty * Number(i?.precioUnitario || 0) || 0).toFixed(2);
      return `- ${String(i?.nombre || 'Producto')} x${qty} | $${unit} | Subtotal $${subtotal}`;
    }),
  ].join('\n');

  return sendMail({
    to,
    subject: `Nuevo pedido #${orderNumber} para ${empresaNombre || 'tu empresa'} — NEXUS`,
    html,
    text,
  });
}

// ── Email Verification ────────────────────────────────────────────────────────
export async function sendEmailVerification({ to, name = '', verifyUrl }) {
  const safeName = escapeHtml(String(name || 'Usuario').trim());
  const safeUrl  = safeHtmlUrl(String(verifyUrl || '').trim());
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;margin:0 0 16px;">Verifica tu correo electrónico</h2>
      <p>Hola <strong>${safeName}</strong>,</p>
      <p>Gracias por registrarte en <strong>NEXUS</strong>. Por favor verifica tu correo haciendo clic en el botón:</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${safeUrl}"
           style="background:#FF6B35;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">
          Verificar mi correo
        </a>
      </div>
      <p style="color:#666;font-size:13px;">O copia este enlace en tu navegador:</p>
      <p style="word-break:break-all;font-size:12px;color:#888;">${safeUrl}</p>
      <p style="color:#999;font-size:12px;margin-top:24px;">Este enlace expira en 24 horas. Si no creaste una cuenta, ignora este correo.</p>
    </div>`;
  const text = `Hola ${String(name || 'Usuario').trim()},\n\nVerifica tu correo en NEXUS:\n${String(verifyUrl || '').trim()}\n\nEste enlace expira en 24 horas.`;
  return sendMail({ to, subject: 'Verifica tu correo — NEXUS', html, text });
}

// ── TOTP Enabled Notification ─────────────────────────────────────────────────
export async function sendTotpEnabled({ to, name = '' }) {
  const safeName = escapeHtml(String(name || 'Usuario').trim());
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;margin:0 0 16px;">🔐 Autenticación de dos factores activada</h2>
      <p>Hola <strong>${safeName}</strong>,</p>
      <p>La autenticación TOTP (Google Authenticator) ha sido activada exitosamente en tu cuenta.</p>
      <p>Ahora necesitarás tu aplicación de autenticador cada vez que inicies sesión.</p>
      <p style="color:#e53e3e;font-weight:bold;">Si no realizaste este cambio, contacta soporte inmediatamente.</p>
      <p style="color:#888;font-size:12px;margin-top:24px;">Este es un correo automático, no responder.</p>
    </div>`;
  const text = `TOTP activado en tu cuenta NEXUS.\nSi no lo hiciste tú, contacta soporte de inmediato.`;
  return sendMail({ to, subject: '🔐 TOTP activado en tu cuenta — NEXUS', html, text });
}

// ── TOTP Disabled Notification ────────────────────────────────────────────────
export async function sendTotpDisabled({ to, name = '' }) {
  const safeName = escapeHtml(String(name || 'Usuario').trim());
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:600px;margin:0 auto">
      <h2 style="color:#FF6B35;margin:0 0 16px;">⚠️ Autenticación de dos factores desactivada</h2>
      <p>Hola <strong>${safeName}</strong>,</p>
      <p>La autenticación TOTP ha sido <strong>desactivada</strong> en tu cuenta.</p>
      <p style="color:#e53e3e;font-weight:bold;">Si no realizaste este cambio, contacta soporte inmediatamente y cambia tu contraseña.</p>
      <p style="color:#888;font-size:12px;margin-top:24px;">Este es un correo automático, no responder.</p>
    </div>`;
  const text = `TOTP desactivado en tu cuenta NEXUS.\nSi no lo hiciste tú, cambia tu contraseña y contacta soporte.`;
  return sendMail({ to, subject: '⚠️ TOTP desactivado — NEXUS', html, text });
}