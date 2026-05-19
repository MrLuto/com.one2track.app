import fs from "node:fs";
import path from "node:path";

import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthenticationError } from "../app/domain/errors";
import {
  extractAccountIdFromRedirect,
  One2TrackClient,
  parseCommandOptions,
  parseCsrfTokenFromHtml,
  parseDevicePage,
  parseFormValues,
  parseFunctionsList,
} from "../app/infra/one2trackClient";

const baseUrl = "https://www.one2trackgps.com";
const fixtureDir = path.join(__dirname, "fixtures");
const loginHtml = fs.readFileSync(path.join(fixtureDir, "login-page.html"), "utf8");
const devicesJson = fs.readFileSync(path.join(fixtureDir, "devices.json"), "utf8");

const functionsHtml = `
  <a href="/devices/uuid-1/functions?function=1015&list_only=true">Find device</a>
  <a href="/devices/uuid-1/functions?function=1116&list_only=true">Profile mode</a>
  <a href="/devices/uuid-1/functions?function=0077&list_only=true">GPS interval</a>
  <a href="/devices/uuid-1/functions?function=0079&list_only=true">Step counter</a>
  <a href="/devices/uuid-1/functions?function=0080&list_only=true">Whitelist 1</a>
  <a href="/devices/uuid-1/functions?function=0081&list_only=true">Whitelist 2</a>
  <a href="/devices/uuid-1/functions?function=1315&list_only=true">Phonebook</a>
  <a href="/devices/uuid-1/functions?function=0048&list_only=true">Remote shutdown</a>
`;

const radioOptionsHtml = `
  <label>Power saving</label>
  <input type="radio" name="function[cmd_value][]" value="1">
  <label>Active</label>
  <input type="radio" name="function[cmd_value][]" value="2" checked>
`;

const formValuesHtml = `
  <input name="function[cmd_value][]" value="Mom">
  <input name="function[cmd_value][]" value="+31600000001">
  <input name="function[cmd_value][]" value="Dad">
  <input name="function[cmd_value][]" value="+31600000002">
`;

const devicePageHtml = `
  <html>
    <head><meta name="csrf-token" content="csrf-12345"></head>
    <body>
      <script>
        var device = {"model_id":77,"model_name":"Connect UP","phonebook_count":2,"whitelist_count":3,"status":"GPS"};
        var last_location = {"course":"182","created_at":"2026-05-15T10:00:00.000Z","address":"Garden Street 8","location_type":"WIFI"};
      </script>
    </body>
  </html>
`;

