import "server-only";
import { db } from "@/db/client";
import { ContinuityRepairPaymentService } from "./continuity-repair-payment-service";
import { razorpayPaymentProvider } from "./payment.server";

export const continuityRepairPaymentService = new ContinuityRepairPaymentService(razorpayPaymentProvider, db);
