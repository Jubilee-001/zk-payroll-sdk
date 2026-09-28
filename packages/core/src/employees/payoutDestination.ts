import { StrKey } from "@stellar/stellar-sdk";
export type PayoutDestinationErrorCode =
  | "DESTINATION_REQUIRED"
  | "DESTINATION_WHITESPACE"
  | "DESTINATION_UNSUPPORTED";
export type PayoutDestinationValidation =
  | { ok: true; destination: string; kind: "account" | "muxed_account" }
  | { ok: false; code: PayoutDestinationErrorCode; message: string };

/** Validates an account destination without reflecting submitted data in errors. */
export function validatePayoutDestination(value: unknown): PayoutDestinationValidation {
  if (typeof value !== "string" || value === "")
    return { ok: false, code: "DESTINATION_REQUIRED", message: "Payout destination is required." };
  const destination = value.trim();
  if (destination !== value || destination === "")
    return {
      ok: false,
      code: "DESTINATION_WHITESPACE",
      message: "Payout destination must not contain surrounding whitespace.",
    };
  if (StrKey.isValidEd25519PublicKey(destination))
    return { ok: true, destination, kind: "account" };
  const isMuxed = (StrKey as unknown as { isValidMed25519PublicKey?: (input: string) => boolean })
    .isValidMed25519PublicKey;
  if (isMuxed?.(destination)) return { ok: true, destination, kind: "muxed_account" };
  return {
    ok: false,
    code: "DESTINATION_UNSUPPORTED",
    message: "Payout destination must be a valid Stellar account or muxed account.",
  };
}

/**
 * Destination validation extension point (#531).
 *
 * A host application can register a custom validator to add organizational
 * rules (allowlists, compliance holds, internal account classification) on top
 * of the built-in Stellar destination checks. The hook never receives or
 * returns sensitive payroll values: only the destination identifier flows
 * through the hook, and rejection messages must not echo the rejected value.
 */
export type DestinationValidationHook = (
  value: string
) => DestinationValidationHookResult | Promise<DestinationValidationHookResult>;

/** Result a custom {@link DestinationValidationHook} must return. */
export type DestinationValidationHookResult =
  | {
      ok: true;
      /** Optional classification recorded in validation events (never sensitive). */
      kind?: string;
    }
  | {
      ok: false;
      /** Stable machine-readable rejection code (namespaced, e.g. `COMPANY_...`). */
      code: string;
      /** Sanitized, actionable message — must not echo the rejected destination. */
      message: string;
      /** True when the rejection may clear on retry (e.g. transient policy service outage). */
      retryable?: boolean;
    };

/**
 * Default extension hook: pass-through that delegates entirely to the
 * built-in {@link validatePayoutDestination} checks. Used when the host
 * application has not registered a custom validator.
 */
export const defaultDestinationValidationHook: DestinationValidationHook = (value) => {
  const result = validatePayoutDestination(value);
  return result.ok ? { ok: true, kind: result.kind } : result;
};
