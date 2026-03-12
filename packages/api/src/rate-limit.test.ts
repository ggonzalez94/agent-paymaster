import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "./rate-limit.js";

class FakePersistenceStore {
  readonly buckets = new Map<string, { count: number; windowStart: number }>();

  setRateLimitBucket(key: string, count: number, windowStart: number): void {
    this.buckets.set(key, { count, windowStart });
  }

  deleteRateLimitBucket(key: string): void {
    this.buckets.delete(key);
  }

  getAllRateLimitBuckets(): Array<{ key: string; count: number; windowStart: number }> {
    return [...this.buckets.entries()].map(([key, value]) => ({
      key,
      count: value.count,
      windowStart: value.windowStart,
    }));
  }

  deleteExpiredRateLimitBuckets(windowMs: number): void {
    const cutoff = Date.now() - windowMs;

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.windowStart < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}

describe("fixed window rate limiter", () => {
  it("caps bucket growth at maxBuckets", () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequestsPerWindow: 1,
      windowMs: 60_000,
      maxBuckets: 3,
    });

    limiter.consume("a", 0);
    limiter.consume("b", 0);
    limiter.consume("c", 0);
    expect(limiter.getBucketCount()).toBe(3);

    limiter.consume("d", 0);
    expect(limiter.getBucketCount()).toBe(3);
  });

  it("reclaims expired buckets when a new window starts", () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequestsPerWindow: 1,
      windowMs: 100,
      maxBuckets: 2,
    });

    limiter.consume("a", 0);
    limiter.consume("b", 0);
    expect(limiter.getBucketCount()).toBe(2);

    limiter.consume("c", 101);
    expect(limiter.getBucketCount()).toBe(1);
  });

  it("persists bucket updates immediately and reloads them on startup", () => {
    const persistence = new FakePersistenceStore();
    const now = Date.now();
    const config = {
      maxRequestsPerWindow: 2,
      windowMs: 60_000,
      maxBuckets: 100,
    };

    const firstLimiter = new FixedWindowRateLimiter(config, persistence as never);
    firstLimiter.consume("sender:0xabc", now);
    firstLimiter.consume("sender:0xabc", now + 1);

    expect(persistence.buckets.get("sender:0xabc")).toEqual({
      count: 2,
      windowStart: now,
    });

    const secondLimiter = new FixedWindowRateLimiter(config, persistence as never);
    const result = secondLimiter.consume("sender:0xabc", now + 2);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
