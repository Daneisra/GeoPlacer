export { ResourceError, capacityOf, isRgbValue, regenIntervalOf, unlockableColors, validateRules, type ResourceErrorCode } from './rules.js';
export { parseResourceState, serializeResourceState, stateFingerprint, stateFromObservation, validateState } from './state.js';
export {
  advance,
  applyOperation,
  checkEnergy,
  consumeEnergy,
  derivedKind,
  operationCost,
  paintingCapacity,
  timeUntilEnergy,
  type EnergyCheck,
  type ResourceOperation,
} from './energy.js';
export { createResourceManager } from './manager.js';
