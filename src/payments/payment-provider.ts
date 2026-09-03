export interface ProviderOrder {
  providerOrderId: string;
  amount: number;
  currency: string;
}

export interface ProviderPayment {
  providerPaymentId: string;
  providerOrderId: string;
  status: string;
  amount: number;
  currency: string;
}

export interface PaymentProvider {
  readonly provider: string;
  readonly publicKeyId: string | null;
  createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder>;
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  fetchOrder(orderId: string): Promise<{ providerOrderId: string; status?: string }>;
  verifyCheckoutSignature(input: { expectedOrderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhookSignature?(rawBody: string, signature: string): boolean;
}
