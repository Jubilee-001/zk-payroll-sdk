import {
  ABSOLUTE_MAX_PAGES,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RECORDS,
  PaginationGuardrailErrorCode,
  collectGuardedPages,
  iterateGuardedPages,
  resolvePaginationGuardrails,
} from "../src/pagination-guardrails";
import { MAX_PAGE_SIZE } from "../src/pagination";

/** Builds a well-behaved paginated source over a fixed list of period IDs. */
function makeFiniteSource(ids: string[], pageSize: number) {
  return async ({ cursor, limit }: { cursor?: string; limit: number }) => {
    const size = Math.min(limit, pageSize);
    const start = cursor ? Number(cursor) : 0;
    const items = ids.slice(start, start + size);
    const next = start + size;
    return {
      items,
      ...(next < ids.length ? { nextCursor: String(next) } : {}),
    };
  };
}

describe("pagination guardrails (#500)", () => {
  describe("resolvePaginationGuardrails", () => {
    it("applies safe defaults", () => {
      const resolved = resolvePaginationGuardrails();
      expect(resolved.maxPageSize).toBe(MAX_PAGE_SIZE);
      expect(resolved.maxPages).toBe(DEFAULT_MAX_PAGES);
      expect(resolved.maxRecords).toBe(DEFAULT_MAX_RECORDS);
      expect(resolved.signal).toBeUndefined();
    });

    it("clamps maxPageSize into the 1..100 window", () => {
      expect(resolvePaginationGuardrails({ maxPageSize: 500 }).maxPageSize).toBe(MAX_PAGE_SIZE);
      expect(resolvePaginationGuardrails({ maxPageSize: 0 }).maxPageSize).toBe(1);
      expect(resolvePaginationGuardrails({ maxPageSize: 25.9 }).maxPageSize).toBe(25);
    });

    it("rejects non-positive or non-integer budgets", () => {
      expect(() => resolvePaginationGuardrails({ maxPages: 0 })).toThrow(RangeError);
      expect(() => resolvePaginationGuardrails({ maxPages: -1 })).toThrow(RangeError);
      expect(() => resolvePaginationGuardrails({ maxPages: 2.5 })).toThrow(RangeError);
      expect(() => resolvePaginationGuardrails({ maxRecords: 0 })).toThrow(RangeError);
    });

    it("enforces the absolute page ceiling", () => {
      expect(() => resolvePaginationGuardrails({ maxPages: ABSOLUTE_MAX_PAGES + 1 })).toThrow(
        RangeError
      );
      expect(resolvePaginationGuardrails({ maxPages: ABSOLUTE_MAX_PAGES }).maxPages).toBe(
        ABSOLUTE_MAX_PAGES
      );
    });

    it("preserves the abort signal", () => {
      const controller = new AbortController();
      expect(resolvePaginationGuardrails({ signal: controller.signal }).signal).toBe(
        controller.signal
      );
    });
  });

  describe("main path — well-behaved sources", () => {
    it("collects all records in order across pages", async () => {
      const source = makeFiniteSource(["p-1", "p-2", "p-3", "p-4", "p-5"], 2);
      const records = await collectGuardedPages(source, { maxPageSize: 2 });
      expect(records).toEqual(["p-1", "p-2", "p-3", "p-4", "p-5"]);
    });

    it("completes when the source stops after an empty page", async () => {
      const fetchPage = async ({ cursor }: { cursor?: string }) =>
        cursor ? { items: [] } : { items: ["only"], nextCursor: "tail" };
      const records = await collectGuardedPages(fetchPage);
      expect(records).toEqual(["only"]);
    });

    it("clamps the limit forwarded to the fetcher", async () => {
      const limits: number[] = [];
      const source = async ({ cursor, limit }: { cursor?: string; limit: number }) => {
        limits.push(limit);
        return cursor ? { items: [] } : { items: ["a"], nextCursor: "next" };
      };
      await collectGuardedPages(source, { maxPageSize: 10 });
      expect(limits).toEqual([10, 10]);
    });
  });

  describe("stall detection — repeated cursors", () => {
    it("stops a source that repeats the same cursor", async () => {
      const fetchPage = async (): Promise<{ items: string[]; nextCursor: string }> => ({
        items: [],
        nextCursor: "same",
      });
      await expect(collectGuardedPages(fetchPage)).rejects.toThrow(
        `${PaginationGuardrailErrorCode.REPEATED_CURSOR}: pagination returned a repeated cursor.`
      );
    });

    it("stops a source that cycles back to an earlier cursor", async () => {
      const cursors = ["c2", "c3", "c2"]; // c2 repeats on the 3rd page
      let call = 0;
      const fetchPage = async () => {
        const next = cursors[call];
        call += 1;
        return { items: [`item-${call}`], nextCursor: next };
      };
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const record of iterateGuardedPages(fetchPage)) {
            seen.push(record);
          }
        })()
      ).rejects.toThrow(PaginationGuardrailErrorCode.REPEATED_CURSOR);
      // All three pages were fetched and yielded before the cycle was detected.
      expect(seen).toEqual(["item-1", "item-2", "item-3"]);
      expect(call).toBe(3);
    });

    it("never echoes cursor payloads in stall errors", async () => {
      const secretCursor = "cursor-contains-secret-payroll-data";
      const fetchPage = async () => ({
        items: ["salary-row"],
        nextCursor: secretCursor,
      });
      const failure = (await collectGuardedPages(fetchPage).catch((err: Error) => err)) as Error;
      expect(String(failure.message)).not.toContain(secretCursor);
      expect(String(failure.message)).not.toContain("salary-row");
    });
  });

  describe("budget enforcement", () => {
    it("stops an endlessly-advancing source at maxPages", async () => {
      let pages = 0;
      const fetchPage = async ({ cursor }: { cursor?: string }) => {
        pages += 1;
        const next = cursor ? Number(cursor) + 1 : 1;
        return { items: ["record"], nextCursor: String(next) };
      };
      const failure = (await collectGuardedPages(fetchPage, { maxPages: 5 }).catch(
        (err: Error) => err
      )) as Error;
      expect(String(failure.message)).toContain(PaginationGuardrailErrorCode.BUDGET_EXCEEDED);
      expect(pages).toBe(5);
    });

    it("stops traversal once maxRecords is reached", async () => {
      const fetchPage = async ({ cursor }: { cursor?: string }) => {
        const next = cursor ? Number(cursor) + 1 : 1;
        return { items: ["r1", "r2", "r3"], nextCursor: String(next) };
      };
      const failure = (await collectGuardedPages(fetchPage, { maxRecords: 4 }).catch(
        (err: Error) => err
      )) as Error;
      expect(String(failure.message)).toContain(PaginationGuardrailErrorCode.BUDGET_EXCEEDED);

      // Record budget is enforced during iteration too: consumer sees 4 records.
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const record of iterateGuardedPages(fetchPage, { maxRecords: 4 })) {
            seen.push(record);
          }
        })()
      ).rejects.toThrow(PaginationGuardrailErrorCode.BUDGET_EXCEEDED);
      expect(seen).toHaveLength(4);
    });

    it("does not exceed maxRecords mid-page", async () => {
      const fetchPage = async () => ({ items: ["a", "b", "c"], nextCursor: "more" });
      const records: string[] = [];
      await expect(
        (async () => {
          for await (const record of iterateGuardedPages(fetchPage, { maxRecords: 2 })) {
            records.push(record);
          }
        })()
      ).rejects.toThrow(PaginationGuardrailErrorCode.BUDGET_EXCEEDED);
      expect(records).toEqual(["a", "b"]);
    });
  });

  describe("cancellation", () => {
    it("does not call the fetcher when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchPage = jest.fn();
      await expect(
        collectGuardedPages(fetchPage, { signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchPage).not.toHaveBeenCalled();
    });

    it("does not yield a fetched page after mid-flight cancellation", async () => {
      const controller = new AbortController();
      const fetchPage = async () => {
        controller.abort();
        return { items: ["private-row"], nextCursor: undefined };
      };
      await expect(
        collectGuardedPages(fetchPage, { signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });

  describe("malformed sources", () => {
    it("rejects pages without an items array", async () => {
      const fetchPage = async () => ({ items: null }) as unknown as { items: string[] };
      await expect(collectGuardedPages(fetchPage)).rejects.toThrow(
        "Paginated source returned an invalid page."
      );
    });

    it("rejects empty-string next cursors", async () => {
      const fetchPage = async () => ({ items: ["x"], nextCursor: "" });
      await expect(collectGuardedPages(fetchPage)).rejects.toThrow(
        "Paginated source returned an invalid next cursor."
      );
    });

    it("rejects a non-function fetcher", async () => {
      await expect(
        collectGuardedPages("nope" as unknown as Parameters<typeof collectGuardedPages>[0])
      ).rejects.toThrow(TypeError);
    });
  });

  describe("privacy guarantees", () => {
    it("never echoes record contents in any guardrail error", async () => {
      const secretRecord = { salary: "990000", recipient: "GSECRET123" };
      const fetchPage = async () => ({
        items: [secretRecord, secretRecord, secretRecord],
        nextCursor: "advance",
      });
      const failure = (await collectGuardedPages(fetchPage, { maxRecords: 2 }).catch(
        (err: Error) => err
      )) as Error;
      expect(String(failure.message)).not.toContain("990000");
      expect(String(failure.message)).not.toContain("GSECRET123");
    });
  });
});
