function normalizeDecimalString_(value) {
  const text = String(value || '').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) {
    throw new Error('Invalid decimal amount: ' + value);
  }

  let sign = '';
  let unsigned = text;
  if (unsigned.charAt(0) === '+' || unsigned.charAt(0) === '-') {
    sign = unsigned.charAt(0) === '-' ? '-' : '';
    unsigned = unsigned.slice(1);
  }

  const parts = unsigned.split('.');
  const integerPart = parts[0].replace(/^0+(?=\d)/, '') || '0';
  const fractionalPart = parts[1] ? parts[1].replace(/0+$/, '') : '';
  if (!fractionalPart) {
    return sign + integerPart;
  }
  return sign + integerPart + '.' + fractionalPart;
}

function sumDecimalStrings_(values) {
  const normalized = values.map(function(value) {
    return normalizeDecimalString_(value);
  });
  let scale = 0;
  normalized.forEach(function(value) {
    const parts = value.replace(/^[-+]/, '').split('.');
    const fractional = parts[1] || '';
    if (fractional.length > scale) {
      scale = fractional.length;
    }
  });

  let total = BigInt(0);
  normalized.forEach(function(value) {
    total += decimalStringToBigInt_(value, scale);
  });
  return bigIntToDecimalString_(total, scale);
}

function subtractDecimalStrings_(left, right) {
  const scale = Math.max(decimalScale_(left), decimalScale_(right));
  const result = decimalStringToBigInt_(left, scale) - decimalStringToBigInt_(right, scale);
  return bigIntToDecimalString_(result, scale);
}

function compareDecimalStrings_(left, right) {
  const scale = Math.max(decimalScale_(left), decimalScale_(right));
  const leftValue = decimalStringToBigInt_(left, scale);
  const rightValue = decimalStringToBigInt_(right, scale);
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
}

function negateDecimalString_(value) {
  const normalized = normalizeDecimalString_(value);
  if (normalized === '0') {
    return '0';
  }
  if (normalized.charAt(0) === '-') {
    return normalized.slice(1);
  }
  return '-' + normalized;
}

function decimalScale_(value) {
  const normalized = normalizeDecimalString_(value);
  const parts = normalized.replace(/^[-+]/, '').split('.');
  return parts[1] ? parts[1].length : 0;
}

function decimalStringToBigInt_(value, scale) {
  const normalized = normalizeDecimalString_(value);
  const negative = normalized.charAt(0) === '-';
  const unsigned = negative ? normalized.slice(1) : normalized;
  const parts = unsigned.split('.');
  const integerPart = parts[0];
  const fractionalPart = (parts[1] || '').padEnd(scale, '0');
  const digits = integerPart + fractionalPart;
  const amount = BigInt(digits || '0');
  return negative ? -amount : amount;
}

function bigIntToDecimalString_(value, scale) {
  const negative = value < 0;
  const absolute = negative ? -value : value;
  let digits = absolute.toString();
  while (digits.length <= scale) {
    digits = '0' + digits;
  }

  if (scale === 0) {
    return (negative ? '-' : '') + digits;
  }

  const integerPart = digits.slice(0, digits.length - scale) || '0';
  const fractionalPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  if (!fractionalPart) {
    return (negative ? '-' : '') + integerPart;
  }
  return (negative ? '-' : '') + integerPart + '.' + fractionalPart;
}
