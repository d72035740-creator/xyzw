export function isDemoMutationEnabled(
  environment: { NODE_ENV?: string; MISSIONPAY_ENABLE_DEV_WORLD_API?: string } = process.env,
): boolean {
  return environment.NODE_ENV === "development" && environment.MISSIONPAY_ENABLE_DEV_WORLD_API === "true";
}
