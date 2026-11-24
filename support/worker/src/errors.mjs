export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class NeedsReview extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
