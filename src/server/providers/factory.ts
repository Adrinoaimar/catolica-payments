import { MockPaymentProvider } from './MockPaymentProvider';
import { CulqiProvider, MercadoPagoProvider, TaypiProvider } from './HttpPaymentProvider';
import type { PaymentProvider } from './PaymentProvider';
import { ProviderError, providerFromEnvironment } from './PaymentProvider';

export function createPaymentProvider(env: Record<string, string | undefined> = process.env): PaymentProvider {
  switch (providerFromEnvironment(env)) {
    case 'mock': return new MockPaymentProvider();
    case 'taypi': return new TaypiProvider({
      baseUrl: env.TAYPI_API_URL ?? 'https://api.taypi.net', apiKey: requireValue(env.TAYPI_SECRET_KEY, 'TAYPI_SECRET_KEY'), webhookSecret: requireValue(env.TAYPI_WEBHOOK_SECRET, 'TAYPI_WEBHOOK_SECRET'),
    });
    case 'culqi': return new CulqiProvider({
      baseUrl: env.CULQI_API_URL ?? 'https://api.culqi.com', apiKey: requireValue(env.CULQI_SECRET_KEY, 'CULQI_SECRET_KEY'), webhookSecret: requireValue(env.CULQI_WEBHOOK_SECRET, 'CULQI_WEBHOOK_SECRET'),
    });
    case 'mercadopago': return new MercadoPagoProvider({
      baseUrl: env.MERCADOPAGO_API_URL ?? 'https://api.mercadopago.com', apiKey: requireValue(env.MERCADOPAGO_ACCESS_TOKEN, 'MERCADOPAGO_ACCESS_TOKEN'), webhookSecret: requireValue(env.MERCADOPAGO_WEBHOOK_SECRET, 'MERCADOPAGO_WEBHOOK_SECRET'),
    });
    default: throw new ProviderError('Unsupported provider', 500, 'INVALID_PROVIDER');
  }
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new ProviderError(`Missing ${name}`, 500, 'PROVIDER_NOT_CONFIGURED');
  return value;
}
