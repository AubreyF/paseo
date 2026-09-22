import { expect, it, vi } from "vitest";
import { ProviderQuotaObservationService } from "./governor-service.js";
import { QuotaObserverDisposedError } from "../../server/agent/agent-sdk-types.js";
import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";

const unavailable: QuotaObservation = { status: "unavailable", reason: "windows_unavailable" };

it("retries initialization failures only when the provider confirms disposal", async () => {
  let attempts = 0;
  const client = {
    openQuotaObservationSession: async () => {
      if (++attempts === 1) throw new QuotaObserverDisposedError();
      return { read: async () => unavailable, dispose: async () => {} };
    },
  };
  const service = new ProviderQuotaObservationService({ getClient: () => client });
  expect(await service.read("retry")).toEqual({ status: "unavailable", reason: "read_failed" });
  expect(await service.read("retry")).toEqual(unavailable);
  expect(attempts).toBe(2);
});

it("coalesces one provider read and disposes its metadata connection", async () => {
  let finish!: (value: QuotaObservation) => void;
  let opens = 0;
  let closes = 0;
  const client = {
    openQuotaObservationSession: async () => {
      opens++;
      return {
        read: () =>
          new Promise<QuotaObservation>((resolve) => {
            finish = resolve;
          }),
        dispose: async () => {
          closes++;
        },
      };
    },
  };
  const service = new ProviderQuotaObservationService({ getClient: () => client });
  const first = service.read("account-one");
  const second = service.read("account-one");
  await vi.waitFor(() => expect(opens).toBe(1));
  finish(unavailable);
  expect(await first).toEqual(unavailable);
  expect(await second).toEqual(unavailable);
  expect(closes).toBe(1);
});

it("bounds a stuck provider without delaying a different account", async () => {
  vi.useFakeTimers();
  try {
    let closes = 0;
    const clients = {
      stuck: {
        openQuotaObservationSession: async () => ({
          read: () => new Promise<QuotaObservation>(() => {}),
          dispose: async () => {
            closes++;
          },
        }),
      },
      healthy: {
        openQuotaObservationSession: async () => ({
          read: () => Promise.resolve(unavailable),
          dispose: async () => {
            closes++;
          },
        }),
      },
    };
    const service = new ProviderQuotaObservationService({
      timeoutMs: 100,
      getClient: (id) => clients[id as keyof typeof clients],
    });
    const stuck = service.read("stuck");
    expect(await service.read("healthy")).toEqual(unavailable);
    await vi.advanceTimersByTimeAsync(100);
    expect(await stuck).toEqual({ status: "unavailable", reason: "read_failed" });
    expect(closes).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("disposes a connection that opens after its request has timed out", async () => {
  vi.useFakeTimers();
  try {
    let opened!: (session: {
      read: () => Promise<QuotaObservation>;
      dispose: () => Promise<void>;
    }) => void;
    let closes = 0;
    const service = new ProviderQuotaObservationService({
      timeoutMs: 100,
      getClient: () => ({
        openQuotaObservationSession: () =>
          new Promise((resolve) => {
            opened = resolve;
          }),
      }),
    });
    const result = service.read("slow-open");
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ status: "unavailable", reason: "read_failed" });
    opened({
      read: async () => {
        throw new Error("Expired read must not run");
      },
      dispose: async () => {
        closes++;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closes).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("cannot revive an observation after provider configuration changes during a read", async () => {
  let finish!: (value: QuotaObservation) => void;
  const client = {
    openQuotaObservationSession: async () => ({
      read: () =>
        new Promise<QuotaObservation>((resolve) => {
          finish = resolve;
        }),
      dispose: async () => {},
    }),
  };
  let configured: typeof client | null = client;
  const service = new ProviderQuotaObservationService({ getClient: () => configured });
  const result = service.read("changed");
  await vi.waitFor(() => expect(typeof finish).toBe("function"));
  configured = null;
  finish(unavailable);
  expect(await result).toEqual({ status: "unavailable", reason: "account_changed" });
});

it("fences repeated reads while a timed out open remains unresolved, including shutdown", async () => {
  vi.useFakeTimers();
  try {
    let opened!: (session: {
      read: () => Promise<QuotaObservation>;
      dispose: () => Promise<void>;
    }) => void;
    const open = vi.fn(
      () =>
        new Promise<{ read: () => Promise<QuotaObservation>; dispose: () => Promise<void> }>(
          (resolve) => {
            opened = resolve;
          },
        ),
    );
    const service = new ProviderQuotaObservationService({
      timeoutMs: 100,
      getClient: () => ({ openQuotaObservationSession: open }),
    });
    const result = service.read("slow");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    for (let index = 0; index < 5; index++) await service.read("slow");
    expect(open).toHaveBeenCalledTimes(1);
    await service.stop();
    const dispose = vi.fn(async () => {});
    opened({ read: async () => unavailable, dispose });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    await service.read("slow");
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("converts a throwing provider lookup into unavailable telemetry", async () => {
  const service = new ProviderQuotaObservationService({
    getClient: () => {
      throw new Error("Registry unavailable");
    },
  });
  expect(await service.read("missing")).toEqual({ status: "unavailable", reason: "read_failed" });
  await service.stop();
});
