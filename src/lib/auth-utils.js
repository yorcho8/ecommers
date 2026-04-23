import crypto from 'crypto';

// OWASP recommendation: 210,000 for PBKDF2-SHA512 (we use 100,000 for balance of security/perf)
export var PBKDF2_ITERATIONS = 100000;

/**
 * Hashes a password using PBKDF2-SHA512 with 100,000 iterations.
 * Returns hash, salt, and iterations so the storage format stays self-describing.
 * @param {string} password 
 * @returns {{ hash: string, salt: string, iterations: number }} 
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return { hash, salt, iterations: PBKDF2_ITERATIONS };
}

/**
 * Verifies a password against a stored hash.
 * Supports old (1,000 iteration) and new (100,000 iteration) hashes via the iterations param.
 * Uses crypto.timingSafeEqual to prevent timing-attack leaking of hash bits.
 * @param {string} password 
 * @param {string} hash 
 * @param {string} salt 
 * @param {number} [iterations=1000] - defaults to 1000 for backward compatibility with old hashes
 * @returns {boolean} 
 */
export function verifyPassword(password, hash, salt, iterations) {
  var iters = (typeof iterations === 'number' && iterations > 0) ? iterations : 1000;
  var verifyHash = crypto.pbkdf2Sync(password, salt, iters, 64, 'sha512').toString('hex');
  // Timing-safe comparison to prevent hash enumeration via timing side-channels
  var hashBuf   = Buffer.from(hash,       'hex');
  var verifyBuf = Buffer.from(verifyHash, 'hex');
  if (hashBuf.length !== verifyBuf.length) {
    // Lengths differ means definitely wrong, but still run equal to keep constant time
    crypto.timingSafeEqual(Buffer.alloc(hashBuf.length), Buffer.alloc(hashBuf.length));
    return false;
  }
  return crypto.timingSafeEqual(hashBuf, verifyBuf);
}

/**
 * 
 * @param {string} email 
 * @returns {boolean}
 */
export function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * 
 * @param {string} password 
 * @returns {object}
 */
export function validatePassword(password) {
  if (password.length < 8) {
    return { isValid: false, message: 'La contraseña debe tener al menos 8 caracteres' };
  }
  
  if (!/[A-Z]/.test(password)) {
    return { isValid: false, message: 'La contraseña debe incluir al menos una mayúscula' };
  }
  
  if (!/[a-z]/.test(password)) {
    return { isValid: false, message: 'La contraseña debe incluir al menos una minúscula' };
  }
  
  if (!/[0-9]/.test(password)) {
    return { isValid: false, message: 'La contraseña debe incluir al menos un número' };
  }
  
  return { isValid: true, message: 'Contraseña válida' };
}

/**
 * 
 * @param {object} data 
 * @returns {object}
 */
export function validateUserData(data) {
  const errors = [];
  
  if (!data.nombre || data.nombre.trim() === '') {
    errors.push('El nombre es requerido');
  }
  
  if (!data.apellido_paterno || data.apellido_paterno.trim() === '') {
    errors.push('El apellido paterno es requerido');
  }
  
  if (!data.correo || data.correo.trim() === '') {
    errors.push('El correo es requerido');
  } else if (!isValidEmail(data.correo)) {
    errors.push('El correo no tiene un formato válido');
  }
  
  if (!data.contrasena || data.contrasena === '') {
    errors.push('La contraseña es requerida');
  }

  if (!data.numero_casa || Number(data.numero_casa) <= 0) {
    errors.push('El número de casa es requerido y debe ser válido');
  }

  if (!data.calle || data.calle.trim() === '') {
    errors.push('La calle es requerida');
  }

  if (!data.codigo_postal || Number(data.codigo_postal) <= 0) {
    errors.push('El código postal es requerido y debe ser válido');
  }

  if (!data.ciudad || data.ciudad.trim() === '') {
    errors.push('La ciudad es requerida');
  }

  if (!data.provincia || data.provincia.trim() === '') {
    errors.push('La provincia es requerida');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Valida RFC de persona moral (12 caracteres) según formato SAT México.
 * Estructura: [A-ZÑ&]{3} + YYMMDD + [A-Z0-9]{3}
 * @param {string} rfc
 * @returns {{ valid: boolean, clean: string, error?: string }}
 */
export function validateRFC(rfc) {
  if (!rfc) return { valid: false, clean: '', error: 'El RFC es requerido' };

  const clean = String(rfc).trim().toUpperCase().replace(/\s/g, '');

  if (clean.length !== 12) {
    return { valid: false, clean, error: `RFC debe tener 12 caracteres (tienes ${clean.length})` };
  }

  if (!/^[A-ZÑ&]{3}\d{6}[A-Z0-9]{3}$/.test(clean)) {
    return { valid: false, clean, error: 'RFC inválido — formato: 3 letras + AAMMDD + 3 alfanuméricos' };
  }

  const mm = parseInt(clean.slice(5, 7));
  const dd = parseInt(clean.slice(7, 9));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    return { valid: false, clean, error: 'RFC inválido — la fecha de constitución no es válida' };
  }

  if (['XAXX010101000', 'XEXX010101000'].includes(clean)) {
    return { valid: false, clean, error: 'No puedes usar un RFC genérico para registrar una empresa' };
  }

  return { valid: true, clean };
}
