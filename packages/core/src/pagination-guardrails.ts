/**
 * Configurable Pagination Guardrails (Issue #500)
 *
 * Protects consumers from accidental unbounded pagination requests and loops
 * when traversing paginated payroll data sources (RPC endpoints, indexers,
 * export pipelines).
 *
 * ## Why This Matters
 * A paginated fetch loop that trusts its source
 * (`do { page = await fetch(cursor) } while (cursor)`) can run forever — or
 * pull unlimited records into memory — when a data source misbehaves
 * (repeating cursors, ever-advancing cursors, oversized pages). Guardrails
 * bound every dimension of the traversal with configurable, validated limits,
 * and failure states never echo sensitive payroll values (amounts, salaries,
 * recipient addresses, or raw cursor payloads).
 *
 * Guardrails already ship with `iteratePayrollPeriods()` /
 * `collectPayrollPeriods()` for payroll periods. This module provides the
 * equivalent protection for arbitrary paginated sources and exposes the
 * option resolution so consumers building their own loops can share the same
 * defaults and validation.
 */

import { MAX_PAGE_SIZE, MIN_PAGE_SIZE } from "./pagination";

// ---------------------------------------------------------------------------
// Guardrail options and resolved values
// ---------------------------------------------------------------------------

/** Default maximum number of pages per traversal. */
export const DEFAULT_MAX_PAGES = 100;

/** Hard ceiling for `maxPages` (any positive integer is accepted up to this). */
export const ABSOLUTE_MAX_PAGES = 10_000;

/** Default maximum number of records accumulated per traversal. */
export const DEFAULT_MAX_RECORDS = 10_000;

/**
 * Configurable guardrails for a paginated traversal.
 *
 * Every field is optional; each falls back to a safe default. All values are
 * validated by {@link resolvePaginationGuardrails} — invalid configurations
 * fail fast with a `RangeError` before any page is fetched.
 */
export interface PaginationGuardrailOptions {
  /**
   * Maximum page size accepted per request. Larger requests are clamped down
   * to this value (default: 100, matching `MAX_PAGE_SIZE`).
   */
  maxPageSize?: number;
  /**
   * Maximum number of pages a single traversal may fetch
   * (default: 100, hard ceiling 10,000).
   */
  maxPages?: number;
  /**
   * Maximum number of records a single traversal may yield before stopping
   * (default: 10,000). Protects memory when pages are small but numerous.
   */
  maxRecords?: number;
  /**
   * Abort signal — checked before each fetch and again before yielding.
   * Aborting throws an `AbortError` (never exposes fetched data).
   */
  signal?: AbortSignal;
}

/**
 * Validated, fully-resolved guardrail values.
 */
export interface ResolvedPaginationGuardrails {
  /** Clamped maximum page size (1..100). */
  maxPageSize: number;
  /** Validated page budget (>= 1). */
  maxPages: number;
  /** Validated record budget (>= 1). */
  maxRecords: number;
  /** Abort signal, when provided. */
  signal?: AbortSignal;
}

/** Stable machine-readable codes emitted by {@link iterateGuardedPages}. */
export const PaginationGuardrailErrorCode = {
  /** The data source returned a cursor it already returned (stall/loop). */
  REPEATED_CURSOR: "PAGINATION_REPEATED_CURSOR",
  /** The traversal hit its configured page or record budget. */
  BUDGET_EXCEEDED: "PAGINATION_BUDGET_EXCEEDED",
} as const;

export type PaginationGuardrailErrorCode =
  (typeof PaginationGuardrailErrorCode)[keyof typeof PaginationGuardrailErrorCode];

/**
 * Validates and resolves guardrail options, applying safe defaults.
 *
 * @param options - Optional guardrail configuration.
 * @returns Fully-resolved guardrail values.
 * @throws {RangeError} when any limit is not a positive integer or exceeds its ceiling.
 */
