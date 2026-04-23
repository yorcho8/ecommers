// src/lib/crypto.js
// ─── RSA en memoria (sin filesystem) ───
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';

let cachedKeys = null;

function ensureKeys() {
  if (cachedKeys) return cachedKeys;

  console.log('[crypto] Generando par de llaves RSA-2048 en memoria...');
  var pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  console.log('[crypto] Llaves generadas correctamente.');

  cachedKeys = { publicKey: pair.publicKey, privateKey: pair.privateKey };
  return cachedKeys;
}

export function getPublicKey() {
  return ensureKeys().publicKey;
}

export function decryptPassword(encryptedBase64) {
  var keys = ensureKeys();
  var buffer = Buffer.from(encryptedBase64, 'base64');
  var decrypted = privateDecrypt(
    {
      key: keys.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    buffer,
  );
  return decrypted.toString('utf-8');
}