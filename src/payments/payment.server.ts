import "server-only";
import { db } from "@/db/client";
import { MissionPaymentService } from "./mission-payment-service";
import { RazorpayPaymentProvider } from "./razorpay-payment-provider";

export const razorpayPaymentProvider = new RazorpayPaymentProvider();
export const missionPaymentService = new MissionPaymentService(razorpayPaymentProvider, db);
