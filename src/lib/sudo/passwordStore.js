const crypto = require("crypto");

const ENCRYPT_ALGO = "aes-256-gcm";
const ENCRYPT_SALT = "9router-sudo-pwd";
const STORE_KEY = "sudoPasswordEncrypted";

function getCachedPassword() { return globalThis.__sudoPasswordCache || null; }
function setCachedPassword(pwd) { globalThis.__sudoPasswordCache = pwd; }

function deriveKey() {
  try {
    const { machineIdSync } = require("node-machine-id");
    const raw = machineIdSync();
    return crypto.createHash("sha256").update(raw + ENCRYPT_SALT).digest();
  } catch {
    return crypto.createHash("sha256").update(ENCRYPT_SALT).digest();
  }
}

function encryptPassword(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptPassword(stored) {
  try {
    const [ivHex, tagHex, dataHex] = stored.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch {
    return null;
  }
}

let _getSettings = null;
let _updateSettings = null;

function initDbHooks(getSettingsFn, updateSettingsFn) {
  _getSettings = getSettingsFn;
  _updateSettings = updateSettingsFn;
}

async function saveEncryptedPassword(password) {
  if (!_updateSettings || !password) return;
  try {
    await _updateSettings({ [STORE_KEY]: encryptPassword(password) });
  } catch (e) {
    console.error(`[sudo] failed to save encrypted password: ${e.message}`);
  }
}

async function clearEncryptedPassword() {
  if (!_updateSettings) return;
  try {
    await _updateSettings({ [STORE_KEY]: null });
  } catch (e) {
    console.error(`[sudo] failed to clear encrypted password: ${e.message}`);
  }
}

async function loadEncryptedPassword() {
  if (!_getSettings) return null;
  try {
    const settings = await _getSettings();
    const stored = settings && settings[STORE_KEY];
    return stored ? decryptPassword(stored) : null;
  } catch {
    return null;
  }
}

module.exports = {
  getCachedPassword,
  setCachedPassword,
  initDbHooks,
  saveEncryptedPassword,
  clearEncryptedPassword,
  loadEncryptedPassword,
};
