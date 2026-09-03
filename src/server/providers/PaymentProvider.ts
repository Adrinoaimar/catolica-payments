import type {
  CreatePaymentInput,
  ProviderPayment,
  VerifiedWebhook,
  WebhookRequest,
} from '../payments/types';

export interface PaymentProvider {
  readonly name: string;

  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook>;
  cancelPayment(providerPaymentId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = 'PROVIDER_ERROR',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function providerFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): string {
  const provider = (env.PAYMENT_PROVIDER ?? 'mock').trim().toLowerCase();
  if (!['mock', 'taypi', 'culqi', 'mercadopago'].includes(provider)) {
    throw new ProviderError(`Unsupported PAYMENT_PROVIDER: ${provider}`, 500, 'INVALID_PROVIDER');
  }
  return provider;
}
