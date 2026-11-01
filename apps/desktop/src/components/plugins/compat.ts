import { CONTRACT_VERSION } from "@splyce/pi/contracts";
import type { PackageInstallationRecord } from "@splyce/pi/contracts";

export type Compatibility =
  | { readonly kind: "compatible" }
  | { readonly kind: "incompatible"; readonly reason: string }
  | { readonly kind: "unknown" };

export type PluginRecord = Pick<
  PackageInstallationRecord,
  | "packageId"
  | "installationRevision"
  | "sourceRef"
  | "sourceRevisionOrSnapshot"
  | "contentDigest"
  | "state"
>;

/** Missing or non-integer requirement is unknown, never compatible. */
export function resolveCompatibility(
  requiredContractVersion: number | null | undefined,
  engineContractVersion: number = CONTRACT_VERSION,
): Compatibility {
  if (!Number.isInteger(requiredContractVersion)) return { kind: "unknown" };
  if (requiredContractVersion === engineContractVersion)
    return { kind: "compatible" };
  return {
    kind: "incompatible",
    reason: `Requires contract version ${requiredContractVersion}; engine provides ${engineContractVersion}.`,
  };
}