export function resolvePaginationGuardrails(
  options: PaginationGuardrailOptions = {}
): ResolvedPaginationGuardrails {
  const { maxPageSize, maxPages = DEFAULT_MAX_PAGES, maxRecords = DEFAULT_MAX_RECORDS } = options;

  const resolvedPageSize =
    maxPageSize === undefined
      ? MAX_PAGE_SIZE
      : Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, Math.floor(maxPageSize)));

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("Pagination maxPages must be a positive integer.");
  }
  if (maxPages > ABSOLUTE_MAX_PAGES) {
    throw new RangeError(`Pagination maxPages cannot exceed ${ABSOLUTE_MAX_PAGES}.`);
  }
  if (!Number.isInteger(maxRecords) || maxRecords < 1) {
    throw new RangeError("Pagination maxRecords must be a positive integer.");
  }

  return {
    maxPageSize: resolvedPageSize,
    maxPages,
    maxRecords,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fetcher contract
// ---------------------------------------------------------------------------

/** A single page returned by a guarded fetcher. */
export interface GuardedPage<T> {
  /** Records in this page, in source order. */
  items: readonly T[];
  /** Opaque cursor for the next page; omitted/undefined on the last page. */
  nextCursor?: string;
}

/** Fetches one page for a guarded traversal. */
export type GuardedPageFetcher<T> = (request: {
  /** Cursor from the previous page (undefined on the first call). */
  cursor?: string;
  /** Page size to request (clamped to `maxPageSize`). */
  limit: number;
  /** Abort signal from the guardrail options. */
  signal?: AbortSignal;
}) => Promise<GuardedPage<T>>;

function abortError(): Error {
  // DOMException is not available in every supported server runtime.
  if (typeof DOMException !== "undefined") {
    return new DOMException("Pagination aborted", "AbortError");
  }
  const error = new Error("Pagination aborted");
  error.name = "AbortError";
  return error;
}

function assertGuardedPage<T>(value: unknown): asserts value is GuardedPage<T> {
  if (!value || typeof value !== "object" || !Array.isArray((value as GuardedPage<T>).items)) {
    throw new TypeError("Paginated source returned an invalid page.");
  }
  const cursor = (value as GuardedPage<T>).nextCursor;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
    throw new TypeError("Paginated source returned an invalid next cursor.");
  }
}

// ---------------------------------------------------------------------------
// Guarded traversal
// ---------------------------------------------------------------------------

/**
 * Iterates pages from a paginated source under configurable guardrails
 * (Issue #500).
 *
 * Protections:
 * - **Page-size cap** — every request is clamped to `maxPageSize`.
 * - **Page budget** — traversal stops after `maxPages` fetches.
 * - **Record budget** — traversal stops once `maxRecords` records were yielded.
 * - **Stall detection** — a source returning a cursor it already returned
 *   aborts the loop immediately (no repeated pages, no silent infinite loop).
 * - **Cancellation** — checked before each fetch and before yielding;
 *   aborted traversals throw `AbortError` and never surface fetched data.
 *
 * Failure errors are actionable and privacy-safe: messages never echo raw
 * cursor payloads, amounts, or record contents.
 *
 * @param fetchPage - Fetcher returning one page at a time.
 * @param options   - Guardrail configuration.
 * @yields Each record, in source order, respecting the record budget.
 * @throws {RangeError}  when guardrail options are invalid.
 * @throws {TypeError}   when the source returns a malformed page.
 * @throws {Error}       (`PaginationGuardrailErrorCode`) on repeated cursors or budget exhaustion.
 * @throws {AbortError}  when the signal is aborted.
 *
 * @example
 * ```ts
 * for await (const record of iterateGuardedPages(fetchPage, { maxPages: 50 })) {
 *   await ingest(record);
 * }
 * ```
 */
export async function* iterateGuardedPages<T>(
  fetchPage: GuardedPageFetcher<T>,
  options: PaginationGuardrailOptions = {}
): AsyncGenerator<T, void, undefined> {
  if (typeof fetchPage !== "function") {
    throw new TypeError("iterateGuardedPages requires a fetchPage callback function.");
  }

  const { maxPageSize, maxPages, maxRecords, signal } = resolvePaginationGuardrails(options);

  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let yieldedRecords = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    if (signal?.aborted) throw abortError();

    const page = await fetchPage({ cursor, limit: maxPageSize, signal });
    if (signal?.aborted) throw abortError();
    assertGuardedPage<T>(page);

    for (const item of page.items) {
      if (yieldedRecords >= maxRecords) {
        throw new Error(
          `${PaginationGuardrailErrorCode.BUDGET_EXCEEDED}: pagination exceeded the configured record limit.`
        );
      }
      yieldedRecords += 1;
      yield item;
    }

    if (page.nextCursor === undefined) return;

    if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
      throw new Error(
        `${PaginationGuardrailErrorCode.REPEATED_CURSOR}: pagination returned a repeated cursor.`
      );
    }
    if (cursor !== undefined) seenCursors.add(cursor);
    cursor = page.nextCursor;
  }

  throw new Error(
    `${PaginationGuardrailErrorCode.BUDGET_EXCEEDED}: pagination exceeded the configured page limit.`
  );
}

/**
 * Collects all records from a paginated source under guardrails.
 * Records arrive in source order; budgets apply to the accumulated total.
 *
 * @param fetchPage - Fetcher returning one page at a time.
 * @param options   - Guardrail configuration.
 * @returns All yielded records, in order.
 * @throws Same as {@link iterateGuardedPages}.
 *
 * @example
 * ```ts
 * const records = await collectGuardedPages(fetchPage, { maxRecords: 5000 });
 * ```
 */
export async function collectGuardedPages<T>(
  fetchPage: GuardedPageFetcher<T>,
  options: PaginationGuardrailOptions = {}
): Promise<T[]> {
  const records: T[] = [];
  for await (const item of iterateGuardedPages(fetchPage, options)) records.push(item);
  return records;
}
