import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import { candidateAssessments, continuityMissions, continuityRepairAttempts, continuityRepairPaymentOrders, continuitySelections, decisionRuns, marketOfferSnapshots, marketSearches, missionEvents, missionOutcomeEvents, missionPaymentOrders, missions, productEvidence } from "@/db/schema";
import { MissionCompiler } from "./mission-compiler";
import { hasKnownPrice, MarketGateway, marketQueryFor } from "./market-gateway";
import { ContinuityError, missionSpecSchema, type MarketOffer, type MissionLocationInput, type MissionNeed } from "./types";
import { EvidenceDecisionEngine, type DecisionPortfolio } from "./evidence-engine";
import { validateMissionPortfolio } from "./capability-validator";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type MissionUnderstandingInput = { goal:string; maximumAuthorityPaise?:number; location?:MissionLocationInput|string; repairAllowancePaise?:number };
type MissionSearchInput = { missionId:string; missionVersion:number };
type MarketGatewayFactory = (mode?: "live" | "sandbox") => MarketGateway;
const activeStatuses = ["SELECTED", "PRESERVED"];
function marketDiagnostic(event:string,data:Record<string,unknown>){console.info(event,data);}
function attributesSatisfy(need: MissionNeed, offer: { attributes: Record<string, unknown> }) { return Object.entries(need.requiredAttributes).every(([key,expected]) => { const actual=offer.attributes[key]; return typeof expected==="number"?typeof actual==="number"&&actual>=expected:actual===expected; }); }
function compareLocationThenPrice(a: { evidence: Record<string, unknown> | null; pricePaise: number }, b: { evidence: Record<string, unknown> | null; pricePaise: number }) {
  const evidenceRank = (offer: typeof a) => offer.evidence?.locationCompatibility === "SUPPORTED_EVIDENCE" ? 0 : 1;
  return evidenceRank(a) - evidenceRank(b) || a.pricePaise - b.pricePaise;
}
function snapshotValues(missionId:string, offer:MarketOffer & { pricePaise: number }){return{missionId,needId:offer.needId,sourceProvider:offer.source.provider,externalId:offer.source.externalId,sourceUrl:offer.source.url,merchantName:offer.merchant.name,title:offer.title,description:offer.description,pricePaise:offer.pricePaise,currency:offer.currency,availability:offer.availability,attributes:offer.attributes,reversibility:offer.reversibility,evidence:offer.evidence,observedAt:new Date(offer.observedAt),sourceVersion:offer.sourceVersion};}
function marketStageError(error: unknown) {
  if (!(error instanceof ContinuityError)) return new ContinuityError("MARKET_SEARCH_FAILED", "Live market search failed", 502);
  if (error.code === "NO_SUPPORTED_MARKET_SOURCE") return error;
  if (["LIVE_MARKET_CONFIGURATION_MISSING", "LIVE_MARKET_PROVIDER_FAILED"].includes(error.code)) return new ContinuityError("SERPAPI_UNAVAILABLE", "The live market provider is unavailable", error.status, error.details);
  if (["INSUFFICIENT_PRICING_EVIDENCE", "NO_FEASIBLE_MARKET_OFFER"].includes(error.code)) return new ContinuityError("NO_VALID_OFFERS", "No valid price-backed offers were found", error.status, error.details);
  return new ContinuityError("MARKET_SEARCH_FAILED", "Live market search failed", error.status, error.details);
}
function evidenceStageError(error: unknown) {
  if (error instanceof ContinuityError && error.code.startsWith("EVIDENCE_")) return new ContinuityError("EVIDENCE_UNAVAILABLE", "Market evidence is temporarily unavailable", error.status, error.details);
  if (error instanceof ContinuityError && error.code.startsWith("MISSION_COMPILER_")) return new ContinuityError("EVIDENCE_UNAVAILABLE", "Market evidence is temporarily unavailable", error.status, error.details);
  if (error instanceof ContinuityError && error.code === "NO_FEASIBLE_MARKET_OFFER") return new ContinuityError("NO_VALID_OFFERS", "No valid evidence-qualified offers were found", error.status, error.details);
  return error;
}

