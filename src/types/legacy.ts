/** Legacy response format selected by /format/json suffix. */
export type LegacyFormat = 'xml' | 'json';

// ─── UR Advisor ──────────────────────────────────────────────────────────────

export interface LegacyCptRecord {
  code: string;
  name: string;
  incidencerate: string | null;
  cptfrequency?: string | null;
  procfrequency?: string | null;
  visit25: string | null;
  visit50: string | null;
  visit75: string | null;
  visitmean: string | null;
  costmean: string | null;
  odgcaa: string | null;
  paymentflag: string | null;
  costpervisit: string | null;
  // Full mode only
  proctype?: string | null;
  avglostdays?: string | null;
  medianlostdays?: string | null;
  pctneverreturn?: string | null;
  pctzerodays?: string | null;
  taoindex?: string | null;
}

// ICD record with stats — used in icd=9|10 reverse lookup (procedure → ICDs)
export interface LegacyIcdRecord {
  code: string;
  name: string;
  incidencerate: string | null;
  icdfrequency: string | null;   // procedureFrequency from upstream
  visit25: string | null;
  visit50: string | null;
  visit75: string | null;
  visitmean: string | null;
  costmean: string | null;
  odgcaa: string | null;
  paymentflag: string | null;
  costpervisit: string | null;
  // Full mode only
  proctype?: string | null;
  avglostdays?: string | null;
  medianlostdays?: string | null;
  pctneverreturn?: string | null;
  pctzerodays?: string | null;
  taoindex?: string | null;
}

export interface LegacyUraRecord {
  // Standard mode (ICD → procedures)
  icd?: { code: string; name: string };
  cpt?: LegacyCptRecord[];
  proc?: LegacyCptRecord[];
  // Reverse lookup mode (icd=9|10: procedure → ICDs)
  cptInfo?: { code: string; name: string };
  icdStats?: LegacyIcdRecord[];
}

// ─── Best Practice Guide ─────────────────────────────────────────────────────

export interface LegacyBpRecord {
  primaryRTWpath: string | null;
  days1: string | number | null;
  days: string | number | null;
}

export interface LegacyActivityModRecord {
  jobtype: string | null;
  jobmodification: string | null;
}

export interface LegacyPtRecord {
  primarypath: string | null;
  visits: string | number | null;
  weeks: string | number | null;
}

export interface LegacyBpGuideRecord {
  icdcode: string;
  name: string;
  bp: LegacyBpRecord[];
  activitymod: LegacyActivityModRecord[];
  pt: LegacyPtRecord[];
  chiro: LegacyPtRecord[];
}

// ─── One Search ──────────────────────────────────────────────────────────────

export interface LegacySearchResultBase {
  type: string;
  code?: string;
  name: string;
  brand?: string;
  chapter?: string;
}

// ─── Calculator shared ───────────────────────────────────────────────────────

export interface LegacyCalcMeanDurationDays {
  bp?: number;
  cp95?: number;
  cp100?: number;
}

export interface LegacyCalcIcdCodeItem {
  code?: string;
  name?: string;
  stcode?: string | null;
  meandurationdays?: LegacyCalcMeanDurationDays;
}

export interface LegacyCalculatorResponse {
  clientid?: string;
  riskassessment?: Record<string, unknown>;
  adjustedduration?: Record<string, unknown>;
  projectedcosts?: Record<string, unknown>;
  adjustedsummaryguidelines?: Record<string, unknown>;
  comprate?: string;
  icdcodes?: { icdcode: LegacyCalcIcdCodeItem[] } | LegacyCalcIcdCodeItem[];
  fnolcodes?: Record<string, unknown>;
  procsummary?: Record<string, unknown>;
  cfactors?: Record<string, unknown>;
  alertdesc?: Record<string, unknown>;
  notes?: Record<string, unknown>;
  odgurl?: string | null;
  deeplinkurl?: string | null;
}
