import { Keypair } from "@stellar/stellar-sdk";
import {
  PayrollService,
  defaultDestinationValidationHook,
  setDestinationValidationHook,
  resetDestinationValidationHook,
  getRegisteredDestinationValidationHook,
  validatePaymentDestination,
} from "../src";
import { validatePayoutDestination } from "../src/employees/payoutDestination";

const account = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const otherAccount = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();

afterEach(() => {
  resetDestinationValidationHook();
});

describe("Destination Validation Extension Point (#531)", () => {
  describe("default behavior", () => {
    it("passes valid destinations through the default hook", () => {
      expect(defaultDestinationValidationHook(account)).toEqual({
        ok: true,
        kind: "account",
      });
    });

    it("keeps the built-in validator untouched", () => {
      expect(validatePayoutDestination(account)).toEqual({
        ok: true,
        destination: account,
        kind: "account",
      });
    });

    it("returns no registered hook after reset", () => {
      setDestinationValidationHook(() => ({ ok: true }));
      expect(getRegisteredDestinationValidationHook()).toBeDefined();
      resetDestinationValidationHook();
      expect(getRegisteredDestinationValidationHook()).toBeUndefined();
    });

    it("validates destinations with the built-in gate when no hook is registered", async () => {
      const result = await validatePaymentDestination(account);
      expect(result).toEqual({
        ok: true,
        destination: account,
        kind: "account",
        state: "validated",
      });
    });
  });

  describe("extension hook policy", () => {
    it("accepts destinations allowed by the organizational allowlist", async () => {
      setDestinationValidationHook((value) =>
        value === account
          ? { ok: true, kind: "internal_treasury" }
          : {
              ok: false,
              code: "COMPANY_DESTINATION_NOT_ALLOWED",
              message: "Destination is not on the approved payout list.",
            }
      );

      const result = await validatePaymentDestination(account);
      expect(result).toEqual({
        ok: true,
        destination: account,
        kind: "internal_treasury",
        state: "validated",
      });
    });

    it("rejects destinations blocked by organizational policy before proof generation", async () => {
      setDestinationValidationHook(() => ({
        ok: false,
        code: "COMPANY_DESTINATION_ON_HOLD",
        message: "Destination is under a compliance hold; resolve the hold before paying out.",
      }));

      const result = await validatePaymentDestination(otherAccount);
      expect(result).toEqual({
        ok: false,
        code: "COMPANY_DESTINATION_ON_HOLD",
        message: "Destination is under a compliance hold; resolve the hold before paying out.",
        state: "rejected",
      });
    });

    it("accepts legacy G-prefixed references with the same exemption as built-in validation", async () => {
      const legacy = "GCOMPANY.TREASURY.2026";

      const withoutHook = await validatePaymentDestination(legacy);
      expect(withoutHook).toEqual({
        ok: true,
        destination: legacy,
        kind: "legacy_reference",
        state: "validated",
      });

      // The hook still applies policy on top of accepted legacy references.
      setDestinationValidationHook((value) =>
        value === legacy
          ? { ok: true }
          : { ok: false, code: "COMPANY_NOT_ALLOWED", message: "Destination is not approved." }
      );
      const withHook = await validatePaymentDestination(legacy);
      expect(withHook.ok).toBe(true);

      const blocked = await validatePaymentDestination("GOTHER.REFERENCE");
      expect(blocked.ok).toBe(false);
    });

    it("still rejects structurally invalid destinations when a hook is registered", async () => {
      setDestinationValidationHook(() => ({ ok: true }));

      const required = await validatePaymentDestination("");
      expect(required.ok).toBe(false);
      if (!required.ok) {
        expect(required.code).toBe("DESTINATION_REQUIRED");
      }

      const whitespace = await validatePaymentDestination("  ");
      expect(whitespace.ok).toBe(false);
      if (!whitespace.ok) {
        expect(whitespace.code).toBe("DESTINATION_WHITESPACE");
      }
    });

    it("supports async hooks for policy services", async () => {
      setDestinationValidationHook(async () => ({
        ok: false,
        code: "COMPANY_POLICY_UNREACHABLE",
        message: "Destination policy service is unreachable; retry once the service recovers.",
        retryable: true,
      }));

      const result = await validatePaymentDestination(account);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
      }
    });

    it("fails closed when the extension hook throws", async () => {
      setDestinationValidationHook(() => {
        throw new Error("policy service exploded");
      });

      const result = await validatePaymentDestination(account);
      expect(result).toMatchObject({
        ok: false,
        code: "DESTINATION_VALIDATION_UNAVAILABLE",
        state: "unavailable",
      });
    });
  });

  describe("PayrollService integration", () => {
    it("exposes static hook registration and pre-flight validation", async () => {
      PayrollService.setDestinationValidationHook((value) =>
        value === account
          ? { ok: true }
          : { ok: false, code: "COMPANY_NOT_ALLOWED", message: "Destination is not approved." }
      );

      expect(PayrollService.getDestinationValidationHook()).toBeDefined();
      const allowed = await PayrollService.validateDestination(account);
      expect(allowed.ok).toBe(true);
      const blocked = await PayrollService.validateDestination(otherAccount);
      expect(blocked.ok).toBe(false);

      PayrollService.resetDestinationValidationHook();
      expect(PayrollService.getDestinationValidationHook()).toBeUndefined();
      const restored = await PayrollService.validateDestination(account);
      expect(restored.ok).toBe(true);
    });

    it("rejects payments to destinations blocked by the registered hook", async () => {
      const service = new PayrollService(
        {} as never,
        {} as never,
        { sign: jest.fn(), getPublicKey: () => "G..." } as never,
        "testnet"
      );

      setDestinationValidationHook(() => ({
        ok: false,
        code: "COMPANY_DESTINATION_ON_HOLD",
        message: "Destination is under a compliance hold; resolve the hold before paying out.",
      }));

      await expect(
        service.processPayment({ recipient: otherAccount, amount: 1n, asset: "native" })
      ).rejects.toThrow("compliance hold");
    });
  });

  describe("privacy guarantees", () => {
    it("never echoes rejected destinations into gate results", async () => {
      const secret = "GA7QYNF7SOWQXGLAVE7QWDNJTPAEJUZGMVC6CXG5DG5G2A7TVZQCJORE";
      setDestinationValidationHook(() => ({
        ok: false,
        code: "COMPANY_NOT_ALLOWED",
        message: "Destination is not approved.",
      }));

      const result = await validatePaymentDestination(secret);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(result.message).not.toContain("GA7Q");
      }
    });

    it("never echoes rejected destinations into service errors or progress events", async () => {
      const secret = "GA7QYNF7SOWQXGLAVE7QWDNJTPAEJUZGMVC6CXG5DG5G2A7TVZQCJORE";
      const service = new PayrollService(
        {} as never,
        {} as never,
        { sign: jest.fn(), getPublicKey: () => "G..." } as never,
        "testnet"
      );
      const progressEvents: unknown[] = [];

      setDestinationValidationHook(() => ({
        ok: false,
        code: "COMPANY_DESTINATION_ON_HOLD",
        message: "Destination is under a compliance hold; resolve the hold before paying out.",
      }));

      const rejection = await service
        .processPayment({
          recipient: secret,
          amount: 1n,
          asset: "native",
          onProgress: (event) => progressEvents.push(event),
        })
        .catch((error: unknown) => error as Error);

      const serialized = JSON.stringify({ rejection, progressEvents });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("GA7Q");
    });

    it("never surfaces hook fault details through the fail-closed result", async () => {
      const secret = "internal treasury account GA7QYNF7SOWQXGLA";
      setDestinationValidationHook(() => {
        throw new Error(`policy lookup failed for ${secret}`);
      });

      const result = await validatePaymentDestination(account);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("unavailable");
        expect(JSON.stringify(result)).not.toContain("policy lookup failed");
        expect(JSON.stringify(result)).not.toContain("GA7Q");
      }
    });
  });
});