export class ContinuityService {
  constructor(private readonly database:Database=db,private readonly compiler=new MissionCompiler(),private readonly decisionEngine=new EvidenceDecisionEngine(),private readonly marketGatewayFactory:MarketGatewayFactory=(mode)=>new MarketGateway(mode)){}
  async understand(input:MissionUnderstandingInput) {
    const spec = await this.compiler.compile(input);
    const gateway = this.marketGatewayFactory();
    return this.database.transaction(async transaction => {
      const [mission] = await transaction.insert(missions).values({goal:spec.goal,budgetAmount:spec.budgetPaise,deadline:spec.deadline?new Date(spec.deadline):new Date(Date.now()+7*86400000),constraints:{},status:"PLANNING"}).returning();
      await transaction.insert(continuityMissions).values({missionId:mission.id,spec,marketMode:gateway.mode,outcomeStatus:"PLANNED",repairAllowancePaise:spec.repairAuthority.maxAdditionalSpendPaise,allowAutomaticSubstitution:spec.repairAuthority.allowAutomaticSubstitution});
      await transaction.insert(missionEvents).values([{missionId:mission.id,type:"MISSION_CREATED",missionVersion:mission.version,data:{continuity:true,budgetPaise:spec.budgetPaise}},{missionId:mission.id,type:"MISSION_COMPILATION_COMPLETED",missionVersion:mission.version,data:{needs:spec.needs.length,marketMode:gateway.mode}}]);
      return { missionId: mission.id, missionVersion: mission.version, spec };
    });
  }
  async build(input:MissionSearchInput){
    const marketStartedAt=Date.now();
    const [mission]=await this.database.select().from(missions).where(eq(missions.id,input.missionId));
    if(!mission)throw new ContinuityError("MISSION_NOT_FOUND","Mission not found",404);
    if(mission.version!==input.missionVersion)throw new ContinuityError("STALE_PLAN","Mission version is stale",409);
    if(mission.status!=="PLANNING")throw new ContinuityError("MARKET_SEARCH_NOT_ALLOWED","Mission is not awaiting market search",409);
    const [continuity]=await this.database.select().from(continuityMissions).where(eq(continuityMissions.missionId,mission.id));
    if(!continuity)throw new ContinuityError("MISSION_NOT_FOUND","Compiled mission specification not found",404);
    const spec=missionSpecSchema.parse(continuity.spec);
    marketDiagnostic("MARKET_START",{missionId:mission.id,needCount:spec.needs.length});
    const gateway=this.marketGatewayFactory(continuity.marketMode as "live" | "sandbox");
    try{
      const context={missionId:mission.id,locationLabel:spec.location?.label,latitude:spec.location?.latitude,longitude:spec.location?.longitude};
      let groups;
      marketDiagnostic("SHOPPING_REQUEST_START",{needCount:spec.needs.length});
      try { groups=await gateway.search(spec.needs,context); } catch(error) { throw marketStageError(error); }
      marketDiagnostic("CANDIDATE_NORMALIZATION",{elapsedMs:Date.now()-marketStartedAt,candidateCount:groups.reduce((total,group)=>total+group.offers.length,0)});
      const offersByNeed=new Map<string,(typeof marketOfferSnapshots.$inferSelect)[]>();
      for(const group of groups){
        const pricedOffers=group.offers.filter(hasKnownPrice);
        await this.database.insert(marketSearches).values({missionId:mission.id,needId:group.need.id,connectorId:group.connectorId??"unsupported",query:group.query,status:pricedOffers.length?"SUCCEEDED":"PARTIAL",resultCount:group.offers.length,errorCode:group.error?.code??null});
        if(pricedOffers.length){const saved=await this.database.insert(marketOfferSnapshots).values(pricedOffers.map(o=>snapshotValues(mission.id,o))).returning();offersByNeed.set(group.need.id,saved);}
      }
      const unavailableNeed=spec.needs.find(need=>!offersByNeed.has(need.id));
      if(unavailableNeed)throw new ContinuityError("NO_FEASIBLE_MARKET_OFFER",`No valid price-backed offer satisfies ${unavailableNeed.label}`,409,{needId:unavailableNeed.id});
      const candidateMap=new Map([...offersByNeed].map(([needId,offers])=>[needId,offers.map(offer=>({id:offer.id,needId:offer.needId,title:offer.title,merchantName:offer.merchantName,sourceUrl:offer.sourceUrl,sourceProvider:offer.sourceProvider,pricePaise:offer.pricePaise,attributes:offer.attributes,evidence:offer.evidence}))]));
      let decision;
      marketDiagnostic("EVIDENCE_REQUEST_START",{elapsedMs:Date.now()-marketStartedAt});
      try { decision=await this.decisionEngine.decide(mission.id,spec,candidateMap,gateway.mode==="live"); } catch(error) { throw evidenceStageError(error); }
      for(const need of spec.needs){const group=groups.find(item=>item.need.id===need.id);const priced=group?.offers.filter(hasKnownPrice)??[];const assessments=decision.assessments.filter(item=>item.needId===need.id);marketDiagnostic("PRICE_BACKED_CANDIDATE_COUNTS",{needId:need.id,shoppingResultsReturned:group?.offers.length??0,candidatesWithParsedPrice:priced.length,candidatesRejectedIdentity:assessments.filter(item=>item.identityConfidence==="LOW"||item.riskFlags.includes("VARIANT_AMBIGUOUS")).length,candidatesRejectedCapability:assessments.filter(item=>!item.hardConstraints.satisfied).length,candidatesRejectedPrice:0,candidatesRemaining:assessments.filter(item=>item.identityConfidence!=="LOW"&&!item.riskFlags.includes("VARIANT_AMBIGUOUS")&&item.hardConstraints.satisfied).length});}
      marketDiagnostic("CAPABILITY_VALIDATION",{elapsedMs:Date.now()-marketStartedAt,assessmentCount:decision.assessments.length});
      const chosen=decision.portfolios.find(portfolio=>portfolio.type===decision.selectedPortfolio);
      if(!chosen)throw new ContinuityError("PORTFOLIO_NOT_MISSION_VALID","Selected portfolio was not produced",409);
      validateMissionPortfolio(spec,chosen.itemSnapshotIds,candidateMap,decision.assessments);
      marketDiagnostic("PORTFOLIO_OPTIMIZATION",{elapsedMs:Date.now()-marketStartedAt,portfolioCount:decision.portfolios.length});
      if(decision.evidence.length)await this.database.insert(productEvidence).values(decision.evidence);
      if(decision.assessments.length)await this.database.insert(candidateAssessments).values(decision.assessments.map(assessment=>({missionId:mission.id,needId:assessment.needId,offerSnapshotId:assessment.offerSnapshotId,assessment,utilityScore:assessment.scores.utility})));
      await this.database.insert(decisionRuns).values({missionId:mission.id,profile:decision.profile,weights:decision.weights,portfolios:decision.portfolios,selectedPortfolio:decision.selectedPortfolio,status:"SUCCEEDED"});
      const view=await this.reservePlan(mission.id,input.missionVersion,spec,offersByNeed,chosen?.itemSnapshotIds);
      marketDiagnostic("MARKET_END",{missionId:mission.id,elapsedMs:Date.now()-marketStartedAt,status:"SUCCEEDED"});
      return view;
    }catch(error){await this.database.update(missions).set({status:"INVALIDATED",updatedAt:new Date()}).where(and(eq(missions.id,mission.id),eq(missions.version,input.missionVersion),eq(missions.status,"PLANNING")));throw error;}
  }
  private async reservePlan(missionId:string,expectedVersion:number,spec:ReturnType<typeof missionSpecSchema.parse>,groups:Map<string,(typeof marketOfferSnapshots.$inferSelect)[]>,selectedSnapshotIds:string[]=[]){
    const preferred=new Set(selectedSnapshotIds);
    return this.database.transaction(async tx=>{const [mission]=await tx.select().from(missions).where(eq(missions.id,missionId)).for("update");if(!mission)throw new ContinuityError("MISSION_NOT_FOUND","Mission not found",404);if(mission.version!==expectedVersion)throw new ContinuityError("STALE_PLAN","Mission changed during market search",409);if(mission.status!=="PLANNING")throw new ContinuityError("MARKET_SEARCH_NOT_ALLOWED","Mission is not awaiting market search",409);const selected=spec.needs.map(need=>{const candidates=(groups.get(need.id)??[]).filter(o=>attributesSatisfy(need,o)).sort((a,b)=>Number(preferred.has(b.id))-Number(preferred.has(a.id))||compareLocationThenPrice(a,b));if(!candidates[0])throw new ContinuityError("NO_VALID_OFFERS",`No price-backed offer satisfies ${need.label}`,409,{needId:need.id});return{need,offer:candidates[0]};});const total=selected.reduce((n,x)=>n+x.offer.pricePaise*x.need.quantity,0);if(total>mission.budgetAmount)throw new ContinuityError("BUDGET_EXCEEDED","Live mission exceeds maximum authority",409,{budgetPaise:mission.budgetAmount,informationalTotal:total});await tx.update(missions).set({status:"RESERVING",updatedAt:new Date()}).where(eq(missions.id,mission.id));await tx.insert(continuitySelections).values(selected.map(x=>({missionId,needId:x.need.id,snapshotId:x.offer.id,reservedPricePaise:x.offer.pricePaise*x.need.quantity,status:"SELECTED"})));const version=mission.version+1;await tx.update(missions).set({status:"READY_TO_COMMIT",reservedAmount:total,version,updatedAt:new Date()}).where(eq(missions.id,mission.id));await tx.insert(missionEvents).values([{missionId,type:"CONTINUITY_AUTHORITY_RESERVED",missionVersion:version,data:{amount:total,components:selected.length,authorityType:"MISSIONPAY_LOGICAL_FINANCIAL_AUTHORITY",locationLabel:spec.location?.label??null}},{missionId,type:"MISSION_READY_TO_COMMIT",missionVersion:version,data:{reservedAmount:total,optimization:"EVIDENCE_DECISION_ENGINE"}}]);return this.get(missionId,tx);});
  }
  async get(missionId:string,database:Database|DbTransaction=this.database){
    const [mission]=await database.select().from(missions).where(eq(missions.id,missionId));if(!mission)return null;
    const [continuity]=await database.select().from(continuityMissions).where(eq(continuityMissions.missionId,missionId));if(!continuity)return null;
    const spec=missionSpecSchema.parse(continuity.spec);
    const selections=await database.select({id:continuitySelections.id,needId:continuitySelections.needId,status:continuitySelections.status,reservedPricePaise:continuitySelections.reservedPricePaise,snapshotId:marketOfferSnapshots.id,title:marketOfferSnapshots.title,merchantName:marketOfferSnapshots.merchantName,sourceProvider:marketOfferSnapshots.sourceProvider,externalId:marketOfferSnapshots.externalId,sourceUrl:marketOfferSnapshots.sourceUrl,pricePaise:marketOfferSnapshots.pricePaise,availability:marketOfferSnapshots.availability,attributes:marketOfferSnapshots.attributes,evidence:marketOfferSnapshots.evidence,observedAt:marketOfferSnapshots.observedAt,sourceVersion:marketOfferSnapshots.sourceVersion}).from(continuitySelections).innerJoin(marketOfferSnapshots,eq(continuitySelections.snapshotId,marketOfferSnapshots.id)).where(eq(continuitySelections.missionId,missionId)).orderBy(continuitySelections.createdAt);
    const events=await database.select().from(missionOutcomeEvents).where(eq(missionOutcomeEvents.missionId,missionId)).orderBy(missionOutcomeEvents.createdAt);
    const [decision]=await database.select().from(decisionRuns).where(eq(decisionRuns.missionId,missionId)).orderBy(desc(decisionRuns.createdAt)).limit(1);
    const assessments=decision?await database.select().from(candidateAssessments).where(eq(candidateAssessments.missionId,missionId)):[];
    const evidence=decision?await database.select({id:productEvidence.id,offerSnapshotId:productEvidence.offerSnapshotId,type:productEvidence.type,sourceName:productEvidence.sourceName,sourceUrl:productEvidence.sourceUrl,title:productEvidence.title,snippet:productEvidence.snippet,evidenceMode:productEvidence.evidenceMode,productIdentityConfidence:productEvidence.productIdentityConfidence,observedAt:productEvidence.observedAt}).from(productEvidence).where(eq(productEvidence.missionId,missionId)):[];
    return{mission:{id:mission.id,goal:mission.goal,status:mission.status,version:mission.version,budgetPaise:mission.budgetAmount,reservedPaise:mission.reservedAmount,committedPaise:mission.committedAmount,remainingPaise:mission.budgetAmount-mission.reservedAmount-mission.committedAmount},spec,marketMode:continuity.marketMode,outcomeStatus:continuity.outcomeStatus,repairAllowancePaise:continuity.repairAllowancePaise,selections,events,decision:decision?{profile:decision.profile,weights:decision.weights,portfolios:decision.portfolios as unknown as DecisionPortfolio[],selectedPortfolio:decision.selectedPortfolio,requiresRevalidation:decision.requiresRevalidation}:null,assessments:assessments.map(row=>row.assessment),evidence};
  }
  async getWithRepairs(missionId: string, database: Database | DbTransaction = this.database) {
    const view = await this.get(missionId, database);
    if (!view) return null;
    const repairs = await database.select({ id: continuityRepairAttempts.id, affectedNeedId: continuityRepairAttempts.affectedNeedId, originalSelectionId: continuityRepairAttempts.originalSelectionId, replacementSnapshotId: continuityRepairAttempts.replacementSnapshotId, replacementTitle: marketOfferSnapshots.title, replacementMerchant: marketOfferSnapshots.merchantName, originalPaymentOrderId: continuityRepairAttempts.originalPaymentOrderId, oldPricePaise: continuityRepairAttempts.oldPricePaise, newPricePaise: continuityRepairAttempts.newPricePaise, additionalSpendPaise: continuityRepairAttempts.additionalSpendPaise, authorizedAdditionalSpendPaise: continuityRepairAttempts.authorizedAdditionalSpendPaise, refundRequiredPaise: continuityRepairAttempts.refundRequiredPaise, status: continuityRepairAttempts.status, createdAt: continuityRepairAttempts.createdAt })
      .from(continuityRepairAttempts).innerJoin(marketOfferSnapshots, eq(continuityRepairAttempts.replacementSnapshotId, marketOfferSnapshots.id)).where(eq(continuityRepairAttempts.missionId, missionId)).orderBy(desc(continuityRepairAttempts.createdAt));
    const repairPayments = await database.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.missionId, missionId)).orderBy(desc(continuityRepairPaymentOrders.createdAt));
    const originalPayments = await database.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.missionId, missionId)).orderBy(desc(missionPaymentOrders.createdAt));
    return { ...view, repairs, payments: { original: originalPayments, repairs: repairPayments } };
  }

  async selectPortfolio(missionId: string, type: DecisionPortfolio["type"], expectedVersion: number) {
    await this.database.transaction(async transaction => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, missionId)).for("update");
      if (!mission) throw new ContinuityError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.version !== expectedVersion) throw new ContinuityError("STALE_PLAN", "Mission version is stale", 409);
      if (mission.status !== "READY_TO_COMMIT") throw new ContinuityError("PORTFOLIO_CHANGE_NOT_ALLOWED", "Portfolio can change only before payment begins", 409);
      const [decision] = await transaction.select().from(decisionRuns).where(eq(decisionRuns.missionId, missionId)).orderBy(desc(decisionRuns.createdAt)).limit(1).for("update");
      if (!decision) throw new ContinuityError("DECISION_NOT_FOUND", "Mission decision run was not found", 404);
      if (decision.selectedPortfolio === type) return;
      const portfolio = (decision.portfolios as unknown as DecisionPortfolio[]).find(candidate => candidate.type === type);
      if (!portfolio) throw new ContinuityError("INVALID_PORTFOLIO", "Requested portfolio is unavailable", 409);
      const snapshots = await transaction.select().from(marketOfferSnapshots).where(and(eq(marketOfferSnapshots.missionId, missionId), inArray(marketOfferSnapshots.id, portfolio.itemSnapshotIds)));
      const [continuity] = await transaction.select().from(continuityMissions).where(eq(continuityMissions.missionId, missionId));
      if (!continuity) throw new ContinuityError("MISSION_NOT_FOUND", "Continuity mission not found", 404);
      const spec = missionSpecSchema.parse(continuity.spec);
      if (snapshots.length !== spec.needs.length || new Set(snapshots.map(snapshot => snapshot.needId)).size !== spec.needs.length) throw new ContinuityError("INVALID_PORTFOLIO", "Portfolio does not satisfy every required need", 409);
      const total = snapshots.reduce((sum, snapshot) => sum + snapshot.pricePaise * (spec.needs.find(need => need.id === snapshot.needId)?.quantity ?? 1), 0);
      if (total > mission.budgetAmount) throw new ContinuityError("BUDGET_EXCEEDED", "Portfolio exceeds mission authority", 409);
      await transaction.update(continuitySelections).set({ status: "REPLACED", updatedAt: new Date() }).where(and(eq(continuitySelections.missionId, missionId), eq(continuitySelections.status, "SELECTED")));
      await transaction.insert(continuitySelections).values(snapshots.map(snapshot => ({ missionId, needId: snapshot.needId, snapshotId: snapshot.id, reservedPricePaise: snapshot.pricePaise * (spec.needs.find(need => need.id === snapshot.needId)?.quantity ?? 1), status: "SELECTED" })));
      const version = mission.version + 1;
      await transaction.update(missions).set({ reservedAmount: total, version, updatedAt: new Date() }).where(eq(missions.id, missionId));
      await transaction.update(decisionRuns).set({ selectedPortfolio: type, requiresRevalidation: true }).where(eq(decisionRuns.id, decision.id));
      await transaction.insert(missionEvents).values({ missionId, type: "MISSION_PORTFOLIO_SELECTED", missionVersion: version, data: { portfolio: type, reservedAmount: total, requiresRevalidation: true } });
    });
    return this.getWithRepairs(missionId);
  }

  async replace(missionId:string,needId:string,expectedVersion:number){return this.database.transaction(async tx=>{const [mission]=await tx.select().from(missions).where(eq(missions.id,missionId)).for("update");if(!mission)throw new ContinuityError("MISSION_NOT_FOUND","Mission not found",404);if(mission.version!==expectedVersion)throw new ContinuityError("STALE_PLAN","Mission version is stale",409);if(!["READY_TO_COMMIT","PAID"].includes(mission.status))throw new ContinuityError("REPAIR_NOT_ALLOWED","Mission is not repairable in its current state",409);const [current]=await tx.select().from(continuitySelections).where(and(eq(continuitySelections.missionId,missionId),eq(continuitySelections.needId,needId),inArray(continuitySelections.status,[...activeStatuses,"DEGRADED"]))).for("update");if(!current)throw new ContinuityError("NEED_NOT_SELECTED","Selected need not found",404);const [alternative]=await tx.select().from(marketOfferSnapshots).where(and(eq(marketOfferSnapshots.missionId,missionId),eq(marketOfferSnapshots.needId,needId),ne(marketOfferSnapshots.id,current.snapshotId))).orderBy(marketOfferSnapshots.pricePaise).limit(1);if(!alternative)throw new ContinuityError("NO_REPLACEMENT","No alternate observed offer is available",409);const [continuity]=await tx.select().from(continuityMissions).where(eq(continuityMissions.missionId,missionId));const delta=alternative.pricePaise-current.reservedPricePaise;if(mission.status==="PAID"&&delta>0){const outcomeStatus=continuity.allowAutomaticSubstitution&&delta<=continuity.repairAllowancePaise?"REPAIR_PAYMENT_REQUIRED":"HUMAN_REAUTH_REQUIRED";await tx.update(continuityMissions).set({outcomeStatus,updatedAt:new Date()}).where(eq(continuityMissions.missionId,missionId));await tx.insert(missionOutcomeEvents).values({missionId,needId,type:"CONTINUITY_REPAIR_PROPOSED",data:{oldPricePaise:current.reservedPricePaise,newPricePaise:alternative.pricePaise,additionalSpendPaise:delta,withinRepairAuthority:delta<=continuity.repairAllowancePaise}});return this.get(missionId,tx);}const nextReserved=mission.status==="PAID"?mission.reservedAmount:mission.reservedAmount-current.reservedPricePaise+alternative.pricePaise;if(nextReserved+mission.committedAmount>mission.budgetAmount)throw new ContinuityError("HUMAN_REAUTH_REQUIRED","Replacement exceeds initial authority",409,{additionalAuthorityPaise:nextReserved+mission.committedAmount-mission.budgetAmount});await tx.update(continuitySelections).set({status:"REPLACED",updatedAt:new Date()}).where(eq(continuitySelections.id,current.id));await tx.insert(continuitySelections).values({missionId,needId,snapshotId:alternative.id,status:"SELECTED",reservedPricePaise:alternative.pricePaise,replacedSelectionId:current.id});const version=mission.version+1;await tx.update(missions).set({reservedAmount:nextReserved,version,updatedAt:new Date()}).where(eq(missions.id,missionId));if(mission.status==="PAID")await tx.update(continuityMissions).set({outcomeStatus:"ACTIVE",updatedAt:new Date()}).where(eq(continuityMissions.missionId,missionId));await tx.insert(missionEvents).values({missionId,type:"MINIMAL_LIVE_REPAIR_COMPLETED",missionVersion:version,data:{needId,preservedCount:missionSpecSchema.parse(continuity.spec).needs.length-1,oldPricePaise:current.reservedPricePaise,newPricePaise:alternative.pricePaise,refundRequiredPaise:Math.max(0,-delta)}});return this.get(missionId,tx);});}
  async replaceFresh(missionId: string, needId: string, expectedVersion: number) {
    const before = await this.get(missionId);
    if (!before) throw new ContinuityError("MISSION_NOT_FOUND", "Mission not found", 404);
    if (before.mission.version !== expectedVersion) throw new ContinuityError("STALE_PLAN", "Mission version is stale", 409);
    const need = before.spec.needs.find((candidate) => candidate.id === needId);
    if (!need) throw new ContinuityError("NEED_NOT_SELECTED", "Mission need not found", 404);
    const priorAssessments = await this.database.select({ offerSnapshotId: candidateAssessments.offerSnapshotId, utilityScore: candidateAssessments.utilityScore }).from(candidateAssessments).where(and(eq(candidateAssessments.missionId, missionId), eq(candidateAssessments.needId, needId)));
    const candidateUtilities = new Map(priorAssessments.map(assessment => [assessment.offerSnapshotId, assessment.utilityScore]));

    let freshSnapshotIds: string[] | null = null;
    if (before.marketMode === "live") {
      const gateway = new MarketGateway("live");
      const [result] = await gateway.search([need], { missionId, locationLabel: before.spec.location?.label, latitude: before.spec.location?.latitude, longitude: before.spec.location?.longitude });
      const context = { missionId, locationLabel: before.spec.location?.label, latitude: before.spec.location?.latitude, longitude: before.spec.location?.longitude };
      const pricedOffers = result.offers.filter(hasKnownPrice);
      await this.database.insert(marketSearches).values({ missionId, needId, connectorId: result.connectorId ?? "unsupported", query: marketQueryFor(need, context), status: pricedOffers.length ? "SUCCEEDED" : "PARTIAL", resultCount: result.offers.length, errorCode: result.error?.code ?? null });
      if (!pricedOffers.length) throw result.error ?? new ContinuityError("NO_REPLACEMENT", "Fresh live search returned no selectable replacement", 409);
      const saved = await this.database.insert(marketOfferSnapshots).values(pricedOffers.map((offer) => snapshotValues(missionId, offer))).returning();
      const replacementSpec = { ...before.spec, needs: [need], outcome: { ...before.spec.outcome, requiredNeedIds: [need.id] } };
      const replacementCandidates = new Map([[need.id, saved.map(offer => ({ id: offer.id, needId: offer.needId, title: offer.title, merchantName: offer.merchantName, sourceUrl: offer.sourceUrl, sourceProvider: offer.sourceProvider, pricePaise: offer.pricePaise, attributes: offer.attributes, evidence: offer.evidence }))]]);
      const replacementDecision = await this.decisionEngine.decide(missionId, replacementSpec, replacementCandidates, true);
      if (replacementDecision.evidence.length) await this.database.insert(productEvidence).values(replacementDecision.evidence);
      if (replacementDecision.assessments.length) await this.database.insert(candidateAssessments).values(replacementDecision.assessments.map(assessment => ({ missionId, needId, offerSnapshotId: assessment.offerSnapshotId, assessment, utilityScore: assessment.scores.utility })));
      for (const assessment of replacementDecision.assessments) candidateUtilities.set(assessment.offerSnapshotId, assessment.scores.utility);
      const rejectedExternalIds = new Set(before.selections.filter((selection) => selection.needId === needId).map((selection) => selection.externalId).filter((value): value is string => Boolean(value)));
      freshSnapshotIds = saved.filter((snapshot) => attributesSatisfy(need, snapshot) && (!snapshot.externalId || !rejectedExternalIds.has(snapshot.externalId))).map((snapshot) => snapshot.id);
      if (!freshSnapshotIds.length) throw new ContinuityError("NO_REPLACEMENT", "Fresh live search found no different offer satisfying this need", 409);
    }

    const result = await this.database.transaction(async (transaction) => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, missionId)).for("update");
      if (!mission) throw new ContinuityError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.version !== expectedVersion) throw new ContinuityError("STALE_PLAN", "Mission changed while searching for a replacement", 409);
      if (!["READY_TO_COMMIT", "PAID"].includes(mission.status)) throw new ContinuityError("REPAIR_NOT_ALLOWED", "Mission is not repairable in its current state", 409);
      const [current] = await transaction.select().from(continuitySelections).where(and(eq(continuitySelections.missionId, missionId), eq(continuitySelections.needId, needId), inArray(continuitySelections.status, [...activeStatuses, "DEGRADED"]))).for("update");
      if (!current) throw new ContinuityError("NEED_NOT_SELECTED", "Selected need not found", 404);
      const candidates = freshSnapshotIds
        ? await transaction.select().from(marketOfferSnapshots).where(and(eq(marketOfferSnapshots.missionId, missionId), eq(marketOfferSnapshots.needId, needId), inArray(marketOfferSnapshots.id, freshSnapshotIds))).orderBy(marketOfferSnapshots.pricePaise)
        : await transaction.select().from(marketOfferSnapshots).where(and(eq(marketOfferSnapshots.missionId, missionId), eq(marketOfferSnapshots.needId, needId), ne(marketOfferSnapshots.id, current.snapshotId))).orderBy(marketOfferSnapshots.pricePaise);
      const alternative = candidates.filter((candidate) => attributesSatisfy(need, candidate)).sort((a,b)=>(candidateUtilities.get(b.id)??0)-(candidateUtilities.get(a.id)??0)||compareLocationThenPrice(a,b))[0];
      if (!alternative) throw new ContinuityError("NO_REPLACEMENT", "No different offer satisfies this need", 409);
      const [continuity] = await transaction.select().from(continuityMissions).where(eq(continuityMissions.missionId, missionId));
      if (!continuity) throw new ContinuityError("MISSION_NOT_FOUND", "Continuity mission not found", 404);
      const delta = alternative.pricePaise - current.reservedPricePaise;
      const version = mission.version + 1;

      if (mission.status === "PAID") {
        const [originalPayment] = await transaction.select().from(missionPaymentOrders).where(and(eq(missionPaymentOrders.missionId, missionId), eq(missionPaymentOrders.status, "CAPTURED"))).orderBy(desc(missionPaymentOrders.createdAt)).limit(1);
        if (!originalPayment) throw new ContinuityError("ORIGINAL_PAYMENT_NOT_FOUND", "Captured original payment not found", 409);
        const priorRepairs = await transaction.select().from(continuityRepairAttempts).where(eq(continuityRepairAttempts.missionId, missionId)).for("update");
        if (priorRepairs.some((repair) => ["REPAIR_AUTHORIZED", "HUMAN_REAUTH_REQUIRED", "REPAIR_PAYMENT_PENDING"].includes(repair.status))) throw new ContinuityError("REPAIR_ALREADY_PENDING", "Finish the active continuity repair before starting another", 409);
        const automaticAuthorityUsed = priorRepairs.filter((repair) => repair.status === "REPAIR_PAYMENT_CAPTURED").reduce((sum, repair) => sum + repair.additionalSpendPaise, 0);
        const automaticAuthorityRemaining = Math.max(0, continuity.repairAllowancePaise - automaticAuthorityUsed);
        const additionalSpend = Math.max(0, delta);
        const refundRequired = Math.max(0, -delta);
        const withinAuthority = continuity.allowAutomaticSubstitution && additionalSpend <= automaticAuthorityRemaining;
        const status = additionalSpend === 0 ? "FINALIZED_NO_PAYMENT" : withinAuthority ? "REPAIR_AUTHORIZED" : "HUMAN_REAUTH_REQUIRED";
        const [repairAttempt] = await transaction.insert(continuityRepairAttempts).values({ missionId, affectedNeedId: needId, originalSelectionId: current.id, replacementSnapshotId: alternative.id, originalPaymentOrderId: originalPayment.id, oldPricePaise: current.reservedPricePaise, newPricePaise: alternative.pricePaise, additionalSpendPaise: additionalSpend, authorizedAdditionalSpendPaise: withinAuthority ? additionalSpend : automaticAuthorityRemaining, refundRequiredPaise: refundRequired, status }).returning();
        if (additionalSpend === 0) {
          await transaction.update(continuitySelections).set({ status: "REPLACED", updatedAt: new Date() }).where(eq(continuitySelections.id, current.id));
          await transaction.insert(continuitySelections).values({ missionId, needId, snapshotId: alternative.id, status: "SELECTED", reservedPricePaise: alternative.pricePaise, replacedSelectionId: current.id });
        }
        const outcomeStatus = additionalSpend === 0 ? "ACTIVE" : status;
        await transaction.update(continuityMissions).set({ outcomeStatus, updatedAt: new Date() }).where(eq(continuityMissions.missionId, missionId));
        await transaction.update(missions).set({ version, updatedAt: new Date() }).where(eq(missions.id, missionId));
        await transaction.insert(missionOutcomeEvents).values({ missionId, needId, type: additionalSpend === 0 ? "CONTINUITY_REPAIR_FINALIZED_NO_PAYMENT" : status, data: { repairAttemptId: repairAttempt.id, replacementSnapshotId: alternative.id, oldPricePaise: current.reservedPricePaise, newPricePaise: alternative.pricePaise, additionalSpendPaise: additionalSpend, refundRequiredPaise: refundRequired, preservedCount: before.spec.needs.length - 1 } });
        return { version, requiresRevalidation: before.marketMode === "live" };
      }

      const nextReserved = mission.reservedAmount - current.reservedPricePaise + alternative.pricePaise;
      if (nextReserved + mission.committedAmount > mission.budgetAmount) throw new ContinuityError("HUMAN_REAUTH_REQUIRED", "Replacement exceeds initial authority", 409, { additionalAuthorityPaise: nextReserved + mission.committedAmount - mission.budgetAmount });
      await transaction.update(continuitySelections).set({ status: "REPLACED", updatedAt: new Date() }).where(eq(continuitySelections.id, current.id));
      await transaction.insert(continuitySelections).values({ missionId, needId, snapshotId: alternative.id, status: "SELECTED", reservedPricePaise: alternative.pricePaise, replacedSelectionId: current.id });
      await transaction.update(missions).set({ reservedAmount: nextReserved, version, updatedAt: new Date() }).where(eq(missions.id, missionId));
      await transaction.update(continuityMissions).set({ outcomeStatus: "ACTIVE", updatedAt: new Date() }).where(eq(continuityMissions.missionId, missionId));
      const [decision] = await transaction.select().from(decisionRuns).where(eq(decisionRuns.missionId, missionId)).orderBy(desc(decisionRuns.createdAt)).limit(1).for("update");
      if (decision) {
        const portfolios = (decision.portfolios as unknown as DecisionPortfolio[]).map((portfolio) => portfolio.type === decision.selectedPortfolio ? { ...portfolio, itemSnapshotIds: portfolio.itemSnapshotIds.map((id) => id === current.snapshotId ? alternative.id : id), totalPricePaise: nextReserved } : portfolio);
        await transaction.update(decisionRuns).set({ portfolios, requiresRevalidation: before.marketMode === "live" }).where(eq(decisionRuns.id, decision.id));
      }
      await transaction.insert(missionEvents).values({ missionId, type: "MINIMAL_LIVE_REPAIR_COMPLETED", missionVersion: version, data: { needId, preservedCount: before.spec.needs.length - 1, oldPricePaise: current.reservedPricePaise, newPricePaise: alternative.pricePaise, freshMarketSearch: before.marketMode === "live" } });
      return { version, requiresRevalidation: before.marketMode === "live" };
    });
    if (result.requiresRevalidation) await this.revalidate(missionId, result.version);
    return this.getWithRepairs(missionId);
  }

  async revalidate(missionId:string,expectedVersion:number){const current=await this.get(missionId);if(!current)throw new ContinuityError("MISSION_NOT_FOUND","Mission not found",404);if(current.mission.version!==expectedVersion)throw new ContinuityError("STALE_PLAN","Mission version is stale",409);const gateway=new MarketGateway(current.marketMode as "live"|"sandbox");const selected=current.selections.filter(s=>activeStatuses.includes(s.status));const results=await Promise.allSettled(selected.map(async selection=>{const need=current.spec.needs.find(n=>n.id===selection.needId)!;const offer:MarketOffer={id:selection.snapshotId,needId:selection.needId,source:{provider:selection.sourceProvider,externalId:selection.externalId??undefined,url:selection.sourceUrl??undefined},merchant:{name:selection.merchantName},title:selection.title,pricePaise:selection.pricePaise,currency:"INR",availability:selection.availability as MarketOffer["availability"],observedAt:selection.observedAt.toISOString(),sourceVersion:selection.sourceVersion,attributes:selection.attributes};return{selection,need,offer:await gateway.revalidate(offer,need,{missionId,locationLabel:current.spec.location?.label,latitude:current.spec.location?.latitude,longitude:current.spec.location?.longitude})};}));const uncertain=results.some(r=>r.status==="rejected"||!r.value.offer||!hasKnownPrice(r.value.offer)||r.value.offer.pricePaise!==r.value.selection.pricePaise);if(uncertain){await this.database.transaction(async tx=>{const [m]=await tx.select().from(missions).where(eq(missions.id,missionId)).for("update");if(!m||m.version!==expectedVersion)throw new ContinuityError("STALE_PLAN","Mission changed during revalidation",409);const version=m.version+1;if(m.status==="PAID"){await tx.update(continuityMissions).set({outcomeStatus:"DEGRADED",updatedAt:new Date()}).where(eq(continuityMissions.missionId,missionId));await tx.insert(missionOutcomeEvents).values({missionId,type:"LIVE_REVALIDATION_DEGRADED",data:{reason:"REVALIDATION_UNCERTAIN"}});}else{await tx.update(missions).set({status:"INVALIDATED",version,updatedAt:new Date()}).where(eq(missions.id,missionId));}await tx.insert(missionEvents).values({missionId,type:"LIVE_REVALIDATION_FAILED",missionVersion:version,data:{code:"REVALIDATION_UNCERTAIN"}});});throw new ContinuityError("REVALIDATION_UNCERTAIN","One or more exact products could not be confirmed",409);}await this.database.transaction(async tx=>{const [m]=await tx.select().from(missions).where(eq(missions.id,missionId)).for("update");if(!m||m.version!==expectedVersion)throw new ContinuityError("STALE_PLAN","Mission changed during revalidation",409);for(const result of results){if(result.status!=="fulfilled"||!result.value.offer||!hasKnownPrice(result.value.offer))continue;const [snapshot]=await tx.insert(marketOfferSnapshots).values(snapshotValues(missionId,result.value.offer)).returning();await tx.update(continuitySelections).set({snapshotId:snapshot.id,updatedAt:new Date()}).where(eq(continuitySelections.id,result.value.selection.id));}const version=m.version+1;await tx.update(missions).set({version,updatedAt:new Date()}).where(eq(missions.id,missionId));const [decision]=await tx.select({id:decisionRuns.id}).from(decisionRuns).where(eq(decisionRuns.missionId,missionId)).orderBy(desc(decisionRuns.createdAt)).limit(1).for("update");if(decision)await tx.update(decisionRuns).set({requiresRevalidation:false}).where(eq(decisionRuns.id,decision.id));await tx.insert(missionEvents).values({missionId,type:"LIVE_MARKET_REVALIDATED",missionVersion:version,data:{components:selected.length,locationLabel:current.spec.location?.label??null}});});return this.get(missionId);}
  async prepareForPayment(missionId: string, expectedVersion: number) {
    const current = await this.get(missionId);
    if (!current) return { missionVersion: expectedVersion, marketRevalidated: false };
    if (current.mission.version !== expectedVersion) return { missionVersion: expectedVersion, marketRevalidated: false };
    if (current.mission.status !== "READY_TO_COMMIT") throw new ContinuityError("PAYMENT_NOT_ALLOWED", `Mission must be READY_TO_COMMIT, not ${current.mission.status}`, 409);
    const freshnessSeconds = Number(process.env.MISSIONPAY_MARKET_FRESHNESS_SECONDS ?? 60);
    const selected = current.selections.filter((selection) => activeStatuses.includes(selection.status));
    const stale = Boolean(current.decision?.requiresRevalidation) || selected.some((selection) => Date.now() - selection.observedAt.getTime() > freshnessSeconds * 1000);
    if (!stale) return { missionVersion: expectedVersion, marketRevalidated: false };
    const revalidated = await this.revalidateForPayment(missionId, expectedVersion);
    return { missionVersion: revalidated.mission.version, marketRevalidated: true };
  }

  private async revalidateForPayment(missionId: string, expectedVersion: number) {
    const current = await this.get(missionId);
    if (!current) throw new ContinuityError("MISSION_NOT_FOUND", "Mission not found", 404);
    if (current.mission.version !== expectedVersion) throw new ContinuityError("STALE_PLAN", "Mission version is stale", 409);
    const selected = current.selections.filter((selection) => activeStatuses.includes(selection.status));
    const gateway = new MarketGateway(current.marketMode as "live" | "sandbox");
    const results = await Promise.allSettled(selected.map(async (selection) => {
      const need = current.spec.needs.find((candidate) => candidate.id === selection.needId)!;
      const offer: MarketOffer = { id: selection.snapshotId, needId: selection.needId, source: { provider: selection.sourceProvider, externalId: selection.externalId ?? undefined, url: selection.sourceUrl ?? undefined }, merchant: { name: selection.merchantName }, title: selection.title, pricePaise: selection.pricePaise, currency: "INR", availability: selection.availability as MarketOffer["availability"], observedAt: selection.observedAt.toISOString(), sourceVersion: selection.sourceVersion, attributes: selection.attributes };
      return { selection, need, offer: await gateway.revalidate(offer, need, { missionId, locationLabel: current.spec.location?.label, latitude: current.spec.location?.latitude, longitude: current.spec.location?.longitude }).catch(() => null) };
    }));
    const uncertain = results.filter((result) => result.status === "rejected" || !result.value.offer || !hasKnownPrice(result.value.offer) || result.value.offer.source.provider !== result.value.selection.sourceProvider || Boolean(result.value.selection.externalId && result.value.offer.source.externalId !== result.value.selection.externalId) || !attributesSatisfy(result.value.need, result.value.offer));
    const changed = results.filter((result) => result.status === "fulfilled" && result.value.offer && hasKnownPrice(result.value.offer) && result.value.offer.pricePaise !== result.value.selection.pricePaise);

    if (uncertain.length || changed.length) {
      const affectedSelectionIds = new Set([...uncertain, ...changed].map((result) => result.status === "fulfilled" ? result.value.selection.id : null).filter((id): id is string => Boolean(id)));
      const affectedNeedIds = [...new Set([...uncertain, ...changed].map((result) => result.status === "fulfilled" ? result.value.selection.needId : null).filter((id): id is string => Boolean(id)))];
      const potentialTotal = results.reduce((sum, result) => {
        if (result.status !== "fulfilled" || !result.value.offer || !hasKnownPrice(result.value.offer)) return sum + (result.status === "fulfilled" ? result.value.selection.reservedPricePaise : 0);
        return sum + result.value.offer.pricePaise * result.value.need.quantity;
      }, 0);
      const code = uncertain.length ? "REVALIDATION_UNCERTAIN" : potentialTotal > current.mission.budgetPaise ? "MISSION_OVER_AUTHORITY" : "MARKET_CHANGED";
      await this.database.transaction(async (transaction) => {
        const [mission] = await transaction.select().from(missions).where(eq(missions.id, missionId)).for("update");
        if (!mission || mission.version !== expectedVersion) throw new ContinuityError("STALE_PLAN", "Mission changed during automatic revalidation", 409);
        for (const result of results) if (result.status === "fulfilled" && result.value.offer && hasKnownPrice(result.value.offer)) await transaction.insert(marketOfferSnapshots).values(snapshotValues(missionId, result.value.offer));
        if (affectedSelectionIds.size) await transaction.update(continuitySelections).set({ status: "DEGRADED", updatedAt: new Date() }).where(inArray(continuitySelections.id, [...affectedSelectionIds]));
        await transaction.update(continuityMissions).set({ outcomeStatus: "DEGRADED", updatedAt: new Date() }).where(eq(continuityMissions.missionId, missionId));
        const version = mission.version + 1;
        await transaction.update(missions).set({ version, updatedAt: new Date() }).where(eq(missions.id, missionId));
        await transaction.insert(missionEvents).values({ missionId, type: "LIVE_REVALIDATION_FAILED", missionVersion: version, data: { code, affectedNeedIds, potentialTotalPaise: potentialTotal, budgetPaise: mission.budgetAmount } });
      });
      throw new ContinuityError(code, code === "MARKET_CHANGED" ? "Market changed before payment. Repair the affected component." : code === "MISSION_OVER_AUTHORITY" ? "Market changes put the mission over authority." : "One or more exact products could not be confirmed.", 409, { affectedNeedIds, potentialTotalPaise: potentialTotal, budgetPaise: current.mission.budgetPaise });
    }

    await this.database.transaction(async (transaction) => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, missionId)).for("update");
      if (!mission || mission.version !== expectedVersion) throw new ContinuityError("STALE_PLAN", "Mission changed during automatic revalidation", 409);
      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value.offer || !hasKnownPrice(result.value.offer)) continue;
        const [snapshot] = await transaction.insert(marketOfferSnapshots).values(snapshotValues(missionId, result.value.offer)).returning();
        await transaction.update(continuitySelections).set({ snapshotId: snapshot.id, updatedAt: new Date() }).where(eq(continuitySelections.id, result.value.selection.id));
      }
      const [decision] = await transaction.select({ id: decisionRuns.id }).from(decisionRuns).where(eq(decisionRuns.missionId, missionId)).orderBy(desc(decisionRuns.createdAt)).limit(1).for("update");
      if (decision) await transaction.update(decisionRuns).set({ requiresRevalidation: false }).where(eq(decisionRuns.id, decision.id));
      const version = mission.version + 1;
      await transaction.update(missions).set({ version, updatedAt: new Date() }).where(eq(missions.id, missionId));
      await transaction.insert(missionEvents).values({ missionId, type: "LIVE_MARKET_REVALIDATED", missionVersion: version, data: { components: selected.length, automaticBeforePayment: true, locationLabel: current.spec.location?.label ?? null } });
    });
    return (await this.get(missionId))!;
  }

  async reportIssue(missionId:string,needId:string,issue:string){return this.database.transaction(async tx=>{const [m]=await tx.select().from(missions).where(eq(missions.id,missionId)).for("update");if(!m||m.status!=="PAID")throw new ContinuityError("OUTCOME_NOT_ACTIVE","Issues can be reported after payment capture",409);const [selection]=await tx.select().from(continuitySelections).where(and(eq(continuitySelections.missionId,missionId),eq(continuitySelections.needId,needId),inArray(continuitySelections.status,activeStatuses))).for("update");if(!selection)throw new ContinuityError("NEED_NOT_SELECTED","Selected need not found",404);await tx.update(continuitySelections).set({status:"DEGRADED",updatedAt:new Date()}).where(eq(continuitySelections.id,selection.id));await tx.update(continuityMissions).set({outcomeStatus:"DEGRADED",updatedAt:new Date()}).where(eq(continuityMissions.missionId,missionId));await tx.insert(missionOutcomeEvents).values({missionId,needId,type:"USER_REPORTED_ISSUE",data:{issue,source:"USER"}});return this.get(missionId,tx);});}
}
export const continuityService=new ContinuityService();
