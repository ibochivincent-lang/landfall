export {
  EvidenceTier,
  Direction,
  StpAttestation,
  StpAttestationUnsigned,
  parseStpAttestation,
} from "./schema.js";
export { canonicalize } from "./canonical.js";
export { generateSigningKey, signAttestation, verifyAttestation } from "./sign.js";
export type { Ed25519KeyPair } from "./sign.js";
export {
  computeSlippage,
  aggregateAnchorSlippage,
  MIN_DATA_FLOOR_SAMPLES,
} from "./slippage.js";
export type {
  SlippageObservation,
  SlippageCalculation,
  AnchorSlippageSummary,
} from "./slippage.js";
