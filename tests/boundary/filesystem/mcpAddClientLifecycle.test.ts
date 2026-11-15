import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clientConfigurationRecordSchema,
  parseClientConfiguration,
} from "../../../src/application/ClientConfigurationDocument.js";
import { parseGooseConfigurationYaml } from "../../../src/application/GooseConfigurationYaml.js";

import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import {
  readClientRegistrationInspections,
  readClientRegistrationStatuses,
} from "../../../src/application/ClientRegistrationStatus.js";
import { registerMcpClients } from "../../../src/application/McpClientRegistration.js";
import { resolveMcpRegistrationClients } from "../../../src/application/McpRegistrationCatalog.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import {
  runUninstall,
  systemUninstallHost,
} from "../../../src/application/Uninstall.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const platform = process.platform;
const command = currentClientRegistrationCommand({ platform });

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

// Each client REA registers through `rea mcp add` is one client-table row, so
// doctor, update and uninstall see what mcp add wrote (#7181).
it.each([
  { agent: "cline", client: "cline_vscode" },
  { agent: "kiro-cli", client: "kiro" },
  { agent: "mastracode", client: "mastracode" },
  { agent: "zed", client: "zed" },
  { agent: "amp", client: "amp" },
  { agent: "mcporter", client: "mcporter" },
  { agent: "fx", client: "fx" },
  { agent: "junie", client: "junie" },
  { agent: "goose", client: "goose" },
])(
  "inspects, refreshes and removes the $agent registration that mcp add wrote as $client",
  async ({ agent, client }) => {
    const home = await createTestTempDirectory(`rea-mcp-add-${client}-`);
    const environment = {};
    const resources = new ArtifactResourceScope();
    const selected = await resolveMcpRegistrationClients(
      { agents: [agent], global: true, cwd: home, home, platform, environment },
      resources,
    );
    if (!selected.ok) throw selected.error;
    const row = supportedClients(home, platform, environment).find(
      ({ name }) => name === client,
    );
    if (row === undefined) throw new Error(`${client} has no table row`);
    expect(selected.value.map(({ configPath }) => configPath)).toEqual([
      row.configPath,
    ]);

    // An older, still REA-owned launcher: the package runner form that
    // current setup migrates to the selected installation.
    const legacy = { command: "npx", args: ["-y", "rea-agents@1.0.0", "mcp"] };
    const [outcome] = await registerMcpClients(
      selected.value,
      legacy,
      undefined,
      resources,
    );
    expect(outcome).toMatchObject({
      status: "completed",
      result: { ok: true, value: { status: "configured" } },
    });
    const status = async () =>
      (
        await readClientRegistrationStatuses(home, command[1], {
          platform,
          environment,
        })
      ).find((entry) => entry.client === client);

    // Doctor reads the registration from the same row.
    expect(await status()).toMatchObject({
      config_path: row.configPath,
      command: [legacy.command, ...legacy.args],
      command_identity: "owned",
      state: "stale",
    });
    // Update selects it, and setup refreshes it to the current launcher.
    await expect(
      existingMaintenanceScope(home, command[1] ?? "", environment),
    ).resolves.toMatchObject({ clients: [client] });
    await expect(
      inspectClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "update" });
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await status()).toMatchObject({
      command: [...command],
      command_identity: "owned",
    });

    // Uninstall removes only REA's row and keeps the file.
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: client, status: "removed" }),
    );
    const remaining = parseClientConfiguration(
      await readFile(row.configPath, "utf8"),
      row.format,
    );
    expect(remaining.servers).not.toHaveProperty("rea");
    if (row.privateProfile !== undefined && platform !== "win32")
      expect((await stat(row.configPath)).mode & 0o777).toBe(0o600);
  },
);

it("keeps MCPorter out of setup detection and doctor until REA registers it", async () => {
  const home = await createTestTempDirectory("rea-mcporter-applicability-");
  const environment = {};
  const row = supportedClients(home, platform, environment).find(
    ({ name }) => name === "mcporter",
  );
  if (row === undefined) throw new Error("mcporter has no table row");
  await mkdir(join(home, ".mcporter"), { recursive: true });
  await writeFile(
    row.configPath,
    `${JSON.stringify({ mcpServers: { peer: { command: "peer" } } })}\n`,
  );
  expect(
    (await detectClients(home, platform, environment)).map(({ name }) => name),
  ).not.toContain("mcporter");
  const statuses = await readClientRegistrationStatuses(home, command[1], {
    platform,
    environment,
  });
  expect(statuses.map(({ client }) => client)).not.toContain("mcporter");
  // An explicit selection still reports the missing registration.
  const selected = await readClientRegistrationStatuses(home, command[1], {
    platform,
    environment,
    selectedClientIds: ["mcporter"],
  });
  expect(selected.find(({ client }) => client === "mcporter")).toMatchObject({
    state: "missing",
  });
});

