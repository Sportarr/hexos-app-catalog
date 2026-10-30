// Image watcher. A custom app (custom: true) runs on TrueNAS's ix-app chart with the image its
// script pins in app_values.image, and an installed server sees a new image only as a raised
// script.version: the platform compares script versions and nothing else
// (isScriptUpdateAvailable). So for each custom app this finds the newest tag of its image shaped
// like the pinned one (1.4.1 is followed by 1.5.0, never by sha-0ab6cdc or latest; 21.2-1 by
// 21.2-2), and writes the change a pull request carries: the tag, with its digest when the pin
// carries one, a raised script.version, metadata.version where it reads as the tag, and the change
// log. A pin whose tag now names another digest (re-pushed upstream) is reported, never followed.
//
// Run: bun _lib/image_watch.ts check [--out plan.json]   what is newer, and any re-pushed pin
//      bun _lib/image_watch.ts apply plan.json <app>      write one app's update into its script
//
// The image-watch workflow runs both from the repo root and opens one pull request per app.
// Nothing here merges: a person tests the update on a lab box first.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { applyEdits, type JSONPath, modify } from "jsonc-parser";

// --- tags ---

export interface Pin {
  version: string;
  digest?: string;
}

/** A pinned tag as the script writes it: "1.4.1", or "1.4.1@sha256:…" with its digest. */
export function splitPin(tag: string): Pin {
  const at = tag.indexOf("@");
  return at < 0 ? { version: tag } : { version: tag.slice(0, at), digest: tag.slice(at + 1) };
}

export const joinPin = (pin: Pin): string => (pin.digest ? `${pin.version}@${pin.digest}` : pin.version);

/**
 * The tags shaped like this one: the same text between its numbers, any numbers. Null for a tag
 * with no number in it (latest), which names no version to follow.
 */