describe("One2TrackClient", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("parses csrf tokens from the login page", () => {
    expect(parseCsrfTokenFromHtml(loginHtml)).toBe("csrf-12345");
  });

  it("parses authenticity token inputs as csrf fallback", () => {
    expect(
      parseCsrfTokenFromHtml('<input type="hidden" name="authenticity_token" value="fallback-123" />'),
    ).toBe("fallback-123");
  });

  it("extracts the account id from an upstream redirect", () => {
    expect(extractAccountIdFromRedirect("/users/account-123/devices")).toBe("account-123");
  });

  it("parses functions, options and raw device page state", () => {
    expect(parseFunctionsList(functionsHtml)).toMatchObject({
      "1015": "Find device",
      "1116": "Profile mode",
      "0077": "GPS interval",
    });

    expect(parseCommandOptions(radioOptionsHtml)).toEqual([
      { value: "1", label: "Power saving", checked: false },
      { value: "2", label: "Active", checked: true },
    ]);

    expect(parseFormValues(formValuesHtml)).toEqual(["Mom", "+31600000001", "Dad", "+31600000002"]);
    expect(parseDevicePage(devicePageHtml)).toEqual({
      device: {
        model_id: 77,
        model_name: "Connect UP",
        phonebook_count: 2,
        whitelist_count: 3,
        status: "GPS",
      },
      last_location: {
        course: "182",
        created_at: "2026-05-15T10:00:00.000Z",
        address: "Garden Street 8",
        location_type: "WIFI",
      },
    });
  });

  it("authenticates and refreshes devices", async () => {
    const client = new One2TrackClient({
      accountId: "",
      username: "user",
      password: "secret",
    });

    mockAuthentication();
    nock(baseUrl).get("/users/account-123/devices").reply(200, devicesJson, {
      "content-type": "application/json",
    });

    const devices = await client.refreshDeviceList();

    expect(devices).toHaveLength(1);
    expect(devices[0].uuid).toBe("uuid-1");
    expect(devices[0].simcard?.balance_cents).toBe(123);
  });

  it("discovers a capability profile and raw diagnostics", async () => {
    const client = new One2TrackClient({
      accountId: "",
      username: "user",
      password: "secret",
    });

    mockAuthentication();
    nock(baseUrl)
      .get("/users/account-123/devices")
      .times(2)
      .reply(200, devicesJson, {
        "content-type": "application/json",
      });

    nock(baseUrl)
      .get("/devices/uuid-1/functions")
      .query({ list_only: "true" })
      .reply(200, functionsHtml, { "content-type": "text/html" });

    nock(baseUrl)
      .get("/devices/uuid-1/functions")
      .query({ function: "1116", list_only: "true", modal: "true" })
      .reply(200, radioOptionsHtml, { "content-type": "text/html" });

    nock(baseUrl)
      .get("/devices/uuid-1/functions")
      .query({ function: "0077", list_only: "true", modal: "true" })
      .reply(200, radioOptionsHtml, { "content-type": "text/html" });

    nock(baseUrl)
      .get("/devices/uuid-1/functions")
      .query({ function: "0079", list_only: "true", modal: "true" })
      .reply(200, radioOptionsHtml, { "content-type": "text/html" });

    nock(baseUrl).get("/devices/uuid-1").reply(200, devicePageHtml, {
      "content-type": "text/html",
    });

    const profile = await client.discoverCapabilityProfile("uuid-1");
    const diagnostics = await client.getRawDeviceData("uuid-1", null, profile);

    expect(profile.supportFlags.canFindDevice).toBe(true);
    expect(profile.supportFlags.canSetProfileMode).toBe(true);
    expect(profile.codes.gpsInterval).toBe("0077");
    expect(profile.options["1116"]?.[1]?.checked).toBe(true);
    expect(diagnostics.capabilityProfile?.codes.remoteShutdown).toBe("0048");
    expect(diagnostics.htmlState?.device?.model_name).toBe("Connect UP");
  });

  it("rejects invalid credentials", async () => {
    const client = new One2TrackClient({
      accountId: "",
      username: "user",
      password: "wrong",
    });

    nock(baseUrl)
      .get("/auth/users/sign_in")
      .reply(200, loginHtml, {
        "content-type": "text/html",
        "set-cookie": "_iadmin=session-prelogin; Path=/;",
      });

    nock(baseUrl)
      .post("/auth/users/sign_in")
      .reply(200, "invalid", {
        "content-type": "text/html",
      });

    await expect(client.authenticate(true)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("sends a message and device commands", async () => {
    const client = new One2TrackClient({
      accountId: "",
      username: "user",
      password: "secret",
    });

    mockAuthentication();
    nock(baseUrl)
      .get("/users/account-123/devices")
      .times(4)
      .reply(200, loginHtml, {
        "content-type": "text/html",
      });

    nock(baseUrl)
      .post("/devices/uuid-1/messages")
      .reply(200, "ok", { "content-type": "text/html" });

    nock(baseUrl)
      .post("/devices/uuid-1/functions")
      .times(3)
      .reply(200, "ok", { "content-type": "application/json" });

    await expect(client.sendMessage("uuid-1", "Test")).resolves.toBeUndefined();
    await expect(client.forceUpdate("uuid-1")).resolves.toBeUndefined();
    await expect(client.findDevice("uuid-1")).resolves.toBeUndefined();
    await expect(client.sendCommand("uuid-1", "0048")).resolves.toBeUndefined();
  });

  it("tolerates upstream 406 responses for successful device commands", async () => {
    const client = new One2TrackClient({
      accountId: "",
      username: "user",
      password: "secret",
    });

    mockAuthentication();
    nock(baseUrl)
      .get("/users/account-123/devices")
      .times(3)
      .reply(200, loginHtml, {
        "content-type": "text/html",
      });

    nock(baseUrl)
      .post("/devices/uuid-1/functions")
      .times(3)
      .reply(406, "", { "content-type": "text/vnd.turbo-stream.html" });

    await expect(client.findDevice("uuid-1")).resolves.toBeUndefined();
    await expect(client.sendCommand("uuid-1", "0077", ["10"])).resolves.toBeUndefined();
    await expect(client.sendCommand("uuid-1", "1116", ["3"])).resolves.toBeUndefined();
  });
});

function mockAuthentication(): void {
  nock(baseUrl)
    .get("/auth/users/sign_in")
    .reply(200, loginHtml, {
      "content-type": "text/html",
      "set-cookie": ["_iadmin=session-prelogin; Path=/;", "_session_id=alt-session; Path=/;"],
    });

  nock(baseUrl)
    .post("/auth/users/sign_in")
    .reply(302, "", {
      location: "/users/account-123/devices",
      "set-cookie": "_iadmin=session-auth; Path=/;",
    });

  nock(baseUrl)
    .get("/")
    .reply(302, "", {
      location: "/users/account-123/devices",
    });
}
