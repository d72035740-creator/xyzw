import { z } from "zod";

export const paymentOrderSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const checkoutCallbackSchema = z.object({
  razorpay_payment_id: z.string().min(1).max(200),
  razorpay_order_id: z.string().min(1).max(200),
  razorpay_signature: z.string().min(1).max(200),
}).strict();
