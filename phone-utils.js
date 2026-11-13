function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatTwilioWhatsappRecipient(rawValue) {
  const input = String(rawValue || '').trim();
  if (!input) return '';

  const whatsappPrefix = /^whatsapp:/i;
  if (whatsappPrefix.test(input)) {
    return input.replace(/^whatsapp:/i, 'whatsapp:');
  }

  const normalized = normalizePhone(input);
  if (!normalized) return '';

  return `whatsapp:+${normalized.startsWith('+') ? normalized.slice(1) : normalized}`;
}

module.exports = {
  normalizePhone,
  formatTwilioWhatsappRecipient
};