it.skipIf(platform === "win32")(
  "setup publishes fx's profile privately and repairs its modes",
  async () => {
    const home = await createTestTempDirectory("rea-fx-private-");
    const row = supportedClients(home, platform, {}).find(
      ({ name }) => name === "fx",
    );
    if (row === undefined) throw new Error("fx has no table row");
    const modes = async () => ({
      directory: (await stat(dirname(row.configPath))).mode & 0o777,
      file: (await stat(row.configPath)).mode & 0o777,
    });
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await modes()).toEqual({ directory: 0o700, file: 0o600 });
    await expect(inspectClientConfiguration(row, {}, command)).resolves.toEqual(
      { status: "already_current" },
    );

    // A current row in a readable profile still needs its modes restored.
    await chmod(row.configPath, 0o644);
    await chmod(dirname(row.configPath), 0o755);
    await expect(
      inspectClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "update" });
    // Re-selection after a Hopper install uses the same modes rule.
    await expect(clientConfigurationAligned(row, {}, command)).resolves.toBe(
      false,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await modes()).toEqual({ directory: 0o700, file: 0o600 });
    await expect(clientConfigurationAligned(row, {}, command)).resolves.toBe(
      true,
    );

    // A linked profile is judged by the folder and file it names.
    const target = join(home, "fx-profile");
    await rename(dirname(row.configPath), target);
    await symlink(target, dirname(row.configPath));
    await expect(inspectClientConfiguration(row, {}, command)).resolves.toEqual(
      { status: "already_current" },
    );
  },
);

it.skipIf(platform === "win32")(
  "setup surfaces the private folder handle it could not close",
  async () => {
    const home = await createTestTempDirectory("rea-fx-private-close-");
    const row = supportedClients(home, platform, {}).find(
      ({ name }) => name === "fx",
    );
    if (row === undefined) throw new Error("fx has no table row");
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if ((await this.handle.stat()).isDirectory())
          throw new Error("fixture private directory close denied");
        return originalClose.call(this);
      });
    try {
      // The failed close keeps its owner on the error instead of becoming a
      // write failure that drops it.
      await expect(
        configureClientConfiguration(row, {}, command),
      ).rejects.toMatchObject({ cleanupIncomplete: true });
    } finally {
      close.mockRestore();
    }
  },
);

it("reports a Junie registration Junie would not load in doctor and setup", async () => {
  const home = await createTestTempDirectory("rea-junie-policy-");
  const environment = { JUNIE_MCP_DEFAULT_LOCATIONS: "false" };
  const row = supportedClients(home, platform, environment).find(
    ({ name }) => name === "junie",
  );
  if (row === undefined) throw new Error("junie has no table row");
  await mkdir(dirname(row.configPath), { recursive: true });
  await writeFile(
    row.configPath,
    `${JSON.stringify({ mcpServers: { rea: { command: command[0], args: command.slice(1) } } })}\n`,
  );
  const status = (
    await readClientRegistrationStatuses(home, command[1], {
      platform,
      environment,
    })
  ).find(({ client }) => client === "junie");
  expect(status).toMatchObject({
    state: "stale",
    remediation: expect.stringContaining("JUNIE_MCP_DEFAULT_LOCATIONS"),
  });
  await expect(
    inspectClientConfiguration(row, {}, command),
  ).resolves.toMatchObject({ status: "invalid" });
});

it.skipIf(platform === "win32")(
  "reports Goose's effective registration across its read-only layers",
  async () => {
    const home = await createTestTempDirectory("rea-goose-layers-");
    const additional = join(home, "team", "goose.yaml");
    await mkdir(dirname(additional), { recursive: true });
    const lower = "extensions:\n  rea:\n    enabled: false\n";
    await writeFile(additional, lower);
    const environment = { GOOSE_ADDITIONAL_CONFIG_FILES: additional };
    const resources = new ArtifactResourceScope();
    const selected = await resolveMcpRegistrationClients(
      {
        agents: ["goose"],
        global: true,
        cwd: home,
        home,
        platform,
        environment,
      },
      resources,
    );
    if (!selected.ok) throw selected.error;
    const row = supportedClients(home, platform, environment).find(
      ({ name }) => name === "goose",
    );
    expect(row?.configPaths).toEqual([
      "/etc/goose/config.yaml",
      additional,
      row?.configPath,
    ]);
    const [outcome] = await registerMcpClients(
      selected.value,
      { command: command[0] ?? "", args: command.slice(1) },
      undefined,
      resources,
    );
    expect(outcome).toMatchObject({
      status: "completed",
      result: { ok: true },
    });
    // The user file does not set `enabled`, so the lower layer's false holds.
    const inspections = await readClientRegistrationInspections(
      home,
      command[1],
      { platform, environment },
    );
    expect(
      inspections.find(({ status }) => status.client === "goose"),
    ).toMatchObject({ activation: "disabled", status: { state: "stale" } });
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: "goose", status: "removed" }),
    );
    // Uninstall changes only the user file Goose writes.
    expect(await readFile(additional, "utf8")).toBe(lower);
  },
);

