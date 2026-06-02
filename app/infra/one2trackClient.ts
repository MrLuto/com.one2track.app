import { CookieJar } from "tough-cookie";

import { buildCapabilityProfile, COMMAND_CODES } from "../domain/commands";
import { AuthenticationError, ParseError, RateLimitError, TransportError } from "../domain/errors";
import type { DebugContext } from "./debugLogger";
import type {
  AccountCredentials,
  CommandOption,
  RawDevicePageState,
  RawTrackerDevice,
  TrackerCapabilityProfile,
  TrackerDiagnostics,
} from "../domain/types";

const BASE_URL = "https://www.one2trackgps.com";
const LOGIN_URL = `${BASE_URL}/auth/users/sign_in`;
const ALTERNATIVE_SESSION_COOKIE = "_session_id";
const OPTION_DISCOVERY_CODES = [...new Set(["1116", "0077", "0078", "0079", "0082"])];

type DebugReporter = (source: string, message: string, data?: unknown, context?: DebugContext) => void;

type TextResponse = {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body: string;
};

async function createHttpClientAsync(cookieJar: CookieJar): Promise<any> {
  const { default: got } = await import("got");

  return got.extend({
    cookieJar,
    followRedirect: false,
    https: {
      rejectUnauthorized: true,
    },
    headers: {
      "user-agent": "Homey-One2Track/1.1",
      accept: "text/html,application/json,application/xhtml+xml",
    },
  });
}

function looksLikeHtmlDocument(body: string): boolean {
  return body.trimStart().startsWith("<");
}

export function parseCsrfTokenFromHtml(html: string): string {
  const metaMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i);
  if (metaMatch) {
    return metaMatch[1];
  }

  const inputMatch = html.match(/name="authenticity_token"[^>]+value="([^"]+)"/i);
  if (inputMatch) {
    return inputMatch[1];
  }

  throw new ParseError("Could not extract CSRF token from upstream HTML");
}

export function extractAccountIdFromRedirect(location: string | undefined): string {
  if (!location) {
    throw new ParseError("Missing redirect location for account discovery");
  }

  const match = location.match(/\/users\/([^/]+)\//);
  if (!match) {
    throw new ParseError(`Could not extract account id from redirect: ${location}`);
  }

  return match[1];
}

export function parseFunctionsList(html: string): Record<string, string> {
  const functions: Record<string, string> = {};
  const regex = /href="[^"]*function=(\d+)[^"]*"[^>]*>(.*?)<\/a>/gis;

  for (const match of html.matchAll(regex)) {
    const code = match[1];
    const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    functions[code] = decodeHtml(label);
  }

  return functions;
}

export function parseCommandOptions(html: string): CommandOption[] {
  const options: CommandOption[] = [];
  const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*name="function\[cmd_value\]\[\]"[^>]*value="([^"]*)"([^>]*)>/gi)];
  const labels = [...html.matchAll(/<label[^>]*>(.*?)<\/label>/gis)];

  radios.forEach((radioMatch, index) => {
    const labelHtml = labels[index]?.[1] ?? "";
    options.push({
      value: radioMatch[1],
      label: decodeHtml(labelHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
      checked: /\bchecked\b/i.test(radioMatch[2]),
    });
  });

  return options;
}

export function parseFormValues(html: string): string[] {
  return [...html.matchAll(/<input[^>]*name="function\[cmd_value\]\[\]"[^>]*value="([^"]*)"/gi)].map(
    (match) => decodeHtml(match[1]),
  );
}

export function parseDevicePage(html: string): RawDevicePageState {
  const state: RawDevicePageState = {};
  const decoder = JSON;

  const deviceAnchor = html.search(/var device\s*=\s*/i);
  if (deviceAnchor >= 0) {
    const start = deviceAnchor + html.slice(deviceAnchor).match(/var device\s*=\s*/i)![0].length;
    const parsed = rawDecodeObject(html, start, decoder);
    if (parsed) {
      state.device = parsed;
    }
  }

  const locationAnchor = html.search(/var last_location\s*=\s*/i);
  if (locationAnchor >= 0) {
    const start =
      locationAnchor + html.slice(locationAnchor).match(/var last_location\s*=\s*/i)![0].length;
    const parsed = rawDecodeObject(html, start, decoder);
    if (parsed) {
      state.last_location = parsed;
    }
  }

  return state;
}

