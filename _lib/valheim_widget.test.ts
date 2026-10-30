import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WidgetContext } from "./widget_context";
import { joinCode, players, playersLine, run } from "../valheim/widget_players";

// The lines a crossplay server installed by HexOS logged on demeter (TrueNAS 25.10.3, image 1.4.1)
// on 2026-10-29, the code replaced two seconds after it registered
const REGISTERED = '10/29/2026 11:48:06: Session "HexOS Valheim" registered with join code 144343';
const REPLACED = '10/29/2026 11:48:06: Created new join code 282677 for session "HexOS Valheim"';
const ACTIVE =
  '10/29/2026 11:48:08: Session "HexOS Valheim" with join code 282677 and IP 203.0.113.7:2456 is active with 0 player(s)';
const NO_CODE_YET = '10/29/2026 11:48:04: New session server "HexOS Valheim" that has join code , now 0 player(s)';

// A player joining and quitting on demeter on 2026-10-30, as the players file gets them
const ODVAR_IN = "10/30/2026 10:50:52: Got character ZDOID from Odvar Firebear : 1590326189:5";
const ODVAR_OUT = "10/30/2026 10:51:41: Destroying abandoned non persistent zdo 1590326189:5 owner 1590326189";
const spawned = (name: string, peer: string, n = 1) => `10/30/2026 11:00:00: Got character ZDOID from ${name} : ${peer}:${n}`;
const cleared = (peer: string, n = 1) => `10/30/2026 11:05:00: Destroying abandoned non persistent zdo ${peer}:${n} owner ${peer}`;

const context = (configDir: string | null): WidgetContext => ({
  appId: "valheim",
  host: "10.0.0.49",
  port: 2456,
  mounts: configDir
    ? [
        { hostPath: "/mnt/SSDs/Applications/valheim/server", containerPath: "/opt/valheim", localPath: "/tmp/unused" },
        { hostPath: "/mnt/SSDs/Applications/valheim/config", containerPath: "/config", localPath: configDir },
      ]
    : [],
  log: () => {},
});

function configDir(files: { session?: string; players?: string; world?: string } = {}): string {
  const dir = mkdtempSync(`${tmpdir()}/valheim-`);
  if (files.session !== undefined) writeFileSync(`${dir}/hexos-session.txt`, files.session);
  if (files.players !== undefined) writeFileSync(`${dir}/hexos-players.txt`, files.players);
  if (files.world !== undefined) writeFileSync(`${dir}/hexos-world.txt`, files.world);
  return dir;
}

describe("joinCode", () => {
  test("each line the server logs a code in gives it", () => {
    expect(joinCode(REGISTERED)).toBe("144343");
    expect(joinCode(REPLACED)).toBe("282677");
    expect(joinCode(ACTIVE)).toBe("282677");
  });

  test("the newest line wins, so a replaced code never shows", () => {
    expect(joinCode(`${REGISTERED}\n${REPLACED}\n`)).toBe("282677");
  });

  test("the line before a code exists names none", () => {
    expect(joinCode(NO_CODE_YET)).toBeNull();
    expect(joinCode("")).toBeNull();
  });

  test("a server name with a join code in it is never taken for the code", () => {
    expect(joinCode('10/29/2026 11:48:06: Session "with join code 99" registered with join code 123456')).toBe("123456");
    expect(joinCode('10/29/2026 11:48:06: Created new join code 123456 for session "join code 99"')).toBe("123456");
    expect(
      joinCode('10/29/2026 11:48:08: Session "join code 99" with join code 123456 and IP 203.0.113.7:2456 is active with 2 player(s)'),
    ).toBe("123456");
  });

  test("a file written on Windows line endings still reads", () => {
    expect(joinCode(`${REGISTERED}\r\n`)).toBe("144343");
  });
});