it("orders Goose's layers as Goose loads them", () => {
  const home = "/fixture/home";
  const user = "/fixture/home/.config/goose/config.yaml";
  const unix = supportedClients(home, "linux", {
    GOOSE_ADDITIONAL_CONFIG_FILES: `${user}:/fixture/team.yaml`,
  }).find(({ name }) => name === "goose");
  // Goose loads the user file again last, so that load decides precedence.
  expect(unix?.configPaths).toEqual([
    "/etc/goose/config.yaml",
    "/fixture/team.yaml",
    user,
  ]);
  const windows = supportedClients("C:\\Users\\fixture", "win32", {
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    PROGRAMDATA: "C:\\ProgramData",
    GOOSE_ADDITIONAL_CONFIG_FILES:
      '"C:\\Team Config\\a;b.yaml";C:\\Team\\goose.yaml',
  }).find(({ name }) => name === "goose");
  expect(windows?.configPathError).toBeUndefined();
  expect(windows?.configPaths?.slice(1, 3)).toEqual([
    "C:\\Team Config\\a;b.yaml",
    "C:\\Team\\goose.yaml",
  ]);
});

// The system layer is the host's /etc/goose/config.yaml; these cases need it absent.
it.skipIf(platform === "win32" || existsSync("/etc/goose/config.yaml"))(
  "refreshes Goose's environment through setup without losing inherited or aliased settings",
  async () => {
    const home = await createTestTempDirectory("rea-goose-environment-");
    const team = join(home, "team.yaml");
    const environment = { GOOSE_ADDITIONAL_CONFIG_FILES: team };
    const row = supportedClients(home, platform, environment).find(
      ({ name }) => name === "goose",
    );
    if (row === undefined) throw new Error("Goose has no table row");
    await mkdir(dirname(row.configPath), { recursive: true });
    const userEntry = async () =>
      (
        clientConfigurationRecordSchema.parse(
          parseGooseConfigurationYaml(await readFile(row.configPath, "utf8")),
        ).extensions as Record<string, Record<string, unknown>>
      ).rea;

    const launcher = `    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n`;

    // A lower map stays in effect when the user entry declares none.
    await writeFile(
      team,
      'extensions:\n  rea:\n    envs:\n      TEAM_SETTING: "1"\n',
    );
    await writeFile(row.configPath, `extensions:\n  rea:\n${launcher}`);
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await userEntry()).not.toHaveProperty("envs");

    // The env alias is read and written back as envs.
    await writeFile(team, "{}\n");
    await writeFile(
      row.configPath,
      `extensions:\n  rea:\n${launcher}    env:\n      KEEP: "1"\n`,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await userEntry()).toMatchObject({ envs: { KEEP: "1" } });
    expect(await userEntry()).not.toHaveProperty("env");

    // A requested setting replaces the recorded value.
    await expect(
      configureClientConfiguration(
        row,
        { REA_ANALYSIS_PROVIDER: "ghidra" },
        command,
      ),
    ).resolves.toMatchObject({ status: "configured" });
    expect(await userEntry()).toMatchObject({
      envs: { KEEP: "1", REA_ANALYSIS_PROVIDER: "ghidra" },
    });
  },
);

it.skipIf(platform === "win32" || existsSync("/etc/goose/config.yaml"))(
  "keeps Goose's user registration while a read-only layer would stay enabled",
  async () => {
    const home = await createTestTempDirectory("rea-goose-uninstall-");
    const team = join(home, "team.yaml");
    const environment = { GOOSE_ADDITIONAL_CONFIG_FILES: team };
    const row = supportedClients(home, platform, environment).find(
      ({ name }) => name === "goose",
    );
    if (row === undefined) throw new Error("Goose has no table row");
    await writeFile(
      team,
      `extensions:\n  rea:\n    type: stdio\n    cmd: ${JSON.stringify(command[0])}\n    args: ${JSON.stringify(command.slice(1))}\n`,
    );
    await expect(
      configureClientConfiguration(row, {}, command),
    ).resolves.toMatchObject({ status: "configured" });
    const before = await readFile(row.configPath, "utf8");
    const uninstall = await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform),
    );
    expect(uninstall.items).toContainEqual(
      expect.objectContaining({ name: "goose", status: "failed" }),
    );
    expect(await readFile(row.configPath, "utf8")).toBe(before);
  },
);
