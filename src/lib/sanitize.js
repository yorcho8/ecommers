// src/lib/sanitize.js
// ─── Sanitización de inputs para prevenir XSS y SQL injection ───

/**
 * Escapa caracteres HTML peligrosos para prevenir XSS.
 * Úsalo en cualquier string que venga del usuario antes de mostrarlo.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Limpia un string de entrada: trim + eliminar tags HTML.
 * Para campos de texto normales (nombre, correo, etc).
 * @param {string} str
 * @returns {string}
 */
export function cleanInput(str) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .replace(/<[^>]*>/g, '')         // quitar tags HTML
    .replace(/javascript:/gi, '')     // quitar javascript: URIs
    .replace(/on\w+\s*=/gi, '');      // quitar event handlers (onclick=, onerror=, etc)
}

/**
 * Limpia un email: trim + lowercase + validar formato básico.
 * @param {string} email
 * @returns {string} email limpio o string vacío si es inválido
 */
export function cleanEmail(email) {
  if (typeof email !== 'string') return '';
  var cleaned = email.trim().toLowerCase().replace(/<[^>]*>/g, '');
  // Validación básica de formato
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(cleaned) ? cleaned : '';
}

/**
 * Limpia un número: parsea a entero seguro.
 * @param {any} val
 * @param {number} min - valor mínimo permitido (default 0)
 * @returns {number|null}
 */
export function cleanInt(val, min = 0) {
  var num = parseInt(val, 10);
  if (isNaN(num) || !isFinite(num)) return null;
  return num < min ? null : num;
}

/**
 * Limpia un número decimal.
 * @param {any} val
 * @param {number} min
 * @returns {number|null}
 */
export function cleanFloat(val, min = 0) {
  var num = parseFloat(val);
  if (isNaN(num) || !isFinite(num)) return null;
  return num < min ? null : num;
}

/**
 * Limpia un teléfono: solo dígitos, +, -, espacios y paréntesis.
 * @param {string} phone
 * @returns {string}
 */
export function cleanPhone(phone) {
  if (typeof phone !== 'string') return '';
  return phone.trim().replace(/[^0-9+\-() ]/g, '');
}

/**
 * Limpia un objeto completo de formulario.
 * Pásale un objeto con los campos y sus tipos esperados.
 * 
 * Ejemplo:
 *   sanitizeForm(body, {
 *     nombre: 'text',
 *     correo: 'email',
 *     precio: 'float',
 *     stock: 'int',
 *     telefono: 'phone',
 *   })
 * 
 * @param {object} data - objeto con los datos del formulario
 * @param {object} schema - { campo: 'text'|'email'|'int'|'float'|'phone' }
 * @returns {object} datos sanitizados
 */
export function sanitizeForm(data, schema) {
  var result = {};
  for (var key in schema) {
    var type = schema[key];
    var val = data[key];

    switch (type) {
      case 'text':
        result[key] = cleanInput(val);
        break;
      case 'email':
        result[key] = cleanEmail(val);
        break;
      case 'int':
        result[key] = cleanInt(val);
        break;
      case 'float':
        result[key] = cleanFloat(val);
        break;
      case 'phone':
        result[key] = cleanPhone(val);
        break;
      default:
        result[key] = cleanInput(String(val || ''));
    }
  }
  return result;
}