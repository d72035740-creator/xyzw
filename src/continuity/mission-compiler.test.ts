import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionCompiler } from "./mission-compiler";

afterEach(()=>vi.unstubAllEnvs());
describe("MissionCompiler",()=>{
  it("builds dynamic gaming needs without granting financial authority",async()=>{vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER","mock");const spec=await new MissionCompiler().compile({goal:"Build me a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair",maximumAuthorityPaise:5500000,repairAllowancePaise:100000});expect(spec.needs).toHaveLength(4);expect(spec.needs.map(n=>n.label)).toEqual(expect.arrayContaining([expect.stringContaining("monitor"),expect.stringContaining("keyboard"),expect.stringContaining("mouse"),expect.stringContaining("chair")]));expect(spec.budgetPaise).toBe(5500000);expect(spec.repairAuthority.maxAdditionalSpendPaise).toBe(100000);});
  it("rejects a mismatch between natural language and explicit authority",async()=>{vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER","mock");await expect(new MissionCompiler().compile({goal:"Buy a setup under ₹50,000",maximumAuthorityPaise:6000000})).rejects.toMatchObject({code:"BUDGET_CONSTRAINT_MISMATCH"});});
});
