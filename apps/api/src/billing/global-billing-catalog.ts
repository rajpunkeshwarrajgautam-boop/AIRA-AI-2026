import type {
  CurrencyCode,
  GlobalCountryOption,
  ProviderCapabilityDescriptor
} from '../../../../packages/contracts/src/commercial.js';

export const GLOBAL_COUNTRY_CATALOG: readonly GlobalCountryOption[] = Object.freeze([
  { code: 'US', name: 'United States', defaultCurrency: 'USD', regionLabel: 'North America' },
  { code: 'IN', name: 'India', defaultCurrency: 'INR', regionLabel: 'South Asia' },
  { code: 'GB', name: 'United Kingdom', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'CA', name: 'Canada', defaultCurrency: 'USD', regionLabel: 'North America' },
  { code: 'AU', name: 'Australia', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'DE', name: 'Germany', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'FR', name: 'France', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'SG', name: 'Singapore', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'AE', name: 'United Arab Emirates', defaultCurrency: 'USD', regionLabel: 'Middle East' },
  { code: 'JP', name: 'Japan', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'NL', name: 'Netherlands', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'IE', name: 'Ireland', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'CH', name: 'Switzerland', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'SE', name: 'Sweden', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'ES', name: 'Spain', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'IT', name: 'Italy', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'BR', name: 'Brazil', defaultCurrency: 'USD', regionLabel: 'Latin America' },
  { code: 'MX', name: 'Mexico', defaultCurrency: 'USD', regionLabel: 'Latin America' },
  { code: 'KR', name: 'South Korea', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'NZ', name: 'New Zealand', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'ID', name: 'Indonesia', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'MY', name: 'Malaysia', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'PH', name: 'Philippines', defaultCurrency: 'USD', regionLabel: 'Asia-Pacific' },
  { code: 'IL', name: 'Israel', defaultCurrency: 'USD', regionLabel: 'Middle East' },
  { code: 'ZA', name: 'South Africa', defaultCurrency: 'USD', regionLabel: 'Africa' },
  { code: 'PL', name: 'Poland', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'NO', name: 'Norway', defaultCurrency: 'USD', regionLabel: 'Europe' },
  { code: 'DK', name: 'Denmark', defaultCurrency: 'USD', regionLabel: 'Europe' }
]);

const COUNTRY_CODE_SET = new Set(GLOBAL_COUNTRY_CATALOG.map(c => c.code));

export function normalizeCountryCode(rawCountry?: string | null): string {
  const cleaned = typeof rawCountry === 'string' ? rawCountry.trim().toUpperCase() : '';
  if (!cleaned) return 'US';
  if (cleaned === 'INDIA') return 'IN';
  if (cleaned === 'USA' || cleaned === 'UNITED STATES') return 'US';
  if (cleaned === 'UK' || cleaned === 'UNITED KINGDOM') return 'GB';
  if (/^[A-Z]{2}$/.test(cleaned)) return cleaned;
  return 'US';
}

export function isKnownCountryCode(code: string): boolean {
  return COUNTRY_CODE_SET.has(code.toUpperCase());
}

export function resolveCountryBillingDefaults(rawCountry?: string | null): {
  countryCode: string;
  countryName: string;
  currency: CurrencyCode;
  requiresIndianStateForTax: boolean;
  availablePaymentMethods: Array<'card' | 'upi' | 'emandate'>;
} {
  const countryCode = normalizeCountryCode(rawCountry);
  const match = GLOBAL_COUNTRY_CATALOG.find(c => c.code === countryCode);
  const isIndia = countryCode === 'IN';
  return {
    countryCode,
    countryName: match?.name || countryCode,
    currency: isIndia ? 'INR' : 'USD',
    requiresIndianStateForTax: isIndia,
    availablePaymentMethods: isIndia ? ['card', 'upi', 'emandate'] : ['card']
  };
}

export interface ProviderCapabilityMatrix {
  domesticInrRazorpay: ProviderCapabilityDescriptor;
  domesticInrCashfree: ProviderCapabilityDescriptor;
  internationalUsdRazorpay: ProviderCapabilityDescriptor;
  internationalUsdCashfree: ProviderCapabilityDescriptor;
  binaryPdfDownload: ProviderCapabilityDescriptor;
  invoiceEmailDelivery: ProviderCapabilityDescriptor;
}

