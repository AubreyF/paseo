import { describe, expect, it } from "vitest";
import { hostedConnectionDefaults } from "./hosted-connection-defaults";

describe("hosted connection defaults", () => {
  it("uses the HTTPS alias without importing URL credentials or pairing parameters", () => {
    expect(
      hostedConnectionDefaults(
        "https://user:secret@paseo.example.com/welcome?password=secret#offer=secret",
      ),
    ).toEqual({
      host: "paseo.example.com",
      port: "443",
      useTls: true,
    });
  });

  it.each([
    ["https://paseo.example.com:8443/welcome", "paseo.example.com", "8443", true],
    ["http://localhost:6767/welcome", "localhost", "6767", false],
    ["http://paseo.example.com/welcome", "paseo.example.com", "80", false],
    ["https://[::1]:8443/welcome", "::1", "8443", true],
  ])("preserves the authority of %s", (url, host, port, useTls) => {
    expect(hostedConnectionDefaults(url)).toEqual({ host, port, useTls });
  });

  it("does not suggest a host for a desktop app URL", () => {
    expect(hostedConnectionDefaults("paseo://app/welcome")).toBeUndefined();
  });
});
