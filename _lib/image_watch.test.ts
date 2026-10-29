import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  applyChange,
  followVersion,
  newestTag,
  raisePatch,
  registryOf,
  splitPin,
  tagShape,
  updateFor,
  type WatchedApp,
  watchedApps,
} from "./image_watch";

// The tags GHCR listed for the Valheim image on 2026-10-29, the build tags among them
const VALHEIM_TAGS = ["sha-b824ca1", "1.0.0", "1.1.0", "sha-80a3d1f", "1.2.0", "1.3.0", "1.4.0", "sha-ee2bcf8", "1.4.1", "sha-0ab6cdc"];
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("tags", () => {
  test("a pin splits into its version and digest", () => {
    expect(splitPin("1.4.1")).toEqual({ version: "1.4.1" });
    expect(splitPin(`1.4.1@${DIGEST_A}`)).toEqual({ version: "1.4.1", digest: DIGEST_A });
  });

  test("a tag with no number in it names no version to follow", () => {
    expect(tagShape("latest")).toBeNull();
    expect(newestTag("latest", ["latest", "1.0.0"])).toBeNull();
  });

  test("the newest tag of the pin's shape wins, and build tags never match", () => {
    expect(newestTag("1.3.0", VALHEIM_TAGS)).toBe("1.4.1");
    expect(newestTag("1.4.1", VALHEIM_TAGS)).toBeNull();
  });

  test("numbers compare as numbers, not text", () => {
    expect(newestTag("1.9.0", ["1.10.0", "1.9.1"])).toBe("1.10.0");
  });

  test("Kodi's build number and version both move it, and a release candidate doesn't", () => {
    expect(newestTag("21.2-1", ["21.2-1", "21.2-2", "21.3-rc1", "21.2"])).toBe("21.2-2");
    expect(newestTag("21.2-1", ["21.2-2", "21.3-1"])).toBe("21.3-1");
  });

  test("the text around the numbers must match too", () => {
    expect(newestTag("v1.2.3", ["1.9.9", "v1.3.0"])).toBe("v1.3.0");
  });

  test("an older tag of the same shape is never an update", () => {
    expect(newestTag("1.4.1", ["1.4.0", "0.9.9"])).toBeNull();
  });
});

describe("followVersion", () => {
  test("a metadata.version that is the tag becomes the new tag", () => {
    expect(followVersion("1.4.1", "1.4.1", "1.5.0")).toBe("1.5.0");
  });

  test("one that is the tag's leading numbers takes the new tag's", () => {
    expect(followVersion("21.2", "21.2-1", "21.3-1")).toBe("21.3");
    expect(followVersion("21.2", "21.2-1", "21.2-2")).toBe("21.2");
    expect(followVersion("21", "21.2-1", "22.0-1")).toBe("22");
  });

  test("one that says something else is left for a person", () => {
    expect(followVersion("21.2", "21.25-1", "21.26-1")).toBeNull();
    expect(followVersion("2026.1", "1.4.1", "1.5.0")).toBeNull();
    expect(followVersion("1.4.1", "v1.4.1", "v1.5.0")).toBeNull();
  });
});

describe("raisePatch", () => {
  test("raises the last number", () => {
    expect(raisePatch("1.0.9")).toBe("1.0.10");
  });

  test("refuses a version the platform's semver can't read", () => {
    expect(() => raisePatch("1.0")).toThrow();
  });
});

describe("registryOf", () => {
  test("a bare name is on Docker Hub, an official image under library/", () => {
    expect(registryOf("eshtek/kodi")).toEqual({ host: "registry-1.docker.io", repository: "eshtek/kodi" });
    expect(registryOf("nginx")).toEqual({ host: "registry-1.docker.io", repository: "library/nginx" });
    expect(registryOf("docker.io/nginx")).toEqual({ host: "registry-1.docker.io", repository: "library/nginx" });
  });

  test("a host in the first part is the registry", () => {
    expect(registryOf("ghcr.io/community-valheim-tools/valheim-server")).toEqual({
      host: "ghcr.io",
      repository: "community-valheim-tools/valheim-server",
    });
    expect(registryOf("localhost:5000/kodi")).toEqual({ host: "localhost:5000", repository: "kodi" });
  });
});