export function getProviderCapabilityMatrix(options: {
  isSandbox: boolean;
  internationalUsdEnabled: boolean;
  emailConfigured?: boolean;
}): ProviderCapabilityMatrix {
  const hasMailTransport = Boolean(
    options.emailConfigured ??
    (process.env.RESEND_API_KEY || process.env.SMTP_HOST || process.env.SENDGRID_API_KEY)
  );

  return {
    domesticInrRazorpay: {
      id: 'razorpay_inr',
      provider: 'razorpay',
      scope: 'domestic_inr',
      status: 'VERIFIED_SUPPORTED',
      supportedMethods: ['card', 'upi', 'emandate', 'netbanking'],
      notes: 'Razorpay Subscriptions INR recurring billing verified in sandbox (Plus ₹399, Pro ₹999).'
    },
    domesticInrCashfree: {
      id: 'cashfree_inr',
      provider: 'cashfree',
      scope: 'domestic_inr',
      status: 'VERIFIED_SUPPORTED',
      supportedMethods: ['upi', 'card'],
      notes: 'Cashfree Subscriptions INR immediate-charge e-mandate verified in sandbox (Plus ₹399, Pro ₹999).'
    },
    internationalUsdRazorpay: {
      id: 'razorpay_usd',
      provider: 'razorpay',
      scope: 'international_usd',
      status: options.internationalUsdEnabled || options.isSandbox
        ? 'SUPPORTED_WITH_ACCOUNT_ACTIVATION'
        : 'UNVERIFIED_FOR_CURRENT_CHECKOUT',
      supportedMethods: ['card'],
      notes: 'International USD card recurring subscriptions via Razorpay Subscriptions API. UPI/eMandate unavailable for USD; live merchant International Payments activation required.'
    },
    internationalUsdCashfree: {
      id: 'cashfree_usd',
      provider: 'cashfree',
      scope: 'international_usd',
      status: 'UNVERIFIED_FOR_CURRENT_CHECKOUT',
      supportedMethods: ['card'],
      notes: 'Cashfree IPG USD card recurring documented, but current integration enforces Indian 10-digit mobile mandate rules and USD merchant activation is unverified. Fails closed for USD checkout.'
    },
    binaryPdfDownload: {
      id: 'aira_pdf',
      provider: 'aira_pdf',
      scope: 'documents',
      status: 'VERIFIED_SUPPORTED',
      supportedMethods: ['application/pdf', 'text/html'],
      notes: 'Generates deterministic binary A4 PDF invoices and credit notes alongside printable A4 HTML receipts.'
    },
    invoiceEmailDelivery: {
      id: 'aira_email',
      provider: 'aira_email',
      scope: 'documents',
      status: hasMailTransport ? 'VERIFIED_SUPPORTED' : 'UNCONFIGURED_BLOCKER',
      supportedMethods: hasMailTransport ? ['email'] : [],
      notes: hasMailTransport
        ? 'Transactional invoice email transport configured.'
        : 'No transactional email provider (SMTP/Resend/SendGrid) configured in staging or production.'
    }
  };
}

export function resolveCheckoutProviderForRegion(params: {
  currency: CurrencyCode;
  country?: string | null;
  requestedGateway?: string;
  isSandbox: boolean;
  internationalUsdEnabled: boolean;
}):
  | { allowed: true; gateway: 'razorpay' | 'cashfree'; supportedMethods: Array<'card' | 'upi' | 'emandate'> }
  | { allowed: false; code: 'UNSUPPORTED_INTERNATIONAL_GATEWAY' | 'INTERNATIONAL_USD_DISABLED'; message: string } {
  const requested = params.requestedGateway?.trim().toLowerCase();

  if (params.currency === 'USD') {
    if (!params.isSandbox && !params.internationalUsdEnabled) {
      return {
        allowed: false,
        code: 'INTERNATIONAL_USD_DISABLED',
        message: 'International USD checkout is not currently enabled in this environment.'
      };
    }
    if (requested === 'cashfree') {
      return {
        allowed: false,
        code: 'UNSUPPORTED_INTERNATIONAL_GATEWAY',
        message: 'International USD card subscriptions are routed via Razorpay International Cards; Cashfree USD checkout is not enabled until international merchant activation is verified.'
      };
    }
    return {
      allowed: true,
      gateway: 'razorpay',
      supportedMethods: ['card']
    };
  }

  return {
    allowed: true,
    gateway: requested === 'cashfree' ? 'cashfree' : 'razorpay',
    supportedMethods: requested === 'cashfree' ? ['upi', 'card'] : ['card', 'upi', 'emandate']
  };
}
