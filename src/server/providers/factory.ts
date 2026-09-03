import { MockPaymentProvider } from './MockPaymentProvider';
import { TaypiProvider } from './TaypiProvider';
import type { PaymentProvider } from './PaymentProvider';
import { ProviderError, providerFromEnvironment } from './PaymentProvider';

export function createPaymentProvider(env: Record<string, string | undefined> = process.env): PaymentProvider {
  switch (providerFromEnvironment(env)) {
    case 'mock': return new MockPaymentProvider();
    case 'taypi': return new TaypiProvider({
      baseUrl: env.TAYPI_API_URL,
      sandbox: env.TAYPI_SANDBOX === 'true',
      publicKey: requireValue(env.TAYPI_PUBLIC_KEY, 'TAYPI_PUBLIC_KEY'),
      secretKey: requireValue(env.TAYPI_SECRET_KEY, 'TAYPI_SECRET_KEY'),
      webhookSecret: requireValue(env.TAYPI_WEBHOOK_SECRET, 'TAYPI_WEBHOOK_SECRET'),
    });
    // Keep the generic HTTP classes available for future adapters, but fail
    // closed here: Culqi and Mercado Pago require provider-specific request
    // and webhook contracts and must not be presented as production-ready by
    // a generic `/payments` implementation.
    case 'culqi':
    case 'mercadopago':
      throw new ProviderError(`${providerFromEnvironment(env)} adapter is not implemented`, 500, 'PROVIDER_NOT_CONFIGURED');
    default: throw new ProviderError('Unsupported provider', 500, 'INVALID_PROVIDER');
  }
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new ProviderError(`Missing ${name}`, 500, 'PROVIDER_NOT_CONFIGURED');
  return value;
}
