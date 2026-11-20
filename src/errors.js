export class AppError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class DataValidationError extends AppError {
  constructor(message) {
    super('INVALID_EPISODE', message, 400);
  }
}

export class InsufficientDataError extends AppError {
  constructor(message) {
    super('INSUFFICIENT_DATA', message, 422);
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super('NOT_FOUND', message, 404);
  }
}