describe("applyChange", () => {
  // Kodi's layout, by hand: the image on one line
  const kodi = `{
  "version": 6,
  "custom": true,
  "metadata": {
    "name": "Kodi",
    "version": "21.2"
  },
  "script": {
    "version": "1.0.0",
    "changeLog": "Kodi on the TV."
  },
  "app_values": {
    "image": { "repository": "eshtek/kodi", "tag": "21.2-1", "pull_policy": "missing" },
    "envs": [{ "name": "KODI_WEB_PORT", "value": "21.2-1" }]
  }
}
`;

  test("writes the tag, versions and change log in place, and nothing else", () => {
    const next = applyChange(kodi, { tag: "21.3-1", scriptVersion: "1.0.1", changeLog: "Runs eshtek/kodi 21.3-1.", metadataVersion: "21.3" });
    expect(next).toBe(
      kodi
        .replace('"tag": "21.2-1"', '"tag": "21.3-1"')
        .replace('"version": "1.0.0"', '"version": "1.0.1"')
        .replace('"Kodi on the TV."', '"Runs eshtek/kodi 21.3-1."')
        .replace('"version": "21.2"', '"version": "21.3"'),
    );
    // The same text elsewhere in the script stays as it was
    expect(next).toContain('"value": "21.2-1"');
  });

  test("adds a change log the script lacks at the file's own indent", () => {
    const fourSpaces = `{
    "script": {
        "version": "1.0.0"
    },
    "app_values": {
        "image": {
            "repository": "eshtek/kodi",
            "tag": "21.2-1"
        }
    }
}
`;
    const next = applyChange(fourSpaces, { tag: "21.2-2", scriptVersion: "1.0.1", changeLog: "Runs eshtek/kodi 21.2-2." });
    expect(next).toContain('        "version": "1.0.1",\n        "changeLog": "Runs eshtek/kodi 21.2-2."\n    },');
    expect(JSON.parse(next).app_values.image.tag).toBe("21.2-2");
  });
});

describe("the catalog", () => {
  const app: WatchedApp = {
    app: "valheim",
    file: "valheim.json",
    name: "Valheim",
    repository: "ghcr.io/community-valheim-tools/valheim-server",
    pin: `1.4.1@${DIGEST_A}`,
    scriptVersion: "1.0.0",
    metadataVersion: "1.4.1",
    sources: ["https://github.com/community-valheim-tools/valheim-server-docker"],
  };

  test("only custom apps whose pin names a version are watched", () => {
    const dir = mkdtempSync(`${tmpdir()}/image-watch-`);
    const image = (tag: string) => ({ image: { repository: "example/app", tag } });
    writeFileSync(`${dir}/valheim.json`, JSON.stringify({ custom: true, script: { version: "1.0.0" }, app_values: image("1.4.1") }));
    writeFileSync(`${dir}/hexos-test.json`, JSON.stringify({ custom: true, script: { version: "1.0.0" }, app_values: image("latest") }));
    writeFileSync(`${dir}/plex.json`, JSON.stringify({ script: { version: "1.0.0" }, app_values: { network: {} } }));
    expect(watchedApps(dir).map((a) => a.app)).toEqual(["valheim"]);
  });

  test("an update keeps the digest pinned, and its pull request names it", () => {
    const update = updateFor(app, "1.5.0", DIGEST_B);
    expect(update.to).toBe(`1.5.0@${DIGEST_B}`);
    expect(update.change).toEqual({
      tag: `1.5.0@${DIGEST_B}`,
      scriptVersion: "1.0.1",
      changeLog: "Runs ghcr.io/community-valheim-tools/valheim-server 1.5.0.",
      metadataVersion: "1.5.0",
    });
    expect(update.title).toBe("Valheim's image moves to 1.5.0");
    expect(update.body).toContain(DIGEST_B);
    expect(update.body).toContain("https://github.com/community-valheim-tools/valheim-server-docker/releases");
    expect(update.body).not.toContain("first number moved");
  });

  test("a pin with no digest gets none", () => {
    expect(updateFor({ ...app, pin: "1.4.1" }, "1.5.0").to).toBe("1.5.0");
  });

  test("a major step and a metadata.version it can't follow are named for the reviewer", () => {
    const update = updateFor({ ...app, metadataVersion: "Ashlands" }, "2.0.0", DIGEST_B);
    expect(update.body).toContain("The first number moved (1.4.1 to 2.0.0)");
    expect(update.body).toContain("`metadata.version` (Ashlands) doesn't read as the tag");
    expect(update.change.metadataVersion).toBeUndefined();
  });
});
