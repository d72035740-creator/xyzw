import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentProvider, ProviderOrder, ProviderPayment } from "./payment-provider";
import { PaymentError } from "./payment-errors";

type RazorpayConfig = { keyId?: string; keySecret?: string; webhookSecret?: string; fetchImpl?: typeof fetch };

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly provider = "razorpay";
  readonly publicKeyId: string | null;
  private readonly keySecret: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RazorpayConfig = {}) {
    this.publicKeyId = config.keyId ?? process.env.RAZORPAY_KEY_ID ?? null;
    this.keySecret = config.keySecret ?? process.env.RAZORPAY_KEY_SECRET;
    this.webhookSecret = config.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret || !signature) return false;
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  verifyCheckoutSignature(input: { expectedOrderId: string; paymentId: string; signature: string }): boolean {
    if (!this.keySecret) return false;
    const expected = createHmac("sha256", this.keySecret).update(`${input.expectedOrderId}|${input.paymentId}`).digest("hex");
    return expected.length === input.signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
  }

  async createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder> {
    this.assertConfigured();
    const response = await this.fetchImpl("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${this.publicKeyId}:${this.keySecret}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: input.amount, currency: input.currency, receipt: input.receipt, notes: input.notes }),
    });
    if (!response.ok) throw new PaymentError("PAYMENT_FAILED", "Razorpay order creation failed", 502);
    const body = (await response.json()) as { id?: string; amount?: number; currency?: string };
    if (!body.id || body.amount !== input.amount || body.currency !== input.currency) throw new PaymentError("PAYMENT_PROVIDER_MISMATCH", "Razorpay returned an unexpected order", 502);
    return { providerOrderId: body.id, amount: body.amount, currency: body.currency };
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment> {
    this.assertConfigured();
    const body = await this.get(`/v1/payments/${encodeURIComponent(paymentId)}`) as { id: string; order_id: string; status: string; amount: number; currency: string };
    return { providerPaymentId: body.id, providerOrderId: body.order_id, status: body.status, amount: body.amount, currency: body.currency };
  }

  async fetchOrder(orderId: string): Promise<{ providerOrderId: string; status?: string }> {
    this.assertConfigured();
    const body = await this.get(`/v1/orders/${encodeURIComponent(orderId)}`) as { id: string; status?: string };
    return { providerOrderId: body.id, status: body.status };
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.razorpay.com${path}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.publicKeyId}:${this.keySecret}`).toString("base64")}` },
    });
    if (!response.ok) throw new PaymentError("PAYMENT_FAILED", "Razorpay status lookup failed", 502);
    return response.json();
  }

  private assertConfigured(): void {
    if (!this.publicKeyId || !this.keySecret) throw new PaymentError("PAYMENT_NOT_CONFIGURED", "Razorpay test-mode server credentials are not configured", 503);
  }
}