describe("players", () => {
  test("a player is on from spawning until their objects are cleared", () => {
    expect(players(`${ODVAR_IN}\n`)).toEqual(["Odvar Firebear"]);
    expect(players(`${ODVAR_IN}\n${ODVAR_OUT}\n`)).toEqual([]);
  });

  test("players stay in the order they arrived, and one leaving leaves the rest", () => {
    const log = [spawned("Astrid", "111"), spawned("Bjorn", "222"), spawned("Sigrid", "333"), cleared("222")];
    expect(players(log.join("\n"))).toEqual(["Astrid", "Sigrid"]);
  });

  test("dying and respawning keeps a player on, in their place", () => {
    const log = [spawned("Astrid", "111", 5), spawned("Bjorn", "222"), "10/30/2026 11:01:00: Got character ZDOID from Astrid : 0:0", spawned("Astrid", "111", 9)];
    expect(players(log.join("\n"))).toEqual(["Astrid", "Bjorn"]);
  });

  test("a player's leave clears them even when the cleared object isn't their character", () => {
    expect(players([spawned("Astrid", "111", 5), cleared("111", 12)].join("\n"))).toEqual([]);
  });

  test("an object cleared from someone not on the list changes nothing", () => {
    expect(players([spawned("Astrid", "111"), cleared("999")].join("\n"))).toEqual(["Astrid"]);
  });

  test("a name back under a new peer is the same player, so they're never counted twice", () => {
    expect(players([spawned("Astrid", "111"), spawned("Astrid", "444")].join("\n"))).toEqual(["Astrid"]);
  });

  test("a character name with a colon in it reads whole", () => {
    expect(players(spawned("Thor: the Second", "111"))).toEqual(["Thor: the Second"]);
  });

  test("a line from the server's other chatter is never a player", () => {
    expect(players("10/30/2026 10:50:41: Server: New peer connected,sending global keys\n")).toEqual([]);
    expect(players("")).toEqual([]);
  });

  test("a file written on Windows line endings still reads", () => {
    expect(players(`${ODVAR_IN}\r\n`)).toEqual(["Odvar Firebear"]);
  });
});

describe("playersLine", () => {
  test("names up to three players and counts the rest", () => {
    expect(playersLine(["Odvar Firebear"])).toBe("Odvar Firebear");
    expect(playersLine(["Odvar Firebear", "June Fireshield"])).toBe("Odvar Firebear and June Fireshield");
    expect(playersLine(["Odvar Firebear", "June Fireshield", "Astrid"])).toBe("Odvar Firebear, June Fireshield, and Astrid");
    const five = ["Odvar Firebear", "June Fireshield", "Astrid", "Bjorn", "Sigrid"];
    expect(playersLine(five)).toBe("Odvar Firebear, June Fireshield, and 3 more");
  });
});

describe("run", () => {
  const online = async (files: Parameters<typeof configDir>[0]) => {
    const list = (await run(context(configDir(files)))).fields?.online;
    if (list?.type !== "list") throw new Error("online is not a list");
    return list.entries;
  };

  test("with nobody on, the list is empty so the card folds, and the code is there for Settings", async () => {
    const result = await run(context(configDir({ session: `${ACTIVE}\n`, world: "Midgard" })));
    expect(result.fields?.online).toEqual({ type: "list", entries: [] });
    expect(result.fields?.count).toEqual({ type: "stat", label: "Players", value: "0/10" });
    expect(result.fields?.code).toEqual({ type: "stat", label: "Join code", value: "282677" });
    expect(result.needsSetup).toBeUndefined();
  });

  test("with players on, one entry: the world in bold, the players under it, over the campfire", async () => {
    const log = [spawned("Odvar Firebear", "111"), spawned("June Fireshield", "222"), spawned("Astrid", "333")].join("\n");
    const result = await run(context(configDir({ session: `${ACTIVE}\n`, players: log, world: "Midgard\n" })));
    expect(result.fields?.count).toEqual({ type: "stat", label: "Players", value: "3/10" });
    const [entry, ...rest] = await online({ players: log, world: "Midgard\n" });
    expect(rest).toEqual([]);
    expect(entry.title).toBe("Midgard");
    expect(entry.subtitle).toBe("Odvar Firebear, June Fireshield, and Astrid");
    expect(entry.image).toStartWith("data:image/webp;base64,");
    expect(entry.image!.length).toBeLessThanOrEqual(60_000);
  });

  test("a server started before the world file reads Valheim, and so does an empty one", async () => {
    expect((await online({ players: ODVAR_IN }))[0].title).toBe("Valheim");
    expect((await online({ players: ODVAR_IN, world: "" }))[0].title).toBe("Valheim");
  });

  // The Settings tab shows the row as still to come while the value is empty
  test("before the server is ready the code reads empty, nobody is on, and the card still folds", async () => {
    const result = await run(context(configDir()));
    expect(result.fields?.code).toEqual({ type: "stat", label: "Join code", value: "" });
    expect(result.fields?.online).toEqual({ type: "list", entries: [] });
  });

  test("a session file from before the code exists reads empty too", async () => {
    const result = await run(context(configDir({ session: `${NO_CODE_YET}\n` })));
    expect(result.fields?.code).toEqual({ type: "stat", label: "Join code", value: "" });
  });

  test("with no mounts known, the same", async () => {
    const result = await run(context(null));
    expect(result.fields?.code).toEqual({ type: "stat", label: "Join code", value: "" });
    expect(result.fields?.count).toEqual({ type: "stat", label: "Players", value: "0/10" });
  });
});