export function tagShape(version: string): RegExp | null {
  if (!/\d/.test(version)) return null;
  const pattern = version
    .split(/(\d+)/)
    .map((part, i) => (i % 2 === 1 ? "(\\d+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${pattern}$`);
}

const numbersOf = (version: string): number[] => (version.match(/\d+/g) ?? []).map(Number);

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The newest of `tags` shaped like `version` and later than it, or null when `version` is the newest. */
export function newestTag(version: string, tags: string[]): string | null {
  const shape = tagShape(version);
  if (!shape) return null;
  let newest: string | null = null;
  for (const tag of tags) {
    if (!shape.test(tag) || compareNumbers(numbersOf(tag), numbersOf(version)) <= 0) continue;
    if (newest === null || compareNumbers(numbersOf(tag), numbersOf(newest)) > 0) newest = tag;
  }
  return newest;
}

/** Whether the first number moved (1.4.1 to 2.0.0), where an image's options most often change. */
export const isMajorStep = (from: string, to: string): boolean => numbersOf(from)[0] !== numbersOf(to)[0];

/**
 * metadata.version after the move to `newTag`, where it reads as the old tag or as its leading
 * numbers (Kodi's 21.2 of 21.2-1, so 21.3-1 makes it 21.3); null where it says something else,
 * which the pull request then names for a person to check.
 */
export function followVersion(metadataVersion: string, oldTag: string, newTag: string): string | null {
  if (metadataVersion === oldTag) return newTag;
  if (!/\d$/.test(metadataVersion) || !oldTag.startsWith(metadataVersion)) return null;
  // 21.2 leads 21.2-1, but not 21.25-1
  if (/\d/.test(oldTag[metadataVersion.length] ?? "")) return null;
  const count = numbersOf(metadataVersion).length;
  // The new tag has the old one's shape, so its first `count` numbers sit after the same text
  return newTag
    .split(/(\d+)/)
    .slice(0, count * 2)
    .join("");
}

/** script.version with its last number raised: 1.0.1 becomes 1.0.2. */
export function raisePatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`script.version "${version}" is not x.y.z`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

// --- the script ---

export interface ScriptChange {
  tag: string;
  scriptVersion: string;
  changeLog: string;
  metadataVersion?: string;
}

/** JSON with every object's keys in order, so two documents that say the same thing compare equal. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

function setPath(document: Record<string, unknown>, path: string[], value: unknown) {
  let node = document;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path[path.length - 1]] = value;
}

/**
 * The script's text with the change written in place and every other byte as it was: scripts are
 * laid out by hand (Kodi's image is one line), and a reformatted file would bury the change in its
 * diff. Throws when the result says anything but the old script plus the change.
 */
export function applyChange(text: string, change: ScriptChange): string {
  const writes: Array<[string[], string]> = [
    [["app_values", "image", "tag"], change.tag],
    [["script", "version"], change.scriptVersion],
    [["script", "changeLog"], change.changeLog],
  ];
  if (change.metadataVersion !== undefined) writes.push([["metadata", "version"], change.metadataVersion]);

  // A key the script lacks (a first changeLog) goes in at the file's own indent
  const tabSize = /\n( +)"/.exec(text)?.[1].length ?? 2;
  const options = { formattingOptions: { insertSpaces: true, tabSize, eol: "\n" } };
  let next = text;
  for (const [path, value] of writes) next = applyEdits(next, modify(next, path as JSONPath, value, options));

  const expected = JSON.parse(text) as Record<string, unknown>;
  for (const [path, value] of writes) setPath(expected, path, value);
  if (canonical(JSON.parse(next)) !== canonical(expected)) {
    throw new Error("the rewritten script says more than the change; write it by hand");
  }
  return next;
}

// --- the catalog ---

export interface WatchedApp {
  app: string;
  file: string;
  name: string;
  repository: string;
  pin: string;
  scriptVersion: string;
  metadataVersion?: string;
  sources: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every custom app whose image pin names a version. A TrueNAS catalog app follows its chart, which
 * TrueNAS upgrades; a tag with no version in it (an internal test app's latest) has nothing to follow.
 */
export function watchedApps(dir = "."): WatchedApp[] {
  const apps: WatchedApp[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let script: unknown;
    try {
      script = JSON.parse(readFileSync(`${dir}/${file}`, "utf-8"));
    } catch {
      continue; // the validator reports it
    }
    if (!isObject(script) || script.custom !== true) continue;
    const image = isObject(script.app_values) ? script.app_values.image : undefined;
    if (!isObject(image) || typeof image.repository !== "string" || typeof image.tag !== "string") continue;
    if (!tagShape(splitPin(image.tag).version)) continue;
    const metadata = isObject(script.metadata) ? script.metadata : {};
    const block = isObject(script.script) ? script.script : {};
    apps.push({
      app: file.replace(/\.json$/, ""),
      file,
      name: typeof metadata.name === "string" ? metadata.name : file,
      repository: image.repository,
      pin: image.tag,
      scriptVersion: typeof block.version === "string" ? block.version : "",
      metadataVersion: typeof metadata.version === "string" ? metadata.version : undefined,
      sources: Array.isArray(metadata.sources) ? metadata.sources.filter((s): s is string => typeof s === "string") : [],
    });
  }
  return apps;
}

// --- registries ---

export interface Registry {
  host: string;
  repository: string;
}

const DOCKER_HUB = "registry-1.docker.io";

/** Where an image's tags live: Docker Hub for a bare name (eshtek/kodi), else the host its first part names. */
export function registryOf(image: string): Registry {
  const parts = image.split("/");
  const named = parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost");
  const host = !named || parts[0] === "docker.io" ? DOCKER_HUB : parts[0];
  const path = named ? parts.slice(1) : parts;
  // Docker Hub keeps its official images under library/
  return { host, repository: host === DOCKER_HUB && path.length === 1 ? `library/${path[0]}` : path.join("/") };
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** An anonymous pull token, as Docker Hub and GHCR hand one out for a public image. */
async function pullToken(registry: Registry): Promise<string | undefined> {
  const probe = await fetch(`https://${registry.host}/v2/`);
  await probe.body?.cancel();
  if (probe.status !== 401) return undefined;
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!/^Bearer /i.test(challenge) || !params.realm) {
    throw new Error(`${registry.host} asks for "${challenge}", not an anonymous pull token`);
  }
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  url.searchParams.set("scope", `repository:${registry.repository}:pull`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.host} refused a pull token for ${registry.repository} (${response.status})`);
  const body = (await response.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token;
}

const authorized = (token: string | undefined): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

async function listTags(registry: Registry, token: string | undefined): Promise<string[]> {
  const tags: string[] = [];
  let next: string | null = `https://${registry.host}/v2/${registry.repository}/tags/list?n=1000`;
  while (next) {
    const response: Response = await fetch(next, { headers: authorized(token) });
    if (!response.ok) throw new Error(`${registry.host}/${registry.repository}: the tag list answered ${response.status}`);
    const body = (await response.json()) as { tags?: string[] | null };
    tags.push(...(body.tags ?? []));
    const link = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    next = link ? new URL(link, next).toString() : null;
  }
  return tags;
}

/** The digest a tag names now: the index's, for an image built for several platforms. */
async function digestOf(registry: Registry, token: string | undefined, tag: string): Promise<string> {
  const response = await fetch(`https://${registry.host}/v2/${registry.repository}/manifests/${tag}`, {
    method: "HEAD",
    headers: { ...authorized(token), Accept: MANIFEST_TYPES },
  });
  const digest = response.headers.get("docker-content-digest");
  if (!response.ok || !digest) {
    throw new Error(`${registry.host}/${registry.repository}:${tag} has no digest to read (${response.status})`);
  }
  return digest;
}

// --- the plan ---

export interface ImageUpdate {
  app: string;
  file: string;
  name: string;
  repository: string;
  from: string;
  to: string;
  change: ScriptChange;
  title: string;
  body: string;
}

export interface Repushed {
  app: string;
  repository: string;
  pin: string;
  now: string;
}

export interface Plan {
  updates: ImageUpdate[];
  repushed: Repushed[];
  failures: Array<{ app: string; error: string }>;
}

/** The update for one app moving to `newVersion` (with `newDigest` when its pin carries one). */
export function updateFor(app: WatchedApp, newVersion: string, newDigest?: string): ImageUpdate {
  const pin = splitPin(app.pin);
  const to = joinPin({ version: newVersion, digest: pin.digest ? newDigest : undefined });
  const metadataVersion = app.metadataVersion ? followVersion(app.metadataVersion, pin.version, newVersion) : null;
  const change: ScriptChange = {
    tag: to,
    scriptVersion: raisePatch(app.scriptVersion),
    changeLog: `Runs ${app.repository} ${newVersion}.`,
    ...(metadataVersion !== null ? { metadataVersion } : {}),
  };
  const title = `${app.name}'s image moves to ${newVersion}`;

  const rows = [
    `| Image | \`${app.repository}:${pin.version}\` | \`${app.repository}:${newVersion}\` |`,
    ...(pin.digest ? [`| Digest | \`${pin.digest}\` | \`${newDigest}\` |`] : []),
    `| \`script.version\` | ${app.scriptVersion} | ${change.scriptVersion} |`,
    ...(app.metadataVersion !== undefined
      ? [`| \`metadata.version\` | ${app.metadataVersion} | ${metadataVersion ?? `${app.metadataVersion} (check it)`} |`]
      : []),
  ];
  const releases = app.sources
    .map((source) => /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/.exec(source)?.[1])
    .find(Boolean);
  const body = [
    `The image watcher found a newer image for ${app.name}. Installed servers see it as an update to the app's script once this merges and the catalog syncs.`,
    "",
    "| | Pinned | Newest |",
    "|---|---|---|",
    ...rows,
    "",
    ...(isMajorStep(pin.version, newVersion)
      ? [`⚠️ The first number moved (${pin.version} to ${newVersion}). Read the release notes for changed options before merging.`, ""]
      : []),
    ...(metadataVersion === null && app.metadataVersion !== undefined
      ? [`⚠️ \`metadata.version\` (${app.metadataVersion}) doesn't read as the tag, so it was left as it is. Set it by hand if the app's version moved.`, ""]
      : []),
    ...(releases ? [`Release notes: https://github.com/${releases.replace(/\.git$/, "")}/releases`, ""] : []),
    "Before merging: on a lab box, update an installed copy from its card's Update now and check it still runs with its data, then install it fresh.",
  ].join("\n");

  return { app: app.app, file: app.file, name: app.name, repository: app.repository, from: app.pin, to, change, title, body };
}

async function check(apps: WatchedApp[]): Promise<Plan> {
  const plan: Plan = { updates: [], repushed: [], failures: [] };
  for (const app of apps) {
    try {
      const registry = registryOf(app.repository);
      const token = await pullToken(registry);
      const pin = splitPin(app.pin);
      if (pin.digest) {
        const now = await digestOf(registry, token, pin.version);
        if (now !== pin.digest) plan.repushed.push({ app: app.app, repository: app.repository, pin: app.pin, now });
      }
      const newest = newestTag(pin.version, await listTags(registry, token));
      if (!newest) continue;
      const digest = pin.digest ? await digestOf(registry, token, newest) : undefined;
      plan.updates.push(updateFor(app, newest, digest));
    } catch (error) {
      plan.failures.push({ app: app.app, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return plan;
}

function report(apps: WatchedApp[], plan: Plan): string {
  const lines = [`## Image watch`, "", `${apps.length} custom app images checked.`, ""];
  for (const update of plan.updates) lines.push(`- ${update.name}: \`${update.from}\` → \`${update.to}\``);
  for (const repushed of plan.repushed) {
    lines.push(
      `- ⚠️ ${repushed.app}: \`${repushed.repository}:${splitPin(repushed.pin).version}\` now names \`${repushed.now}\`, not the pinned digest. Installed servers keep the pinned one; check what changed upstream.`,
    );
  }
  for (const failure of plan.failures) lines.push(`- ❌ ${failure.app}: ${failure.error}`);
  if (plan.updates.length + plan.repushed.length + plan.failures.length === 0) lines.push("Every image is on its newest tag.");
  return lines.join("\n");
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    const apps = watchedApps();
    const plan = await check(apps);
    const outAt = args.indexOf("--out");
    if (outAt >= 0) writeFileSync(args[outAt + 1], `${JSON.stringify(plan, null, 2)}\n`);
    console.log(report(apps, plan));
    // A registry that didn't answer fails the run, after the other apps' updates are planned
    process.exit(plan.failures.length > 0 ? 1 : 0);
  } else if (command === "apply" && args.length === 2) {
    const [planFile, app] = args;
    const plan = JSON.parse(readFileSync(planFile, "utf-8")) as Plan;
    const update = plan.updates.find((u) => u.app === app);
    if (!update) {
      console.error(`The plan has no update for ${app}`);
      process.exit(1);
    }
    writeFileSync(update.file, applyChange(readFileSync(update.file, "utf-8"), update.change));
    console.log(`${update.file}: ${update.from} → ${update.to}, script.version ${update.change.scriptVersion}`);
  } else {
    console.error("Usage: bun _lib/image_watch.ts check [--out plan.json] | apply plan.json <app>");
    process.exit(2);
  }
}