function rawDecodeObject(source: string, start: number, decoder: JSON): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  if (end === -1) {
    return null;
  }

  try {
    return decoder.parse(source.slice(start, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export class One2TrackClient {
  private readonly cookieJar = new CookieJar();
  private httpPromise: Promise<any> | null = null;

  private readonly username: string;
  private password: string;
  private accountId: string;
  private authenticated = false;

  constructor(
    credentials: AccountCredentials,
    private readonly logger?: DebugReporter,
    private readonly errorLogger?: DebugReporter,
  ) {
    this.username = credentials.username;
    this.password = credentials.password;
    this.accountId = credentials.accountId;
  }

  updateCredentials(credentials: AccountCredentials): void {
    this.password = credentials.password;
    this.accountId = credentials.accountId;
    this.authenticated = false;
    this.log("Updated client credentials", undefined, {
      accountId: credentials.accountId,
      username: credentials.username,
    });
  }

  async authenticate(force = false): Promise<string> {
    if (this.authenticated && !force) {
      this.log("Reusing authenticated session");
      return this.accountId;
    }

    this.log("Authenticating upstream session", { force }, {
      accountId: this.accountId,
      username: this.username,
    });
    const loginPageResponse = await this.request(LOGIN_URL);
    const csrfToken = parseCsrfTokenFromHtml(loginPageResponse.body);

    const loginResponse = await this.request(LOGIN_URL, {
      method: "POST",
      form: {
        authenticity_token: csrfToken,
        "user[login]": this.username,
        "user[password]": this.password,
        gdpr: "1",
        "user[remember_me]": "1",
      },
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
    });

    if (![302, 303].includes(loginResponse.statusCode)) {
      throw new AuthenticationError("One2Track rejected the supplied credentials");
    }

    const accountRedirect = await this.request(BASE_URL, {
      followRedirect: false,
    });

    this.accountId = extractAccountIdFromRedirect(accountRedirect.headers.location);
    this.authenticated = true;
    this.log("Authenticated upstream session", {
      accountId: this.accountId,
    }, {
      accountId: this.accountId,
      username: this.username,
    });
    return this.accountId;
  }

  async refreshDeviceList(): Promise<RawTrackerDevice[]> {
    return this.withAuthenticatedRetry(async () => {
      this.log("Fetching device list", undefined, {
        accountId: this.accountId,
        username: this.username,
      });
      const response = await this.request(`${BASE_URL}/users/${this.accountId}/devices`, {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      });

      if (looksLikeHtmlDocument(response.body)) {
        this.authenticated = false;
        throw new AuthenticationError("One2Track returned HTML instead of device JSON");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch (error) {
        throw new ParseError("Could not parse One2Track device response", { cause: error });
      }

      if (!Array.isArray(payload)) {
        throw new ParseError("One2Track device response is not an array");
      }

      const devices = payload.map((entry) => {
        if (!entry || typeof entry !== "object" || !("device" in entry)) {
          throw new ParseError("One2Track device list entry is missing a device payload");
        }

        return (entry as { device: RawTrackerDevice }).device;
      });

      this.log("Fetched device list", {
        count: devices.length,
        trackerUuids: devices.map((device) => device.uuid),
      }, {
        accountId: this.accountId,
        username: this.username,
      });
      return devices;
    });
  }

  async fetchDeviceState(deviceUuid: string): Promise<RawDevicePageState | null> {
    return this.withAuthenticatedRetry(async () => {
      this.log("Fetching device state page", undefined, this.createContext(deviceUuid));
      const response = await this.request(`${BASE_URL}/devices/${deviceUuid}`);
      if (looksLikeHtmlDocument(response.body)) {
        const parsed = parseDevicePage(response.body);
        this.log("Fetched device state page", {
          hasDevicePayload: Boolean(parsed.device),
          hasLocationPayload: Boolean(parsed.last_location),
        }, this.createContext(deviceUuid));
        return parsed;
      }

      this.log("Device state page did not return HTML", {
        statusCode: response.statusCode,
      }, this.createContext(deviceUuid));
      return null;
    });
  }

  async discoverCapabilityProfile(deviceUuid: string): Promise<TrackerCapabilityProfile> {
    return this.withAuthenticatedRetry(async () => {
      this.log("Discovering capability profile", undefined, this.createContext(deviceUuid));
      const response = await this.request(`${BASE_URL}/devices/${deviceUuid}/functions?list_only=true`);
      const functions = parseFunctionsList(response.body);
      const options: Record<string, CommandOption[]> = {};

      for (const code of OPTION_DISCOVERY_CODES) {
        if (!(code in functions)) {
          continue;
        }

        const optionResponse = await this.request(
          `${BASE_URL}/devices/${deviceUuid}/functions?function=${code}&list_only=true&modal=true`,
        );
        const parsedOptions = parseCommandOptions(optionResponse.body);
        if (parsedOptions.length > 0) {
          options[code] = parsedOptions;
        }
      }

      const profile = buildCapabilityProfile(functions, options);
      this.log("Discovered capability profile", {
        functionCount: Object.keys(functions).length,
        optionGroups: Object.keys(options),
      }, this.createContext(deviceUuid));
      return profile;
    });
  }

  async fetchFormValues(deviceUuid: string, commandCode: string): Promise<string[]> {
    return this.withAuthenticatedRetry(async () => {
      this.log("Fetching form values", {
        commandCode,
      }, this.createContext(deviceUuid));
      const response = await this.request(
        `${BASE_URL}/devices/${deviceUuid}/functions?function=${commandCode}&list_only=true&modal=true`,
      );
      const values = parseFormValues(response.body);
      this.log("Fetched form values", {
        commandCode,
        valueCount: values.length,
      }, this.createContext(deviceUuid));
      return values;
    });
  }

  async getRawDeviceData(
    deviceUuid: string,
    localSettings: TrackerDiagnostics["localSettings"] = null,
    capabilityProfile: TrackerCapabilityProfile | null = null,
  ): Promise<TrackerDiagnostics> {
    this.log("Collecting raw device diagnostics", undefined, this.createContext(deviceUuid));
    const [jsonApi] = (await this.refreshDeviceList()).filter((device) => device.uuid === deviceUuid);
    const htmlState = await this.fetchDeviceState(deviceUuid);
    const discoveredProfile = capabilityProfile ?? (await this.discoverCapabilityProfile(deviceUuid));

    return {
      jsonApi: jsonApi ?? null,
      htmlState,
      capabilityProfile: discoveredProfile,
      localSettings,
    };
  }

  async sendMessage(deviceUuid: string, message: string): Promise<void> {
    await this.withAuthenticatedRetry(async () => {
      this.log("Sending upstream message", { message }, this.createContext(deviceUuid));
      const csrfToken = await this.fetchActionCsrfToken();
      const response = await this.request(`${BASE_URL}/devices/${deviceUuid}/messages`, {
        method: "POST",
        headers: {
          "x-csrf-token": csrfToken,
          accept: "text/vnd.turbo-stream.html, text/html, application/xhtml+xml",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        form: {
          utf8: "✓",
          authenticity_token: csrfToken,
          "device_message[message]": message,
        },
      });

      if (response.statusCode !== 200) {
        throw new TransportError(`One2Track message endpoint returned ${response.statusCode}`);
      }

      this.log("Sent upstream message", {
        statusCode: response.statusCode,
      }, this.createContext(deviceUuid));
    });
  }

  async forceUpdate(deviceUuid: string): Promise<void> {
    await this.sendCommand(deviceUuid, COMMAND_CODES.refreshLocation);
  }

  async findDevice(deviceUuid: string): Promise<void> {
    await this.sendCommand(deviceUuid, COMMAND_CODES.findDevice);
  }

  async sendCommand(deviceUuid: string, commandCode: string, values: string[] = []): Promise<void> {
    await this.withAuthenticatedRetry(async () => {
      this.log("Sending upstream command", {
        commandCode,
        values,
      }, this.createContext(deviceUuid));
      const csrfToken = await this.fetchActionCsrfToken();
      const form: Array<[string, string]> = [
        ["utf8", "✓"],
        ["_method", "patch"],
        ["authenticity_token", csrfToken],
        ["function[cmd_code]", commandCode],
      ];

      for (const value of values) {
        form.push(["function[cmd_value][]", value]);
      }

      const response = await this.request(`${BASE_URL}/devices/${deviceUuid}/functions`, {
        method: "POST",
        headers: {
          "x-csrf-token": csrfToken,
          accept: "text/vnd.turbo-stream.html, text/html, application/xhtml+xml",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: new URLSearchParams(form).toString(),
      });

      if (commandCode === COMMAND_CODES.phonebook && response.statusCode === 500) {
        return;
      }

      // Upstream often applies the command and then returns 406 when the requested
      // response format is not negotiable for this endpoint.
      if (![200, 204, 406].includes(response.statusCode)) {
        throw new TransportError(`One2Track command ${commandCode} returned ${response.statusCode}`);
      }

      this.log("Sent upstream command", {
        commandCode,
        statusCode: response.statusCode,
      }, this.createContext(deviceUuid));
    });
  }

  private async withAuthenticatedRetry<T>(callback: () => Promise<T>): Promise<T> {
    await this.authenticate();

    try {
      return await callback();
    } catch (error) {
      if (!this.shouldRetry(error)) {
        throw error;
      }

      this.log("Retrying after authentication issue", error, {
        accountId: this.accountId,
        username: this.username,
      });
      this.authenticated = false;
      await this.authenticate(true);
      return callback();
    }
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof AuthenticationError) {
      return true;
    }

    if (error instanceof TransportError) {
      return /401|403/.test(error.message);
    }

    return false;
  }

  private async fetchActionCsrfToken(): Promise<string> {
    try {
      const accountPageResponse = await this.request(`${BASE_URL}/users/${this.accountId}/devices`);
      return parseCsrfTokenFromHtml(accountPageResponse.body);
    } catch {
      this.log("Falling back to login page for CSRF token", undefined, {
        accountId: this.accountId,
        username: this.username,
      });
      const response = await this.request(LOGIN_URL);
      return parseCsrfTokenFromHtml(response.body);
    }
  }

  private async request(url: string, options: Record<string, unknown> = {}): Promise<TextResponse> {
    const method = String(options.method ?? "GET").toUpperCase();
    const startedAt = Date.now();
    this.log("HTTP request started", {
      method,
      url,
      hasForm: "form" in options,
      hasBody: "body" in options,
    }, {
      accountId: this.accountId,
      username: this.username,
    });

    try {
      const http = await this.getHttpClient();
      const response = await http(url, {
        ...options,
        throwHttpErrors: false,
      });

      this.log("HTTP request completed", {
        method,
        url,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      }, {
        accountId: this.accountId,
        username: this.username,
      });

      if (response.statusCode === 429) {
        throw new RateLimitError("One2Track rate limited the request");
      }

      if ([401, 403].includes(response.statusCode)) {
        throw new AuthenticationError(`One2Track returned ${response.statusCode}`);
      }

      return response;
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof ParseError ||
        error instanceof RateLimitError ||
        error instanceof TransportError
      ) {
        this.logError("HTTP request failed with typed error", error, {
          accountId: this.accountId,
          username: this.username,
          method,
          url,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }

      if (
        error instanceof Error &&
        new RegExp(`${ALTERNATIVE_SESSION_COOKIE}|_iadmin`, "i").test(error.message)
      ) {
        this.authenticated = false;
      }

      this.logError("HTTP request failed", error, {
        accountId: this.accountId,
        username: this.username,
        method,
        url,
        durationMs: Date.now() - startedAt,
      });
      throw new TransportError("Could not reach One2Track", { cause: error as Error });
    }
  }

  private async getHttpClient(): Promise<any> {
    if (!this.httpPromise) {
      this.httpPromise = createHttpClientAsync(this.cookieJar);
    }

    return this.httpPromise;
  }

  private createContext(deviceUuid?: string): DebugContext {
    return {
      accountId: this.accountId,
      username: this.username,
      trackerUuid: deviceUuid,
    };
  }

  private log(message: string, data?: unknown, context?: DebugContext): void {
    this.logger?.("one2track-client", message, data, context);
  }

  private logError(message: string, data?: unknown, context?: DebugContext): void {
    (this.errorLogger ?? this.logger)?.("one2track-client", message, data, context);
  }
}
