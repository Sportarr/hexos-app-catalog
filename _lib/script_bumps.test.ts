import { describe, expect, test } from "bun:test";
import { bumpProblem, versionRaised } from "./script_bumps";

const kodi = (tag: string, version: string, extra: Record<string, unknown> = {}) => ({
  version: 6,
  custom: true,
  metadata: { name: "Kodi", version: "21.2" },
  script: { version, changeLog: "Kodi on the TV." },
  app_values: { image: { repository: "eshtek/kodi", tag } },
  ...extra,
});

describe("bumpProblem", () => {
  test("a new image under the same script.version is refused", () => {
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), kodi("21.2-2", "1.0.0"))).toContain("raise it (to 1.0.1 or later)");
  });

  test("a new image with a raised script.version ships", () => {
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), kodi("21.2-2", "1.0.1"))).toBeNull();
    expect(bumpProblem(kodi("21.2-1", "1.0.9"), kodi("21.2-2", "1.1.0"))).toBeNull();
  });

  test("a lower script.version is refused too", () => {
    expect(bumpProblem(kodi("21.2-1", "1.0.2"), kodi("21.2-2", "1.0.1"))).not.toBeNull();
  });

  test("the catalog card, the change log and internal change nothing a server runs", () => {
    const after = kodi("21.2-1", "1.0.0", { internal: true });
    after.metadata.version = "21.3";
    after.script.changeLog = "Better words.";
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), after)).toBeNull();
  });

  test("a change in layout alone is no change", () => {
    const { app_values: _values, ...rest } = kodi("21.2-1", "1.0.0");
    const reordered = { app_values: { image: { tag: "21.2-1", repository: "eshtek/kodi" } }, ...rest };
    expect(Object.keys(reordered)[0]).toBe("app_values");
    expect(bumpProblem(kodi("21.2-1", "1.0.0"), reordered)).toBeNull();
  });

  test("a TrueNAS catalog app is left alone: the deck offers its script updates to no one", () => {
    const plex = (port: number) => ({ script: { version: "1.0.0" }, app_values: { network: { web_port: port } } });
    expect(bumpProblem(plex(32400), plex(32401))).toBeNull();
  });
});

describe("versionRaised", () => {
  test("compares each number", () => {
    expect(versionRaised("1.0.10", "1.0.9")).toBe(true);
    expect(versionRaised("2.0.0", "1.9.9")).toBe(true);
    expect(versionRaised("1.0.0", "1.0.0")).toBe(false);
  });
});
