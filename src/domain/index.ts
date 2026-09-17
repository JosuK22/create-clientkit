/**
 * The V2 composition vocabulary.
 *
 *     ProjectManifest      what the user asked for
 *           ↓
 *     ResolvedProject      what that means technically
 *           ↓
 *     Contribution[]       what each adapter wants
 *           ↓
 *     GenerationPlan       what will be written   (V1, unchanged)
 *           ↓
 *     FileOperation[]      the safety boundary    (V1, unchanged)
 *
 * Types only, plus a few pure helpers. Nothing here is wired into the CLI: V1
 * generation runs exactly as it did, and this module is not imported by it, so
 * the shipped bundle is byte-identical. Later stages connect the two.
 *
 * Internal by construction - the package publishes a `bin` and no `exports`,
 * so none of this is reachable by a consumer. It is a vocabulary for this
 * codebase, not an API.
 */

export {
  ARCHITECTURE_IDS,
  BUILD_TOOL_IDS,
  FEATURE_IDS,
  FRAMEWORK_IDS,
  LANGUAGE_IDS,
  ROUTER_IDS,
  STYLING_IDS,
  UI_LIBRARY_IDS,
} from './dimensions.js';
export type {
  ArchitectureId,
  BuildToolId,
  FeatureId,
  FrameworkId,
  LanguageId,
  RouterId,
  StylingId,
  UiLibraryId,
} from './dimensions.js';

export { CAPABILITIES, describeConstraint } from './capabilities.js';
export type { Capability, Constraint } from './capabilities.js';

export {
  assertCapabilityContracts,
  assertRolesArePlaceable,
  capabilitiesInCategory,
  capabilityBreaches,
  CAPABILITY_CATEGORIES,
  CAPABILITY_CONTRACTS,
  surfacesOf,
} from './capability-contract.js';
export type {
  CapabilityCategory,
  CapabilityContract,
  CapabilitySurface,
  ContractBreach,
  SurfaceKind,
} from './capability-contract.js';

export {
  describeScope,
  DOCUMENT_CONTRIBUTION_KINDS,
  documentContributionIdentity,
  EVERY_PAGE,
  groupDocumentContributions,
  GUARANTEE_SURFACES,
  guaranteesOnSurface,
  onPage,
  scopeKey,
  stanceOf,
  stated,
  suppressed,
} from './document-contribution.js';
export type {
  DocumentContribution,
  DocumentContributionGroup,
  DocumentContributionKind,
  DocumentGuaranteesContribution,
  DocumentScope,
  DocumentStance,
  MetadataContribution,
  MetadataStatement,
  StructuredDataContribution,
} from './document-contribution.js';

export {
  assertBindingsSupported,
  bindingOwner,
  bindingsUsedBy,
  bindingType,
  boundTo,
  derivationParameters,
  derivationType,
  derived,
  describeDocumentValue,
  DOCUMENT_BINDING_IDS,
  DOCUMENT_BINDINGS,
  DOCUMENT_DERIVATIONS,
  DOCUMENT_VALUE_TYPES,
  isDocumentBinding,
  isDocumentDerivation,
  literal,
  ownerOf,
  VALUE_OWNERS,
} from './document-value.js';
export type {
  BindingOfType,
  BindingSupport,
  DerivationOfType,
  DocumentBinding,
  DocumentDerivation,
  DocumentValue,
  DocumentValueType,
  LiteralTypes,
  ValueOwner,
} from './document-value.js';

export {
  appliesTo,
  assertGuaranteesAreDocumentWide,
  describeTarget,
  forPage,
  resolveDocumentForPage,
  SCOPE_SPECIFICITY,
  SITE_TARGET,
} from './document-scope.js';
export type {
  ComposedMetadata,
  ComposedProvenance,
  DocumentTarget,
  ResolvedPageDocument,
} from './document-scope.js';

export {
  assertPlanRealizable,
  bindingsRequiredBy,
  buildDocumentEmission,
  derivationsRequiredBy,
  describeEmissionPlan,
  EMISSION_FIELDS,
  statedValue,
} from './document-emission.js';
export type {
  DocumentEmissionItem,
  DocumentEmissionPlan,
  EmissionField,
  RealizationSupport,
} from './document-emission.js';

export { METADATA_FIELDS, resolveDocumentContributions } from './document-resolution.js';
export type {
  MetadataField,
  Provenance,
  ResolvedDocumentContribution,
  ResolvedGuaranteesContribution,
  ResolvedMetadata,
  ResolvedMetadataContribution,
  ResolvedStance,
  ResolvedStructuredDataContribution,
} from './document-resolution.js';

export { definesRole, FILE_ROLES, resolveRole } from './roles.js';
export type { ArchitectureDefinition, FileRole } from './roles.js';

export { DEPENDENCY_KINDS, emptyContribution, FILE_INTENTS } from './contributions.js';
export type {
  AdapterRef,
  ConfigContribution,
  Contribution,
  DependencyContribution,
  DependencyKind,
  FileContribution,
  FileIntent,
  FilePayload,
  FileTarget,
  ScriptContribution,
  TemplateLayerContribution,
} from './contributions.js';

export { manifestFromProjectContext } from './manifest.js';
export type { ProjectManifest } from './manifest.js';

export type { AdapterSelection, ResolvedProject, SourceExtensions } from './resolved.js';

export { ADAPTER_KINDS, adapterRef } from './adapters.js';
export type {
  Adapter,
  AdapterDeclaration,
  AdapterKind,
  AdapterResolution,
  BuildToolAdapter,
  DimensionOptions,
  FeatureAdapter,
  FrameworkAdapter,
  LanguageAdapter,
  StylingAdapter,
  UiLibraryAdapter,
} from './adapters.js';

export {
  evaluateCombination,
  evaluateDeclaration,
  filterCandidates,
  formatReport,
  formatViolation,
  indexCapabilities,
} from './compatibility.js';
export type {
  Candidate,
  CapabilityIndex,
  CompatibilityReport,
  FilterResult,
  Violation,
} from './compatibility.js';

export { compareNodeFloor, highestNodeFloor, mergeResolutions } from './resolution.js';
export type { MergedResolution, ResolutionInput } from './resolution.js';
