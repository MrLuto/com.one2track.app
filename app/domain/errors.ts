export class One2TrackError extends Error {
  constructor(message: string, public readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthenticationError extends One2TrackError {
  constructor(message = "Authentication failed", options?: ErrorOptions) {
    super(message, "authentication_error", options);
  }
}

export class TransportError extends One2TrackError {
  constructor(message = "Transport error", options?: ErrorOptions) {
    super(message, "transport_error", options);
  }
}

export class ParseError extends One2TrackError {
  constructor(message = "Unexpected upstream response", options?: ErrorOptions) {
    super(message, "parse_error", options);
  }
}

export class RateLimitError extends One2TrackError {
  constructor(message = "Rate limit exceeded", options?: ErrorOptions) {
    super(message, "rate_limit_error", options);
  }
}

