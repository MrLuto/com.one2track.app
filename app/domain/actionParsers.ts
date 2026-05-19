import { ParseError } from "./errors";
import type { PhonebookContact, QuietTimeWindow } from "./types";

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new ParseError(`Invalid ${label} JSON`, { cause: error as Error });
  }
}

export function parseCsvStrings(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAlarmsInput(value: string): string[] {
  const alarms = parseCsvStrings(value);
  if (!alarms.every((alarm) => /^\d{2}:\d{2}-/.test(alarm))) {
    throw new ParseError("Alarms must use the HH:MM-... format");
  }
  return alarms;
}

export function parsePhonebookInput(value: string): PhonebookContact[] {
  const contacts = parseJson<PhonebookContact[]>(value, "phonebook");
  if (!Array.isArray(contacts)) {
    throw new ParseError("Phonebook payload must be a JSON array");
  }

  return contacts.map((contact) => {
    if (!contact || typeof contact.name !== "string" || typeof contact.number !== "string") {
      throw new ParseError("Each phonebook contact must contain string 'name' and 'number' fields");
    }
    return {
      name: contact.name.trim(),
      number: contact.number.trim(),
    };
  });
}

export function parseQuietTimesInput(value: string): QuietTimeWindow[] {
  const windows = parseJson<QuietTimeWindow[]>(value, "quiet times");
  if (!Array.isArray(windows)) {
    throw new ParseError("Quiet times payload must be a JSON array");
  }

  return windows.map((window) => {
    if (!window || typeof window.start !== "string" || typeof window.end !== "string") {
      throw new ParseError("Each quiet time must contain string 'start' and 'end' fields");
    }
    if (!/^\d{2}:\d{2}$/.test(window.start) || !/^\d{2}:\d{2}$/.test(window.end)) {
      throw new ParseError("Quiet times must use HH:MM strings");
    }
    return {
      start: window.start,
      end: window.end,
    };
  });
}
