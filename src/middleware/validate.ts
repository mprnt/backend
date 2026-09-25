import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

type ValidationSource = 'body' | 'query' | 'params';

export const validate = (schema: Joi.ObjectSchema, source: ValidationSource = 'body') => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errorMessage = error.details.map((detail) => detail.message).join(', ');
      return next(new AppError(`Validation error: ${errorMessage}`, 400));
    }

    req[source] = value;
    next();
  };
};
