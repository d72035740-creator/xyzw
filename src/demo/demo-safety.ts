export function isDemoMutationEnabled(
  environment: NodeJS.ProcessEnv | { MISSIONPAY_DEMO_MODE?: string } = process.env,
): boolean {
  return environment.MISSIONPAY_DEMO_MODE === "true";
}
