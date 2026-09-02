// ODG API v1.2 response shapes (based on mapping review + Swagger)
// Fields are camelCase as returned by the upstream JSON API.

// ─── Formulary: NDC ──────────────────────────────────────────────────────────

export interface OdgNdcInfo {
  productNdc?: string;
  odgNdcCode?: string;
  strength?: string;
  tradeName?: string;
  effectiveDate?: string;        // ISO 8601
  proprietaryName?: string;      // brandName
  nonProprietaryName?: string;   // genericName
  pharmClasses?: string;         // drugClass
  formularyInformation?: unknown[];
}

export interface OdgNdcResponse {
  page?: number;
  pageSize?: number;
  totalRecords?: number;
  ndcInformation?: OdgNdcInfo[];
}

// ─── Formulary: PBS ──────────────────────────────────────────────────────────

export interface OdgPbsInfo {
  pbsCode?: string;
  brandName?: string;
  atcCode?: string;
  manufacCode?: string;
  drugMpName?: string;
  amtMppPreferredTerm?: string;
  formularyInformation?: unknown[];
}

export interface OdgPbsResponse {
  page?: number;
  pageSize?: number;
  totalRecords?: number;
  pbsInformation?: OdgPbsInfo[];
}

// ─── TAO: UR Advisor ─────────────────────────────────────────────────────────

export interface OdgTaoIcd {
  code?: string;
  name?: string;
}

export interface OdgTaoProcedure {
  code?: string;
  name?: string;
  incidenceRate?: number;
  procedureFrequency?: number;
  visit25?: number;
  visit50?: number;
  visit75?: number;
  visitMean?: number;
  costMean?: number;
  odgCAA?: number;
  paymentFlag?: string;
  costPerVisit?: number;
  procedureType?: string;
  averageLostDays?: number;
  medianLostDays?: number;
  percentNeverReturn?: number;
  percentZeroDays?: number;
  taoIndex?: number;
}

export interface OdgTaoItemGroup {
  icd?: OdgTaoIcd;
  procedures?: OdgTaoProcedure[];
}

export interface OdgTaoResponse {
  items?: OdgTaoItemGroup[];
}

// ─── TAO: /tao/procedures response (inverted — parent is procedure, children are ICDs) ──

export interface OdgTaoProceduresItem {
  procedure?: { code?: string; name?: string };
  icds?: OdgTaoProcedure[]; // ICD children share the same stat field names
}

export interface OdgTaoProceduresResponse {
  items?: OdgTaoProceduresItem[];
}

// ─── TAO: /tao/fnol response ─────────────────────────────────────────────────

export interface OdgTaoFnolTaoDataItem {
  icd?: OdgTaoIcd;
  procedures?: OdgTaoProcedure[];
}

export interface OdgTaoFnolItem {
  bodyPartCode?: string;
  bodyPartDescription?: string;
  natureOfInjuryCode?: string;
  natureOfInjuryDescription?: string;
  taoDataItems?: OdgTaoFnolTaoDataItem[];
}

export interface OdgTaoFnolResponse {
  items?: OdgTaoFnolItem[];
}

// ─── Guidelines: Best Practice Guide ────────────────────────────────────────

export interface OdgBestPracticeGuidelineItem {
  pathway?: string;
  minDays?: number;
  maxDays?: number;
  jobClass?: string;
}

export interface OdgActivityModifierItem {
  // TODO/confirm: nested item schema not confirmed
  [key: string]: unknown;
}

export interface OdgPtVisitItem {
  // TODO/confirm: nested item schema not confirmed
  [key: string]: unknown;
}

export interface OdgGuidelineRecord {
  code?: string;
  description?: string;
  bestPracticeGuidelines?: OdgBestPracticeGuidelineItem[];
  activityModifiers?: OdgActivityModifierItem[];
  physicalTherapyVisits?: OdgPtVisitItem[];
  chiropractorVisits?: OdgPtVisitItem[];
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface OdgSearchResultItem {
  // TODO/confirm: result item schema not confirmed
  [key: string]: unknown;
}

export interface OdgSearchResultSet {
  section?: string;
  resultCount?: number;
  results?: OdgSearchResultItem[];
}

export interface OdgSearchResponse {
  resultSets?: OdgSearchResultSet[];
}

// ─── Calculator ──────────────────────────────────────────────────────────────

export interface OdgByMcgLinks {
  duration?: string;
  odgurl?: string;
}

export interface OdgCalcMeanDurationDays {
  bestPractice?: number;
  claimAverage?: number;
  claimMax?: number;
}

export interface OdgCalcIcdCodeItem {
  code?: string;
  name?: string;
  stcode?: string;
  meanDurationDays?: OdgCalcMeanDurationDays;
}

export interface OdgCalcCptCodeItem {
  code?: string;
  name?: string;
  meanDurationDays?: number;
}

export interface OdgCalculatorResponse {
  clientId?: string;
  adjustedSummaryGuidelines?: Record<string, unknown>;
  adjustedDuration?: Record<string, unknown>;
  projectedCosts?: Record<string, unknown>;
  compRate?: number;
  icdCodes?: { icdcode?: OdgCalcIcdCodeItem[] };
  cfactors?: Record<string, unknown>;
  procsummary?: { cptcodes?: { cptcode?: OdgCalcCptCodeItem[] } };
  alertdesc?: Record<string, unknown>;
  riskAssessment?: Record<string, unknown>;
  notes?: unknown[];
  fnolCodes?: Record<string, unknown>;
  odgByMcgLinks?: OdgByMcgLinks;
}
